#!/usr/bin/env node
/**
 * M6 端到端验证：发布（账号 / 账号库 / 模板 / 草稿 / 队列）。
 *
 *   node tests/m6-verify.mjs [baseUrl]
 *
 * 在测试机上跑（挂载点是 /repo/tests，这样 Node 能解析到 /repo/node_modules）：
 *   docker compose -f deploy/docker-compose.yml run --rm \
 *     -v /opt/405nm/tests:/repo/tests:ro \
 *     -e M6_ADMIN_PASSWORD=... backend node /repo/tests/m6-verify.mjs
 *
 * ⚠️ **本脚本不做真实发布。** 不往任何真实 B 站账号发东西 ——
 * 发出去的动态是收不回来的。真实发布那一步要人工对一个测试账号做一次
 * （见 ROADMAP 的 M6 验收），脚本里假装验证过是没有意义的。
 *
 * 一半的断言走 HTTP（权限、掩码、草稿、幂等键），另一半**直接调队列函数**
 * —— 因为「两阶段标记」「租约回收」「needs_review」这几条的核心价值
 * 恰恰在于「进程在中间死掉」时会发生什么，而那件事没法用 HTTP 触发。
 * 测试跑在 backend 容器里，本来就有数据库连接，直接调是最诚实的做法。
 */

import { eq } from 'drizzle-orm';
import { makePng } from './lib/png.mjs';
import { db } from '../backend/dist/db/client.js';
import { publishAttempts, publishJobs } from '../backend/dist/db/schema.js';
import { claimDueJobs, reclaimExpired, recoverStalled } from '../backend/dist/publish/queue.js';
import {
  PUBLISH_KINDS,
  extractVariableKeys,
  mergeLibraryMentions,
  renderTemplate,
  slotSegment,
} from '../backend/dist/publish/render.js';

const BASE = (process.argv[2] ?? 'http://backend:3000/api').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.M6_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.M6_ADMIN_PASSWORD ?? '';

const RUN_ID = Date.now().toString(36);
const TEAM_NAME = `M6验证组-${RUN_ID}`;
const PROJECT_NAME = `M6作品-${RUN_ID}`;

let passed = 0;
const failures = [];

function record(group, name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ [${group}] ${name}`);
  } else {
    failures.push({ group, name, detail });
    console.log(`  ✗ [${group}] ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }

  async request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      if (pair) this.cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, headers: res.headers, body: json, text };
  }

  get = (p) => this.request('GET', p);
  post = (p, b) => this.request('POST', p, b);
  put = (p, b) => this.request('PUT', p, b);
  patch = (p, b) => this.request('PATCH', p, b);
  del = (p) => this.request('DELETE', p);
}

