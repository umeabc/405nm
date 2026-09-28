#!/usr/bin/env node
/**
 * M3 端到端验证：标号 / 译文与校对 / 状态机 / 署名台账 / 下游通知 / 图片跨作品移动。
 *
 *   node tests/m3-verify.mjs [baseUrl]
 *
 * 在测试机上跑（挂载点是 /repo/tests，这样 Node 能解析到 /repo/node_modules）：
 *   docker compose -f deploy/docker-compose.yml run --rm \
 *     -v /opt/405nm/tests:/repo/tests:ro \
 *     -e M3_ADMIN_PASSWORD=... backend node /repo/tests/m3-verify.mjs
 *
 * 与 m1/m2 同一套骨架。角色分配走「管理员建号 + 拉进团队 + 加进作品」，
 * 不走注册（注册有单 IP 每小时 3 次的限流，会让脚本没法反复跑）。
 */

import { makePng } from './lib/png.mjs';

const BASE = (process.argv[2] ?? 'http://backend:3000/api').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.M3_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.M3_ADMIN_PASSWORD ?? '';

const RUN_ID = Date.now().toString(36);
const TEAM_NAME = `M3验证组-${RUN_ID}`;
const PROJECT_A = `M3作品A-${RUN_ID}`;
const PROJECT_B = `M3作品B-${RUN_ID}`;
const PROJECT_C = `M3作品C-${RUN_ID}`;

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
    return { status: res.status, headers: res.headers, body: json };
  }

  get = (p) => this.request('GET', p);
  post = (p, b) => this.request('POST', p, b);
  put = (p, b) => this.request('PUT', p, b);
  patch = (p, b) => this.request('PATCH', p, b);
  del = (p) => this.request('DELETE', p);
}


async function uploadImage(client, projectId, filename, buffer = makePng(800, 1200)) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), filename);
  const headers = {};
  if (client.cookie) headers.cookie = client.cookie;
  const res = await fetch(`${BASE}/projects/${projectId}/files`, { method: 'POST', headers, body: form });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const admin = new Client('admin');
const translator = new Client('translator');
const proofreader = new Client('proofreader');
const outsider = new Client('outsider');

console.log(`\n405nm M3 验证 —— ${BASE}\n`);

if (!ADMIN_PASSWORD) {
  console.error('未提供 M3_ADMIN_PASSWORD，无法继续。');
  process.exit(2);
}