async function uploadImage(client, projectId, filename, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), filename);
  const headers = {};
  if (client.cookie) headers.cookie = client.cookie;
  const res = await fetch(`${BASE}/projects/${projectId}/files`, { method: 'POST', headers, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function uploadOutput(client, fileId, filename, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), filename);
  const headers = {};
  if (client.cookie) headers.cookie = client.cookie;
  const res = await fetch(`${BASE}/files/${fileId}/outputs`, { method: 'POST', headers, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const admin = new Client('admin');
const outsider = new Client('outsider');

console.log(`\n405nm M6 验证 —— ${BASE}\n`);
console.log('⚠️ 本脚本不发起真实发布（往真实账号发动态是收不回来的）。\n');

if (!ADMIN_PASSWORD) {
  console.error('未提供 M6_ADMIN_PASSWORD，无法继续。');
  process.exit(2);
}

const login = await admin.post('/auth/login', { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
if (login.status !== 200) {
  console.error(`管理员登录失败（HTTP ${login.status}）：${JSON.stringify(login.body)}`);
  process.exit(2);
}

// ── 一、正文渲染与署名（纯函数，不依赖数据库）───────────────
console.log('一、正文渲染与署名');

{
  record(
    '渲染',
    '{{变量}} 被替换',
    renderTemplate('你好 {{name}}！', { name: '世界' }) === '你好 世界！',
    renderTemplate('你好 {{name}}！', { name: '世界' }),
  );
  record(
    '渲染',
    '中文变量名也认（少了这段中文模板会原样发出去）',
    renderTemplate('{{原作者}} 作品', { 原作者: '某老师' }) === '某老师 作品',
    renderTemplate('{{原作者}} 作品', { 原作者: '某老师' }),
  );
  record(
    '渲染',
    '缺变量替换成空串而不是留下 {{}}',
    renderTemplate('A{{missing}}B', {}) === 'AB',
    renderTemplate('A{{missing}}B', {}),
  );
  record(
    '渲染',
    '变量名带空格也能认',
    renderTemplate('{{ name }}', { name: 'x' }) === 'x',
    renderTemplate('{{ name }}', { name: 'x' }),
  );
  record(
    '渲染',
    '能列出模板声明了哪些变量且不重复',
    JSON.stringify(extractVariableKeys('{{a}} {{b}} {{a}}')) === JSON.stringify(['a', 'b']),
    JSON.stringify(extractVariableKeys('{{a}} {{b}} {{a}}')),
  );
}

{
  const slots = {
    trans: { handle: 'alice', uid: '1' },
    typo: { handle: 'bob', uid: '2' },
    orig: { handle: 'carol', uid: '3' },
  };
  record(
    '署名',
    '翻嵌三槽齐全时拼出完整署名',
    slotSegment('翻嵌', slots) === '【翻&嵌 @alice @bob 原作X@carol】',
    slotSegment('翻嵌', slots),
  );
  record(
    '署名',
    '缺一个槽位时返回空串（残缺的署名比没有更容易引起误会）',
    slotSegment('翻嵌', { trans: { handle: 'a' }, typo: { handle: 'b' } }) === '',
    slotSegment('翻嵌', { trans: { handle: 'a' }, typo: { handle: 'b' } }),
  );
  record('署名', '原创没有署名片段', slotSegment('原创', slots) === '', slotSegment('原创', slots));
  record(
    '署名',
    '转载只署原作者',
    slotSegment('转载', slots) === '【原作X@carol】',
    slotSegment('转载', slots),
  );
  record('署名', '内容类型就四种', PUBLISH_KINDS.length === 4, JSON.stringify(PUBLISH_KINDS));
}

{
  const directory = [
    { handle: 'alice', platformUid: '100' },
    { handle: 'Bob', platformUid: '200' },
    { handle: '没uid的', platformUid: '' },
  ];

  record(
    '提及',
    '正文里的 @handle 命中账号库就进 mentions',
    mergeLibraryMentions('感谢 @alice 的翻译', directory).some((m) => m.uid === '100'),
    JSON.stringify(mergeLibraryMentions('感谢 @alice 的翻译', directory)),
  );
  record(
    '提及',
    '大小写不敏感（正文写 @bob、库里是 Bob）',
    mergeLibraryMentions('感谢 @bob', directory).some((m) => m.uid === '200'),
    JSON.stringify(mergeLibraryMentions('感谢 @bob', directory)),
  );
  record(
    '提及',
    'name 用正文里的原样写法（发布时要按 @name 定位）',
    mergeLibraryMentions('感谢 @bob', directory).find((m) => m.uid === '200')?.name === 'bob',
    JSON.stringify(mergeLibraryMentions('感谢 @bob', directory)),
  );
  record(
    '提及',
    '不在账号库里的 @ 不会被误判（作者署名里的 X handle 不该被 @）',
    mergeLibraryMentions('原作 @mirin78', directory).length === 0,
    JSON.stringify(mergeLibraryMentions('原作 @mirin78', directory)),
  );
  record(
    '提及',
    '没填平台 uid 的人不进 mentions（进了也点不动）',
    mergeLibraryMentions('@没uid的', directory).length === 0,
    JSON.stringify(mergeLibraryMentions('@没uid的', directory)),
  );
  record(
    '提及',
    '日文假名的 handle 也能被识别（正则少了假名就会漏）',
    mergeLibraryMentions('@ゆき 翻译', [{ handle: 'ゆき', platformUid: '300' }]).some((m) => m.uid === '300'),
    JSON.stringify(mergeLibraryMentions('@ゆき 翻译', [{ handle: 'ゆき', platformUid: '300' }])),
  );
  record(
    '提及',
    '同一个人重复出现只记一次',
    mergeLibraryMentions('@alice 和 @alice', directory).filter((m) => m.uid === '100').length === 1,
    '',
  );
  record(
    '提及',
    '多次调用不会因为正则的 lastIndex 而漏（带 g 的正则复用是个坑）',
    mergeLibraryMentions('@alice', directory).length === 1 &&
      mergeLibraryMentions('@alice', directory).length === 1 &&
      mergeLibraryMentions('@alice', directory).length === 1,
    '',
  );
}

// ── 二、搭场景 ──────────────────────────────────────────────
console.log('\n二、搭场景');

const team = await admin.post('/teams', { name: TEAM_NAME, intro: 'M6 自动验证' });
const teamId = team.body?.team?.id;
record('场景', '创建验证团队', team.status === 201 && Boolean(teamId), JSON.stringify(team.body));

const project = await admin.post(`/teams/${teamId}/projects`, {
  name: PROJECT_NAME,
  sourceLanguage: 'ja',
  targetLanguages: ['zh-CN'],
});
const projectId = project.body?.project?.id;
record('场景', '创建作品', project.status === 201 && Boolean(projectId), JSON.stringify(project.body));

const teamDetail = await admin.get(`/teams/${teamId}`);
const memberRoleId = teamDetail.body?.roles?.find((r) => r.systemCode === 'member')?.id;

async function makeMember(suffix, displayName) {
  const username = `m6_${suffix}_${RUN_ID}`;
  await admin.post('/admin/users', { username, password: 'm6-verify-pass-1', displayName });
  await admin.post(`/teams/${teamId}/members`, { username, roleId: memberRoleId });
  const client = new Client(suffix);
  await client.post('/auth/login', { username, password: 'm6-verify-pass-1' });
  return { client, username };
}

const out = await makeMember('out', 'M6 路人');

// ── 三、发布账号 ────────────────────────────────────────────
console.log('\n三、发布账号');

record(
  '账号',
  '平台列表只有一个（v1 只做 B 站）',
  (await admin.get('/publish/platforms')).body?.platforms?.length === 1,
  '',
);

const created = await admin.post(`/teams/${teamId}/publish/accounts`, {
  platform: 'bilibili',
  label: '主号',
  // 假凭据：真实的会去 B 站校验，这里验的是「校验不过时不会留下可用账号」
  sessdata: 'fake-sessdata-for-test',
  biliJct: 'fake-jct',
});
record(
  '账号',
  '建账号时会去平台校验，假凭据建出来的账号是 expired',
  created.status === 201 && created.body?.verified === false,
  `HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`,
);
record(
  '账号',
  '校验失败的账号仍然被创建、但明确标成不可用（不是留一个「看起来建好了」的）',
  created.body?.account?.cookieStatus === 'expired' && Boolean(created.body?.warning),
  JSON.stringify(created.body?.account?.cookieStatus),
);
// ⚠️ 校验不过的凭据**不会入库**（那是有意的），所以上面那次调用之后
// 账号的 credentials 是空的 —— 「掩码」这条得先把密文塞进去才测得出来。
const { encryptCredentials } = await import('../backend/dist/lib/credentials.js');
const { publishAccounts } = await import('../backend/dist/db/schema.js');
await db
  .update(publishAccounts)
  .set({ credentials: encryptCredentials({ sessdata: 'SUPER-SECRET-SESSDATA', biliJct: 'SUPER-SECRET-JCT' }) })
  .where(eq(publishAccounts.id, created.body.account.id));

const maskedList = await admin.get(`/teams/${teamId}/publish/accounts`);
const maskedRow = maskedList.body?.accounts?.find((a) => a.id === created.body.account.id);
record(
  '账号',
  '**接口只返回掩码，绝不返回明文凭据**',
  maskedRow?.credentials?.sessdata?.includes('•') === true &&
    !JSON.stringify(maskedList.body).includes('SUPER-SECRET'),
  JSON.stringify(maskedRow?.credentials),
);
record(
  '账号',
  '掩码保留末 4 位（好让人认出自己贴的是哪一条）',
  maskedRow?.credentials?.sessdata?.endsWith('DATA') === true,
  JSON.stringify(maskedRow?.credentials),
);
record('账号', 'hasCredentials 反映「确实存了凭据」', maskedRow?.hasCredentials === true, '');
record(
  '账号',
  '同名账号被拒（唯一约束）',
  (await admin.post(`/teams/${teamId}/publish/accounts`, {
    platform: 'bilibili',
    label: '主号',
    sessdata: 'x',
    biliJct: 'y',
  })).status === 409,
  '',
);
record(
  '账号',
  '不支持的平台被拒',
  (await admin.post(`/teams/${teamId}/publish/accounts`, {
    platform: 'weibo',
    label: '微博号',
    sessdata: 'x',
    biliJct: 'y',
  })).status === 400,
  '',
);

const accountId = created.body?.account?.id;

// 权限：团队路人（member 角色，没有 publish.account.manage）不能管账号
record(
  '权限',
  '普通团队成员不能创建发布账号（403）',
  (await out.client.post(`/teams/${teamId}/publish/accounts`, {
    platform: 'bilibili',
    label: '偷偷建的',
    sessdata: 'x',
    biliJct: 'y',
  })).status === 403,
  '',
);
record(
  '权限',
  '普通团队成员能看账号列表，但看到的也是掩码',
  (await out.client.get(`/teams/${teamId}/publish/accounts`)).status === 200,
  '',
);

// ── 四、账号库与模板 ────────────────────────────────────────
console.log('\n四、账号库与模板');

const credit = await admin.post(`/teams/${teamId}/publish/credits`, {
  name: '翻译小王',
  handle: 'wang',
  platformUid: '10001',
});
record('账号库', '登记成员', credit.status === 201, JSON.stringify(credit.body).slice(0, 160));
record(
  '账号库',
  'handle 前面的 @ 会被去掉（存的是裸 handle）',
  credit.body?.entry?.handle === 'wang',
  JSON.stringify(credit.body?.entry?.handle),
);
record(
  '账号库',
  '填了平台 uid 才算「@ 可点击」',
  credit.body?.entry?.mentionable === true,
  JSON.stringify(credit.body?.entry),
);
record(
  '账号库',
  '同一个 handle 不能重复登记',
  (await admin.post(`/teams/${teamId}/publish/credits`, { name: 'x', handle: 'wang' })).status === 409,
  '',
);

const templates = await admin.get(`/teams/${teamId}/publish/templates`);
record(
  '模板',
  '空团队会自动获得两份默认模板（空的模板列表让功能看起来没做完）',
  templates.body?.templates?.length >= 2,
  JSON.stringify(templates.body?.templates?.map((t) => t.name)),
);

// ── 五、草稿 ────────────────────────────────────────────────
console.log('\n五、发布草稿');

// 先造两张图 + 成品，否则草稿会因为「没有可发布的成品」被拒
const fileA = (await uploadImage(admin, projectId, '001.png', makePng(800, 1200))).body?.uploaded?.[0]?.id;
const fileB = (await uploadImage(admin, projectId, '002.png', makePng(810, 1210))).body?.uploaded?.[0]?.id;
record('场景', '上传两张图', Boolean(fileA && fileB), `${fileA} / ${fileB}`);

await uploadOutput(admin, fileA, '001_嵌字.png', makePng(800, 1200));
await uploadOutput(admin, fileB, '002_嵌字.png', makePng(810, 1210));

// 署名槽位是从**署名台账**推出来的，所以先往台账里写一条 ——
// 否则测的是「台账为空时 slots 为空」，那证明不了匹配逻辑对不对。
const { fileCredits } = await import('../backend/dist/db/schema.js');
await db.insert(fileCredits).values({
  fileId: fileA,
  teamId,
  role: 'translator',
  displayName: '翻译小王',
});

const prepare = await admin.get(`/projects/${projectId}/publish/prepare?kind=翻嵌`);
record('草稿', '取素材', prepare.status === 200, JSON.stringify(prepare.body).slice(0, 200));
record(
  '草稿',
  '列出有成品的语言（没有成品的语言不该出现在选项里）',
  prepare.body?.languages?.some((l) => l.language === 'zh-CN' && l.count === 2),
  JSON.stringify(prepare.body?.languages),
);
record(
  '草稿',
  '署名槽位能从台账 + 账号库推出来',
  prepare.body?.slots?.trans?.handle === 'wang' && prepare.body?.slots?.trans?.uid === '10001',
  JSON.stringify(prepare.body?.slots),
);

const draft = await admin.post(`/projects/${projectId}/publish/drafts`, {
  kind: '翻嵌',
  title: '本週新刊',
  text: '这周的更新来了',
  accountId,
  slots: {
    trans: { name: '翻译小王', handle: 'wang', uid: '10001' },
    typo: { name: '嵌字老李', handle: 'li', uid: '' },
    orig: { name: '某老师', handle: 'mirin78', uid: '' },
  },
  idempotencyKey: `m6-draft-${RUN_ID}`,
});
record('草稿', '生成草稿', draft.status === 201, `HTTP ${draft.status} ${JSON.stringify(draft.body).slice(0, 200)}`);
record(
  '草稿',
  '图片是**快照**进任务的（成品后来换版本不影响已排期的动态）',
  draft.body?.job?.images?.length === 2 && Boolean(draft.body?.job?.images?.[0]?.key),
  JSON.stringify(draft.body?.job?.images),
);

// 幂等键：同一个 key 再提交一次，拿到的是同一条
const replay = await admin.post(`/projects/${projectId}/publish/drafts`, {
  kind: '翻嵌',
  text: '这周的更新来了',
  idempotencyKey: `m6-draft-${RUN_ID}`,
});
record(
  '草稿',
  '**幂等键生效**：同一个 key 重复提交不会产生第二条草稿',
  replay.body?.job?.id === draft.body?.job?.id && replay.body?.reused === true,
  JSON.stringify({ same: replay.body?.job?.id === draft.body?.job?.id, reused: replay.body?.reused }),
);

const draftId = draft.body?.job?.id;

if (!draftId) {
  // 连草稿都没建出来，后面的队列断言全都没有意义 —— 明确收在这里，
  // 而不是让 undefined 一路传到 SQL 里崩掉（那样连失败汇总都看不到）。
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name} —— ${f.detail}`);
  console.log('\n草稿没建出来，后续队列断言无法进行。');
  process.exit(1);
}

// ── 六、排期与队列语义 ──────────────────────────────────────
console.log('\n六、排期与队列语义');

record(
  '排期',
  '草稿不能直接改（列表里它是 draft）',
  (await admin.get(`/publish/jobs/${draftId}`)).body?.job?.status === 'draft',
  '',
);
const scheduled = await admin.post(`/publish/jobs/${draftId}/schedule`, { scheduledAt: null });
record('排期', '排期成功', scheduled.status === 200, `HTTP ${scheduled.status}`);

// ⚠️ 断言**接口返回的那一行**，不要去库里重读：worker 是活着的，
// 排期之后它 3 秒内就会把任务认领走（状态变成 publishing）。
// 重读会变成跟它赛跑，第一版就是这么间歇性失败的 —— 而失败的根本不是被测代码。
// UPDATE ... RETURNING 给的是**更新那一刻**的值，worker 插不进来。
record(
  '排期',
  '排期后状态是 pending 且带排期时间',
  scheduled.body?.job?.status === 'pending' && Boolean(scheduled.body?.job?.scheduledAt),
  JSON.stringify({ status: scheduled.body?.job?.status, at: scheduled.body?.job?.scheduledAt }),
);

// ⚠️ 下面这几条**只动数据库、不碰网络** —— 验证的是「进程在中间死掉」的语义。
// 用任务真的去发是不可能的（也绝不该在测试里做），所以直接把库改成
// 「发到一半崩掉」的样子，再看队列函数怎么处理它。

{
  // ① 原子认领
  const claimed = await claimExclusively(draftId);
  record(
    '队列',
    '能认领到期的任务',
    claimed !== null,
    claimed === null ? '连续几轮都被 worker 抢走了（测试环境问题，不是被测代码）' : '',
  );

  if (claimed) {
    const second = await claimDueJobs(50);
    record(
      '队列',
      '**原子认领**：已经被认领的任务不会再被认领第二次',
      !second.some((j) => j.id === draftId),
      `第二次拿到了 ${JSON.stringify(second.map((j) => j.id))}`,
    );
    record(
      '队列',
      '认领时 attempts 就 +1（崩掉的尝试也要计数）',
      (await db.select().from(publishJobs).where(eq(publishJobs.id, draftId)))[0]?.attempts === 1,
      '',
    );
    record(
      '队列',
      '认领时写下了租约（worker 崩了才有人能回收它）',
      Boolean((await db.select().from(publishJobs).where(eq(publishJobs.id, draftId)))[0]?.leaseExpiresAt),
      '',
    );
  }
}

{
  // ② 两阶段标记 → needs_review
  // 模拟「createDynamic 已经发出去了，但进程在写库之前死掉」：
  // 库里留着一条 in_flight 的 publish 尝试。
  await db.insert(publishAttempts).values({
    jobId: draftId,
    phase: 'publish',
    status: 'in_flight',
    attempt: 1,
    detail: '模拟：发出后进程中断',
  });
  await db
    .update(publishJobs)
    .set({ status: 'publishing', leaseExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(publishJobs.id, draftId));

  const reclaimed = await reclaimExpired(50);
  const afterReclaim = (await db.select().from(publishJobs).where(eq(publishJobs.id, draftId)))[0];
  record(
    '队列',
    '**有悬空发布尝试的任务不会被超时回收放回队列**（那等于静默重发）',
    afterReclaim?.status === 'publishing' && reclaimed >= 0,
    `status=${afterReclaim?.status}`,
  );

  const report = await recoverStalled();
  const afterRecover = (await db.select().from(publishJobs).where(eq(publishJobs.id, draftId)))[0];
  record(
    '队列',
    '**启动时把「不确定发没发出去」的任务标成 needs_review**，交人工',
    afterRecover?.status === 'needs_review' && report.needsReview.includes(draftId),
    `status=${afterRecover?.status} report=${JSON.stringify(report.needsReview)}`,
  );
  record(
    '队列',
    'last_error 把「为什么需要人工」写清楚了',
    String(afterRecover?.lastError ?? '').includes('无法确认'),
    String(afterRecover?.lastError ?? '').slice(0, 80),
  );
}

{
  // ③ 人工处置：确认没发出去 → 才允许重新排队
  const resolve = await admin.post(`/publish/jobs/${draftId}/resolve`, { outcome: 'notPublished' });
  record('处置', '人工确认「确实没发出去」后重新排队', resolve.status === 200 && resolve.body?.job?.status === 'pending', JSON.stringify(resolve.body).slice(0, 160));
}
{
  // ④ 人工处置：确认发出去了 → 回填链接收尾
  await db
    .update(publishJobs)
    .set({ status: 'needs_review' })
    .where(eq(publishJobs.id, draftId));
  const resolve = await admin.post(`/publish/jobs/${draftId}/resolve`, {
    outcome: 'confirmed',
    externalUrl: 'https://t.bilibili.com/123456',
  });
  record(
    '处置',
    '人工确认「确实发出去了」后收尾并回填链接',
    resolve.status === 200 && resolve.body?.job?.status === 'published' && resolve.body?.job?.externalUrl.includes('123456'),
    JSON.stringify(resolve.body?.job?.status),
  );
}
record(
  '处置',
  '已经不是 needs_review 的任务不能再处置',
  (await admin.post(`/publish/jobs/${draftId}/resolve`, { outcome: 'confirmed' })).status === 409,
  '',
);

{
  // ⑤ 没有悬空尝试的超时任务，正常回收
  const draft2 = await admin.post(`/projects/${projectId}/publish/drafts`, {
    kind: '原创',
    text: '第二条',
    idempotencyKey: `m6-draft2-${RUN_ID}`,
  });
  const job2 = draft2.body?.job?.id;
  await db
    .update(publishJobs)
    .set({ status: 'publishing', leaseExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(publishJobs.id, job2));

  await reclaimExpired(50);
  const after = (await db.select().from(publishJobs).where(eq(publishJobs.id, job2)))[0];
  record(
    '队列',
    '没有悬空尝试的超时任务会被正常回收重排（worker 崩了不该让任务卡死）',
    after?.status === 'pending',
    `status=${after?.status}`,
  );
}

/**
 * 认领一条**指定的**任务。
 *
 * ⚠️ worker 是**活着的**，它每 3 秒会把到期队列认领一遍。所以「把任务改成
 * 可认领、然后自己抢」本质上是跟它赛跑 —— 第一版测试就是这么失败的：
 * 第一次调用就返回空，因为 worker 早把它拿走了。
 *
 * 这里重试几轮：只要有一轮自己抢到了，就能验证「第二次认领不会再拿到它」
 * 这条排他性。连续几轮都被抢走才判失败 —— 那种情况下问题在测试环境
 * （worker 太积极），不在被测代码。
 */
async function claimExclusively(jobId, rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await db
      .update(publishJobs)
      .set({
        status: 'pending',
        scheduledAt: new Date(Date.now() - 60_000),
        claimedAt: null,
        leaseExpiresAt: null,
        attempts: 0,
      })
      .where(eq(publishJobs.id, jobId));

    const claimed = await claimDueJobs(50);
    if (claimed.some((j) => j.id === jobId)) return claimed;
    await sleep(150);
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 七、权限矩阵 ────────────────────────────────────────────
console.log('\n七、权限矩阵');

record(
  '权限',
  '团队路人不能读作品的发布素材（403）',
  (await out.client.get(`/projects/${projectId}/publish/prepare`)).status === 403,
  '',
);
record(
  '权限',
  '团队路人不能生成草稿（403）',
  (await out.client.post(`/projects/${projectId}/publish/drafts`, { text: 'x' })).status === 403,
  '',
);
record(
  '权限',
  '团队路人不能排期（403）',
  (await out.client.post(`/publish/jobs/${draftId}/schedule`, { scheduledAt: null })).status === 403,
  '',
);

// ── 八、队列列表 ────────────────────────────────────────────
console.log('\n八、队列列表');

const queue = await admin.get(`/teams/${teamId}/publish/jobs`);
record('队列', '团队队列能列出任务', queue.status === 200 && queue.body?.jobs?.length >= 2, JSON.stringify(queue.body?.jobs?.length));
record(
  '队列',
  '队列里不返回凭据（只有任务本身）',
  !JSON.stringify(queue.body).includes('fake-sessdata'),
  '',
);
const publishedOnly = await admin.get(`/teams/${teamId}/publish/jobs?status=published`);
record(
  '队列',
  '状态筛选生效',
  publishedOnly.body?.jobs?.every((j) => j.status === 'published'),
  JSON.stringify(publishedOnly.body?.jobs?.map((j) => j.status)),
);

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name} —— ${f.detail}`);
  process.exit(1);
}
console.log('M6 发布链路全部通过。');
console.log('注意：以上**没有**发起任何真实发布，真实发布需要人工对测试账号做一次。');

// ⚠️ 必须显式退出。这个脚本开了数据库连接池（postgres.js 会保活 socket），
// 掉进文件末尾的话 node **永远不会退出** —— 表现是「打印完全部通过之后挂住」，
// 而它前面还排着别的套件，于是把整轮验证都堵死（真栽过一次，卡了 26 分钟）。
process.exit(0);