const login = await admin.post('/auth/login', { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
if (login.status !== 200) {
  console.error(`管理员登录失败（HTTP ${login.status}）：${JSON.stringify(login.body)}`);
  process.exit(2);
}

// ── 一、搭场景 ──────────────────────────────────────────────
console.log('一、搭场景（团队 / 作品 / 三人三角色）');

const team = await admin.post('/teams', { name: TEAM_NAME, intro: 'M3 自动验证' });
const teamId = team.body?.team?.id;
record('场景', '创建验证团队', team.status === 201 && Boolean(teamId), JSON.stringify(team.body));

const projectA = await admin.post(`/teams/${teamId}/projects`, {
  name: PROJECT_A,
  author: 'M3 作者',
  sourceLanguage: 'ja',
  targetLanguages: ['zh-CN'],
});
const projectAId = projectA.body?.project?.id;

const projectB = await admin.post(`/teams/${teamId}/projects`, {
  name: PROJECT_B,
  sourceLanguage: 'ja',
  // 刻意**不给**目标语言：用来验证「移动时自动补语言、不丢译文」
  targetLanguages: ['en'],
});
const projectBId = projectB.body?.project?.id;

const projectC = await admin.post(`/teams/${teamId}/projects`, {
  name: PROJECT_C,
  sourceLanguage: 'ja',
  targetLanguages: ['zh-CN'],
});
const projectCId = projectC.body?.project?.id;
record('场景', '创建三个作品（A 有 zh-CN，B 只有 en，C 有 zh-CN）', Boolean(projectAId && projectBId && projectCId));

const teamDetail = await admin.get(`/teams/${teamId}`);
const memberRoleId = teamDetail.body?.roles?.find((r) => r.systemCode === 'member')?.id;

async function makeMember(suffix, displayName) {
  const username = `m3_${suffix}_${RUN_ID}`;
  const created = await admin.post('/admin/users', {
    username,
    password: 'm3-verify-pass-1',
    displayName,
  });
  await admin.post(`/teams/${teamId}/members`, { username, roleId: memberRoleId });
  const client = new Client(suffix);
  await client.post('/auth/login', { username, password: 'm3-verify-pass-1' });
  return { client, userId: created.body?.user?.id, username };
}

const t = await makeMember('tr', 'M3 译者');
const p = await makeMember('pr', 'M3 校对');
// 「团队里的路人」与「压根不在团队里的人」是两种不同的越权场景，都要覆盖：
// 前者应当能**看**作品但不能改，后者连作品存在都不该知道。
const o = await makeMember('out', 'M3 团队路人');

const strangerName = `m3_x_${RUN_ID}`;
await admin.post('/admin/users', { username: strangerName, password: 'm3-verify-pass-1', displayName: 'M3 外部人' });
const stranger = new Client('stranger');
await stranger.post('/auth/login', { username: strangerName, password: 'm3-verify-pass-1' });

const projectDetailA = await admin.get(`/projects/${projectAId}`);
const rolesA = projectDetailA.body?.roles ?? [];
const translatorRoleId = rolesA.find((r) => r.systemCode === 'translator')?.id;
const proofreaderRoleId = rolesA.find((r) => r.systemCode === 'proofreader')?.id;

await admin.post(`/projects/${projectAId}/members`, { userId: t.userId, projectRoleId: translatorRoleId });
await admin.post(`/projects/${projectAId}/members`, { userId: p.userId, projectRoleId: proofreaderRoleId });

record('场景', '把译者和校对加进作品 A', Boolean(translatorRoleId && proofreaderRoleId));

{
  const detail = await t.client.get(`/projects/${projectAId}`);
  record(
    '权限',
    '译者拿到 tra.add / label.add，没有 tra.check',
    detail.body?.my?.permissions?.includes('tra.add') &&
      detail.body?.my?.permissions?.includes('label.add') &&
      !detail.body?.my?.permissions?.includes('tra.check'),
    JSON.stringify(detail.body?.my?.permissions),
  );

  const prDetail = await p.client.get(`/projects/${projectAId}`);
  record(
    '权限',
    '校对拿到 tra.proofread 与打回权 tra.check',
    prDetail.body?.my?.permissions?.includes('tra.proofread') &&
      prDetail.body?.my?.permissions?.includes('tra.check'),
    JSON.stringify(prDetail.body?.my?.permissions),
  );
}

// ── 二、标号 ────────────────────────────────────────────────
console.log('\n二、标号');

const upload = await uploadImage(admin, projectAId, 'p1.png');
const fileA = upload.body?.uploaded?.[0]?.id;
record('标号', '上传一张图', upload.status === 201 && Boolean(fileA), JSON.stringify(upload.body));

{
  // 标号是**点**，不是框：只传 x/y，没有 w/h。positionType 不传时默认「框内」。
  const created = await t.client.post(`/files/${fileA}/sources`, {
    x: 0.1,
    y: 0.2,
    content: 'こんにちは',
  });
  record('标号', '译者可以新增标号', created.status === 201, JSON.stringify(created.body));
  record(
    '标号',
    '不传 positionType 时默认「框内」',
    created.body?.source?.positionType === 'in',
    JSON.stringify(created.body?.source?.positionType),
  );
  record(
    '标号',
    '新建的标号没有面积（w/h 为 0）—— 它是点不是框',
    created.body?.source?.w === 0 && created.body?.source?.h === 0,
    JSON.stringify({ w: created.body?.source?.w, h: created.body?.source?.h }),
  );

  const asOut = await t.client.post(`/files/${fileA}/sources`, {
    positionType: 'out',
    x: 0.5,
    y: 0.5,
    content: '框外的一句',
  });
  record(
    '标号',
    '可以建「框外」标号',
    asOut.status === 201 && asOut.body?.source?.positionType === 'out',
    JSON.stringify(asOut.body?.source?.positionType),
  );

  const bogus = await t.client.post(`/files/${fileA}/sources`, {
    positionType: 'inside',
    x: 0.5,
    y: 0.5,
  });
  record('标号', '非法的 positionType 被拒（400）', bogus.status === 400, `HTTP ${bogus.status}`);

  // 清理掉「框外」那个测试标号，后面的计数断言才成立。
  // 顺带把权限分工也断言掉：译者有 label.add 但没有 label.delete，
  // 所以清理必须由管理员来做。
  const translatorDelete = await t.client.del(`/files/${fileA}/sources/${asOut.body.source.id}`);
  record(
    '权限',
    '译者没有 label.delete，删不掉标号（403）',
    translatorDelete.status === 403,
    `HTTP ${translatorDelete.status}`,
  );

  const adminDelete = await admin.del(`/files/${fileA}/sources/${asOut.body.source.id}`);
  record('标号', '有 label.delete 权限的人可以删掉标号', adminDelete.status === 200, `HTTP ${adminDelete.status}`);

  const clamped = await t.client.post(`/files/${fileA}/sources`, {
    // 故意越界：服务端应当夹紧而不是原样存下
    x: 1.7,
    y: -0.4,
    content: '越界测试',
  });
  record(
    '标号',
    '越界坐标被夹紧到 0–1',
    clamped.body?.source?.x === 1 && clamped.body?.source?.y === 0,
    JSON.stringify({ x: clamped.body?.source?.x, y: clamped.body?.source?.y }),
  );
}

{
  const list = await t.client.get(`/files/${fileA}/sources`);
  record('标号', '列出标号并按 orderIndex 排序', list.body?.sources?.length === 2, JSON.stringify(list.body?.sources?.length));

  const state = await admin.get(`/files/${fileA}`);
  record(
    '状态',
    '新增标号后自动进入「翻译中」（事实自动前进）',
    state.body?.file?.state === 'translating',
    String(state.body?.file?.state),
  );
}

{
  // 批量保存：改一个、加一个，并保持增量语义（不删没出现的）
  const before = await t.client.get(`/files/${fileA}/sources`);
  const first = before.body.sources[0];

  const saved = await t.client.put(`/files/${fileA}/sources`, {
    sources: [
      { id: first.id, positionType: 'in', x: 0.15, y: 0.25, content: 'こんにちは！' },
      { positionType: 'out', x: 0.6, y: 0.7, content: '新人' },
    ],
  });
  record(
    '标号',
    '批量保存后返回回读结果（3 条）',
    saved.body?.sources?.length === 3,
    String(saved.body?.sources?.length),
  );

  const updated = saved.body.sources.find((s) => s.id === first.id);
  record('标号', '已有标号被更新（原文与坐标都变了）', updated?.content === 'こんにちは！' && updated?.x === 0.15, JSON.stringify(updated));
  record(
    '标号',
    '新标号被创建、并获得服务端 id 与「框外」分类',
    saved.body.sources.some((s) => s.positionType === 'out' && s.id),
    '',
  );

  // 全量替换：没出现的会被删掉
  const replaced = await t.client.put(`/files/${fileA}/sources`, {
    sources: saved.body.sources.filter((s) => s.positionType === 'in'),
    replace: true,
  });
  record(
    '标号',
    'replace=true 时删掉没出现的标号',
    replaced.body?.sources?.length === 2 && replaced.body?.removed?.length === 1,
    JSON.stringify({ left: replaced.body?.sources?.length, removed: replaced.body?.removed?.length }),
  );
}

{
  const canRead = await o.client.get(`/files/${fileA}/sources`);
  record('权限', '团队成员（未进作品）可以读标号', canRead.status === 200, `HTTP ${canRead.status}`);

  const deniedWrite = await o.client.post(`/files/${fileA}/sources`, {
    x: 0.1, y: 0.1, content: 'x',
  });
  record('权限', '团队成员（未进作品）写标号被拒（403）', deniedWrite.status === 403, `HTTP ${deniedWrite.status}`);

  const outsiderRead = await stranger.get(`/files/${fileA}/sources`);
  record('隔离', '不在团队里的人读标号返回 404', outsiderRead.status === 404, `HTTP ${outsiderRead.status}`);

  const outsiderProject = await stranger.get(`/projects/${projectAId}`);
  record('隔离', '不在团队里的人读作品返回 404', outsiderProject.status === 404, `HTTP ${outsiderProject.status}`);
}

// ── 三、译文（多候选 + 自动选中）────────────────────────────
console.log('\n三、译文与核对');

let sources = [];
let targetId = null;

{
  const load = await t.client.get(`/files/${fileA}/translations`);
  sources = load.body?.sources ?? [];
  targetId = load.body?.targetId;
  record('译文', '工作台主数据一次取全（标号 + 目标语言）', sources.length === 2 && Boolean(targetId), `标号 ${sources.length}`);
  record('译文', '返回我的翻校权限标志', load.body?.my?.canTranslate === true && load.body?.my?.canProofread === false, JSON.stringify(load.body?.my));

  const saved = await t.client.put(`/files/${fileA}/translations`, {
    targetId,
    items: [
      { sourceId: sources[0].id, content: '你好' },
      { sourceId: sources[1].id, content: '新人' },
    ],
  });
  record('译文', '译者保存两份译文', saved.status === 200, JSON.stringify(saved.body).slice(0, 200));

  const after = await t.client.get(`/files/${fileA}/translations`);
  const first = after.body.sources[0];
  record(
    '译文',
    '首份译文被自动选中（单人场景无需理解「候选」）',
    first.selected?.content === '你好' && first.mine?.content === '你好',
    JSON.stringify({ selected: first.selected?.content, mine: first.mine?.content }),
  );
  record(
    '译文',
    '完整度：zh-CN 2/2 已翻译、0/2 已校对',
    after.body.completeness?.targets?.[0]?.translated === 2 && after.body.completeness?.targets?.[0]?.proofread === 0,
    JSON.stringify(after.body.completeness),
  );
}

{
  // 校对也存一份候选 —— 多人候选结构必须成立，且互不覆盖
  const prSave = await p.client.put(`/files/${fileA}/translations`, {
    targetId,
    items: [{ sourceId: sources[0].id, content: '你好呀' }],
  });
  record('译文', '第二个人可以存自己的候选（不覆盖前一份）', prSave.status === 200, `HTTP ${prSave.status}`);

  const after = await p.client.get(`/files/${fileA}/translations`);
  const first = after.body.sources[0];
  record(
    '译文',
    '同一标号下有两份候选，选中仍是第一份',
    first.translations?.length === 2 && first.selected?.content === '你好',
    JSON.stringify(first.translations?.map((x) => ({ name: x.displayName, text: x.content, sel: x.isSelected }))),
  );
  record(
    '译文',
    '译者那份仍是我的（按人分份）',
    first.translations?.find((x) => x.displayName === 'M3 译者')?.content === '你好',
    '',
  );
}

{
  // 挑候选：译者没有 tra.check，应当被拒
  const after = await t.client.get(`/files/${fileA}/translations`);
  const other = after.body.sources[0].translations.find((x) => x.displayName === 'M3 校对');

  const denied = await t.client.post(`/translations/${other.id}/select`, {});
  record('权限', '译者不能挑最终译文（需要 tra.check）', denied.status === 403, `HTTP ${denied.status}`);

  const picked = await p.client.post(`/translations/${other.id}/select`, {});
  record('译文', '有审核权的人可以改选最终译文', picked.status === 200, `HTTP ${picked.status}`);

  const afterPick = await p.client.get(`/files/${fileA}/translations`);
  const selected = afterPick.body.sources[0].translations.filter((x) => x.isSelected);
  record('译文', '同一标号只保留一份选中（部分唯一索引生效）', selected.length === 1, JSON.stringify(selected.map((x) => x.content)));
}

{
  const proofread = await p.client.put(`/files/${fileA}/proofreads`, {
    targetId,
    items: [
      { sourceId: sources[0].id, proofreadContent: '你好呀！' },
      { sourceId: sources[1].id, proofreadContent: '新人' },
    ],
  });
  record('校对', '校对写入成功', proofread.status === 200, JSON.stringify(proofread.body).slice(0, 160));

  const after = await p.client.get(`/files/${fileA}/translations`);
  const first = after.body.sources[0].selected;
  record(
    '校对',
    '校对本写在 proofread_content，**不覆盖**译者原稿',
    first?.content === '你好呀' && first?.proofreadContent === '你好呀！',
    JSON.stringify({ content: first?.content, proofread: first?.proofreadContent }),
  );
  record(
    '校对',
    '完整度：2/2 已校对',
    after.body.completeness?.targets?.[0]?.proofread === 2,
    JSON.stringify(after.body.completeness?.targets?.[0]),
  );
}

// ── 四、状态机 ──────────────────────────────────────────────
console.log('\n四、状态机');

{
  // 一次跳多格本身是允许的（短篇一次做完），但**沿途每一站都要过校验**。
  // 拿最有权限的人来试：即便他有 publish.approve，也不该能跳过翻译与成品直接发布。
  const jump = await admin.post(`/files/${fileA}/state`, { to: 'published' });
  record(
    '状态',
    '跨多级跳跃也要过沿途每一站（管理员也不能直接跳到已发布）',
    jump.status === 409 && jump.body?.error === 'PREREQUISITE_NOT_MET',
    `HTTP ${jump.status} ${JSON.stringify(jump.body)}`,
  );
  {
    // 这张图的译文与校对都齐了，所以真正卡住的是「已嵌字」。
    // 提示里必须同时出现「用户按的那一站」与「实际卡住的那一站」，
    // 否则用户会盯着自己按的按钮想不通。
    const msg = String(jump.body?.message ?? '');
    record('状态', '被拦下时同时说明了目标站与实际卡住的站', msg.includes('已发布') && msg.includes('已嵌字'), msg.slice(0, 120));
  }

  const skip = await t.client.post(`/files/${fileA}/state`, { to: 'translated' });
  record('状态', '译者可以把自己这步标记为已翻译', skip.status === 200, JSON.stringify(skip.body).slice(0, 160));

  const detail = await admin.get(`/files/${fileA}`);
  record('状态', '文件状态已变成 translated', detail.body?.file?.state === 'translated', String(detail.body?.file?.state));

  const history = await t.client.get(`/files/${fileA}/state-history`);
  const tos = history.body?.history?.map((h) => h.to) ?? [];
  record(
    '状态',
    '状态流水记录了每一次流转（含操作者）',
    tos.includes('translating') && tos.includes('translated') && history.body.history.every((h) => h.actorName),
    JSON.stringify(tos),
  );
}

{
  const next = await p.client.post(`/files/${fileA}/state`, { to: 'proofread' });
  record('状态', '校对标记为已校对', next.status === 200, JSON.stringify(next.body).slice(0, 120));

  // 回退：需要有 tra.check（校对有，译者没有）
  const byTranslator = await t.client.post(`/files/${fileA}/state`, { to: 'translated' });
  record('权限', '译者不能打回（回退需要 tra.check）', byTranslator.status === 403, `HTTP ${byTranslator.status}`);

  const byProofreader = await p.client.post(`/files/${fileA}/state`, { to: 'translated', note: '有一句要重译' });
  record('状态', '校对可以打回上一环节', byProofreader.status === 200 && byProofreader.body?.backward === true, JSON.stringify(byProofreader.body).slice(0, 140));

  const back = await admin.post(`/files/${fileA}/state`, { to: 'proofread' });
  record('状态', '再次推进回已校对', back.status === 200, `HTTP ${back.status}`);
}

{
  // 校对角色本身没有 file.typeset，所以先被**权限**拦下 —— 这是对的顺序。
  const byProofreader = await p.client.post(`/files/${fileA}/state`, { to: 'typeset' });
  record('权限', '校对没有 file.typeset，被权限拦下（403）', byProofreader.status === 403, `HTTP ${byProofreader.status}`);

  // 有权限的人才会走到**前置条件**那一关：没有成品就不能标已嵌字。
  //
  // ⚠️ 这里曾经断言消息里有「M5 的环节」——那是 M5 还没做时的一句版本说明。
  // 现在成品回传已经上线，那句话既过时又误导（用户刚传完成品却被告知功能没开放），
  // 已经删掉了，所以改成断言**真正的那条理由**：缺的是成品。
  const byAdmin = await admin.post(`/files/${fileA}/state`, { to: 'typeset' });
  const byAdminMsg = String(byAdmin.body?.message ?? '');
  record(
    '状态',
    '有权限但没成品时被前置条件拦住，且理由点明缺「成品」',
    byAdmin.status === 409 && byAdminMsg.includes('成品'),
    JSON.stringify(byAdmin.body),
  );
  record(
    '状态',
    '不再提「尚未开放」这类版本说明（M5 已上线，说没开放就是假话）',
    !byAdminMsg.includes('尚未开放') && !byAdminMsg.includes('M5'),
    JSON.stringify(byAdmin.body),
  );
}

// ── 五、署名台账 ────────────────────────────────────────────
console.log('\n五、署名台账');

{
  const credits = await admin.get(`/files/${fileA}/credits`);
  record(
    '署名',
    '完成翻译后自动记上译者',
    credits.body?.summary?.translator?.text === 'M3 译者',
    JSON.stringify(credits.body?.summary?.translator),
  );
  record(
    '署名',
    '完成校对后自动记上校对',
    credits.body?.summary?.proofreader?.names?.includes('M3 校对'),
    JSON.stringify(credits.body?.summary?.proofreader),
  );
  // 这条是本系统的一个**有意行为**，不是 bug：自动署名记的是「按下完成的人」。
  // 代别人按按钮就会记到按下的人头上，需要用「改署名」修正。
  // 之所以不改成「按实际贡献推断」—— 那需要猜「谁改的这句话」，
  // 而一个可以被手工改正的明确规则，比一个猜错的自动规则好。
  record(
    '署名',
    '代别人按「完成」会记到按下的人头上（可由手工署名修正）',
    credits.body?.summary?.proofreader?.names?.includes('站点管理员') &&
      credits.body?.summary?.proofreader?.names?.length === 2,
    JSON.stringify(credits.body?.summary?.proofreader),
  );
  record('署名', '嵌字一栏还是空的', credits.body?.summary?.typesetter?.text === '', JSON.stringify(credits.body?.summary?.typesetter));

  // 重复推进不应产生重复署名
  await admin.post(`/files/${fileA}/state`, { to: 'translated' });
  await admin.post(`/files/${fileA}/state`, { to: 'proofread' });
  const again = await admin.get(`/files/${fileA}/credits`);
  record(
    '署名',
    '反复推进不会产生重复署名（台账幂等）',
    again.body?.credits?.filter((c) => c.role === 'translator').length === 1,
    JSON.stringify(again.body?.credits?.map((c) => `${c.role}:${c.displayName}`)),
  );

  // 手工改署名：整体替换 + 支持外部署名
  const manual = await admin.put(`/files/${fileA}/credits`, {
    role: 'translator',
    entries: [{ userId: t.userId }, { displayName: '站外协助者' }],
  });
  record(
    '署名',
    '手工改署名是整体替换，顺序即录入顺序',
    manual.body?.summary?.translator?.text === 'M3 译者、站外协助者',
    JSON.stringify(manual.body?.summary?.translator),
  );

  const denied = await t.client.put(`/files/${fileA}/credits`, { role: 'translator', entries: [] });
  record('权限', '译者不能改署名（需要 tra.check）', denied.status === 403, `HTTP ${denied.status}`);
}

// ── 六、下游通知 ────────────────────────────────────────────
console.log('\n六、下游通知');

{
  // 把状态推回去再推一遍，制造一次「翻译完成」事件
  await admin.post(`/files/${fileA}/state`, { to: 'translated', note: '重新翻译完成' });

  const inbox = await p.client.get('/notifications');
  const matching = inbox.body?.notifications?.find((n) => n.kind === 'stage.entered_translated');
  record('通知', '校对收到「翻译完成」的通知', Boolean(matching), JSON.stringify(inbox.body?.notifications?.map((n) => n.kind)));
  {
    const body = String(matching?.body ?? '');
    const who = body.match(/^(.+?) 把作品/)?.[1] ?? '';
    record('通知', '通知文案里写了是谁推进的', who.trim().length > 0, body.slice(0, 90));
    record('通知', '通知文案里带上了作品名', body.includes('M3作品A-'), body.slice(0, 90));
  }
  record('通知', '未读数大于 0', inbox.body?.unread > 0, String(inbox.body?.unread));

  const actorInbox = await t.client.get('/notifications');
  record(
    '通知',
    '操作者本人不会收到自己触发的通知',
    !(actorInbox.body?.notifications ?? []).some((n) => n.fileId === fileA && n.kind === 'stage.entered_translated'),
    JSON.stringify((actorInbox.body?.notifications ?? []).map((n) => n.kind)),
  );

  const markRead = await p.client.post('/notifications/read', { all: true });
  record('通知', '全部标记已读', markRead.status === 200 && markRead.body?.marked > 0, JSON.stringify(markRead.body));

  const afterRead = await p.client.get('/notifications');
  record('通知', '标记后未读数归零', afterRead.body?.unread === 0, String(afterRead.body?.unread));
}

{
  const todos = await p.client.get('/my-todos');
  record('待办', '接口可用且返回项目维度计数', todos.status === 200 && typeof todos.body?.total === 'number', JSON.stringify(todos.body).slice(0, 120));
}

// ── 七、图片跨作品移动 ──────────────────────────────────────
console.log('\n七、图片跨作品移动');

{
  const targets = await admin.get(`/projects/${projectAId}/move-targets`);
  const b = targets.body?.projects?.find((x) => x.id === projectBId);
  record('移动', '移动目标列表含同团队其他作品及其语言', Boolean(b), JSON.stringify(targets.body?.projects?.map((x) => x.name)));
  record(
    '移动',
    '目标作品的语言一并返回（用于提前提示会补哪种语言）',
    Array.isArray(b?.targetLanguages) && b.targetLanguages.some((l) => l.language === 'en'),
    JSON.stringify(b?.targetLanguages),
  );

  const moved = await admin.post(`/projects/${projectAId}/files/move`, {
    toProjectId: projectBId,
    fileIds: [fileA],
  });
  record('移动', '移动到缺少 zh-CN 的作品 B 成功', moved.status === 200, JSON.stringify(moved.body));
  record(
    '移动',
    '目标作品自动补上了 zh-CN（而不是丢掉译文）',
    moved.body?.createdTargets?.some((x) => x.language === 'zh-CN'),
    JSON.stringify(moved.body?.createdTargets),
  );
  record('移动', '译文被重映射并计数返回', moved.body?.translationsRemapped > 0, String(moved.body?.translationsRemapped));

  // 移动之后：标号还在、译文还在、且能在新作品里读到
  const afterMove = await admin.get(`/projects/${projectBId}/files`);
  const stillThere = afterMove.body?.files?.some((f) => f.id === fileA);
  record('移动', '图片出现在作品 B 的列表里', Boolean(stillThere), JSON.stringify(afterMove.body?.files?.map((f) => f.name)));

  const sourcesAfter = await admin.get(`/files/${fileA}/sources`);
  record('移动', '标号随图保留', sourcesAfter.body?.sources?.length === 2, String(sourcesAfter.body?.sources?.length));

  const detailB = await admin.get(`/projects/${projectBId}`);
  const zhTarget = detailB.body?.targets?.find((t) => t.language === 'zh-CN');
  const translationsAfter = await admin.get(`/files/${fileA}/translations?targetId=${zhTarget?.id}`);
  const first = translationsAfter.body?.sources?.[0];
  record(
    '移动',
    '译文按语言重映射到新作品，内容与选中态都在',
    first?.translations?.length === 2 && first?.selected?.content === '你好呀',
    JSON.stringify({
      count: first?.translations?.length,
      selected: first?.selected?.content,
      proofread: first?.selected?.proofreadContent,
    }),
  );

  const creditsAfter = await admin.get(`/files/${fileA}/credits`);
  record('移动', '署名随图保留', creditsAfter.body?.summary?.translator?.text?.includes('M3 译者'), JSON.stringify(creditsAfter.body?.summary?.translator));
}

{
  const same = await admin.post(`/projects/${projectAId}/files/move`, { toProjectId: projectAId, fileIds: [fileA] });
  record('移动', '移动到当前作品被拒', same.status === 400, `HTTP ${same.status} ${same.body?.error ?? ''}`);

  const notMine = await admin.post(`/projects/${projectBId}/files/move`, {
    toProjectId: projectCId,
    fileIds: [fileA, '00000000-0000-0000-0000-000000000000'],
  });
  record('移动', '请求里混入不属于该作品的 id 时整批拒绝', notMine.status === 400, `HTTP ${notMine.status} ${notMine.body?.error ?? ''}`);
}

{
  // 真正的重复场景：同一份字节在两个作品里各有一份 → 移动应整批拒绝
  const bytes = makePng(321, 321, [7, 8, 9]);
  const inA = await uploadImage(admin, projectAId, 'same-in-a.png', bytes);
  const inB = await uploadImage(admin, projectBId, 'same-in-b.png', bytes);
  record(
    '移动',
    '同一份字节可以存在于两个作品（跨作品重复是允许的）',
    inA.status === 201 && inB.status === 201,
    `${inA.status}/${inB.status}`,
  );

  const fileInA = inA.body?.uploaded?.[0]?.id;

  const conflictRes = await admin.post(`/projects/${projectAId}/files/move`, {
    toProjectId: projectBId,
    fileIds: [fileInA],
  });
  record('移动', '目标作品已有相同内容 → 整批拒绝（409）', conflictRes.status === 409, `HTTP ${conflictRes.status}`);
  record(
    '移动',
    '拒绝信息里列出了是哪几张',
    String(conflictRes.body?.message ?? '').includes('same-in-a.png'),
    String(conflictRes.body?.message ?? '').slice(0, 120),
  );
}

// ── 八、作品进度与工作台 ────────────────────────────────────
console.log('\n八、进度与工作台');

{
  const summary = await admin.get(`/projects/${projectBId}/state-summary`);
  record(
    '进度',
    '作品状态汇总把各状态张数都列出来（含 0）',
    typeof summary.body?.byState?.sourced === 'number' && summary.body?.total >= 2,
    JSON.stringify(summary.body?.byState),
  );

  // 作品 B 原本只有 en，zh-CN 是移动时补上的（orderIndex 更大），
  // 所以默认目标语言是 en —— 这里要显式指定 zh-CN，否则查的是没有人翻的英文。
  const bTargets = await admin.get(`/projects/${projectBId}`);
  const bZh = bTargets.body?.targets?.find((x) => x.language === 'zh-CN');
  const stats = await admin.get(`/projects/${projectBId}/translation-stats?targetId=${bZh?.id}`);
  const entry = stats.body?.files?.[fileA];
  record(
    '进度',
    '按文件的译文进度（标号数/已翻/已校）',
    entry?.sources === 2 && entry?.translated === 2,
    JSON.stringify(entry),
  );
}

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('M3 全部通过。');
