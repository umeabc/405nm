#!/usr/bin/env node
/**
 * M5 端到端验证：导出（LabelPlus txt / 工程包 / 成品包）与成品回传。
 *
 *   node tests/m5-verify.mjs [baseUrl]
 *
 * 在测试机上跑（挂载点是 /repo/tests，这样 Node 能解析到 /repo/node_modules）：
 *   docker compose -f deploy/docker-compose.yml run --rm \
 *     -v /opt/405nm/tests:/repo/tests:ro \
 *     -e M5_ADMIN_PASSWORD=... backend node /repo/tests/m5-verify.mjs
 *
 * 与 m1/m2/m3/m4 同一套骨架（管理员建号 + 拉进团队，不走注册 —— 注册有
 * 单 IP 每小时 3 次的限流，反复跑会被挡住）。
 *
 * 这个脚本的重点在**跨系统的一致性**，而不是各接口单独能用：
 *   - txt 里的文件名必须与压缩包里的条目逐字一致（官方 PS 脚本靠文件名认图，
 *     对不上就是「一个标号都嵌不上，且不报错」）；
 *   - 帧内/框外必须落在 LabelPlus 的 1/2 组上；
 *   - 译文取「校对稿优先于选中稿」；
 *   - 没译文时用原文兜底，且**在报告的统计里明确算作「没翻」**。
 */

import { unzipSync } from 'fflate';
import { makePng } from './lib/png.mjs';

const BASE = (process.argv[2] ?? 'http://backend:3000/api').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.M5_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.M5_ADMIN_PASSWORD ?? '';

const RUN_ID = Date.now().toString(36);
const TEAM_NAME = `M5验证组-${RUN_ID}`;
const PROJECT_NAME = `M5作品-${RUN_ID}`;

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

  /** 取原始字节（压缩包 / txt 用），不做 JSON 解析。 */
  async bytes(path) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(`${BASE}${path}`, { headers });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf };
  }

  get = (p) => this.request('GET', p);
  post = (p, b) => this.request('POST', p, b);
  put = (p, b) => this.request('PUT', p, b);
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

async function uploadOutput(client, fileId, filename, buffer, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([buffer], { type: 'image/png' }), filename);
  const headers = {};
  if (client.cookie) headers.cookie = client.cookie;
  const res = await fetch(`${BASE}/files/${fileId}/outputs`, { method: 'POST', headers, body: form });
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
const typesetter = new Client('typesetter');
const outsider = new Client('outsider');

console.log(`\n405nm M5 验证 —— ${BASE}\n`);

if (!ADMIN_PASSWORD) {
  console.error('未提供 M5_ADMIN_PASSWORD，无法继续。');
  process.exit(2);
}

const login = await admin.post('/auth/login', { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
if (login.status !== 200) {
  console.error(`管理员登录失败（HTTP ${login.status}）：${JSON.stringify(login.body)}`);
  process.exit(2);
}

// ── 一、搭场景 ──────────────────────────────────────────────
console.log('一、搭场景');

const team = await admin.post('/teams', { name: TEAM_NAME, intro: 'M5 自动验证' });
const teamId = team.body?.team?.id;
record('场景', '创建验证团队', team.status === 201 && Boolean(teamId), JSON.stringify(team.body));

const project = await admin.post(`/teams/${teamId}/projects`, {
  name: PROJECT_NAME,
  author: 'M5 作者',
  sourceLanguage: 'ja',
  targetLanguages: ['zh-CN'],
});
const projectId = project.body?.project?.id;
record('场景', '创建作品（目标语言 zh-CN）', project.status === 201 && Boolean(projectId), JSON.stringify(project.body));

const targetsRes = await admin.get(`/projects/${projectId}/exports/targets`);
const targetId = targetsRes.body?.targets?.[0]?.id;
record(
  '场景',
  '导出目标语言可列出来',
  targetsRes.status === 200 && targetsRes.body?.targets?.length === 1,
  JSON.stringify(targetsRes.body),
);

const teamDetail = await admin.get(`/teams/${teamId}`);
const memberRoleId = teamDetail.body?.roles?.find((r) => r.systemCode === 'member')?.id;

async function makeMember(suffix, displayName) {
  const username = `m5_${suffix}_${RUN_ID}`;
  const created = await admin.post('/admin/users', { username, password: 'm5-verify-pass-1', displayName });
  await admin.post(`/teams/${teamId}/members`, { username, roleId: memberRoleId });
  const client = new Client(suffix);
  await client.post('/auth/login', { username, password: 'm5-verify-pass-1' });
  return { client, username, userId: created.body?.user?.id };
}

// 嵌字角色：有 file.typeset（回传成品）与 tra.output（导出）
const ts = await makeMember('ts', 'M5 嵌字');
// 团队路人：没有任何作品角色，用来验证导出接口会拦他
const out = await makeMember('out', 'M5 路人');

const rolesRes = await admin.get(`/projects/${projectId}`);
const roles = rolesRes.body?.roles ?? [];
const typesetterRoleId = roles.find((r) => r.systemCode === 'typesetter')?.id;
record(
  '场景',
  '作品里有「嵌字」系统角色',
  Boolean(typesetterRoleId),
  JSON.stringify(roles.map((r) => r.systemCode)),
);

// ⚠️ 这个接口收的是 userId + projectRoleId（不是 username + roleId）。
// 第一次跑的时候字段名写错了，请求被校验拒掉、而我没看返回码 —— 于是
// 「嵌字角色可以回传成品」的断言以 403 的面目失败，看起来像权限配错了。
// **异步搭建场景的每一步都要断言**，否则失败会伪装成毫不相干的另一件事。
const addTs = await admin.post(`/projects/${projectId}/members`, {
  userId: ts.userId,
  projectRoleId: typesetterRoleId,
});
record('场景', '把嵌字成员加进作品', addTs.status === 201 || addTs.status === 200, `HTTP ${addTs.status} ${JSON.stringify(addTs.body).slice(0, 160)}`);

// ── 二、标号与译文 ──────────────────────────────────────────
console.log('\n二、标号与译文（导出要拿它当输入）');

// ⚠️ 两张图必须**字节不同**。用同样的内容会撞上团队级 MD5 去重，
// 第二张只会出现在 duplicates 里、拿不到 id，后面整片断言会跟着塌方
// （第一次跑就是这么塌的）。尺寸差一点点就够了。
const fileA = (await uploadImage(admin, projectId, '001.png', makePng(800, 1200))).body?.uploaded?.[0]?.id;
const fileB = (await uploadImage(admin, projectId, '002.png', makePng(810, 1210))).body?.uploaded?.[0]?.id;
record('场景', '上传两张图（字节不同，不会被去重挡掉）', Boolean(fileA && fileB), `${fileA} / ${fileB}`);

// A 图：三个标号 —— 一条有校对稿、一条只有译文、一条两者都没有（走原文兜底）
const sA1 = (await admin.post(`/files/${fileA}/sources`, { x: 0.1, y: 0.2, content: 'こんにちは' })).body?.source?.id;
const sA2 = (await admin.post(`/files/${fileA}/sources`, { x: 0.3, y: 0.4, positionType: 'out', content: 'さようなら' }))
  .body?.source?.id;
const sA3 = (await admin.post(`/files/${fileA}/sources`, { x: 0.5, y: 0.6, content: 'まだ翻訳していない' })).body?.source
  ?.id;
record('场景', 'A 图三个标号（含一个框外）', Boolean(sA1 && sA2 && sA3), `${sA1} / ${sA2} / ${sA3}`);

// B 图：一个标号，有译文。用来验证多文件与成品包
const sB1 = (await admin.post(`/files/${fileB}/sources`, { x: 0.2, y: 0.3, content: 'ふたつめ' })).body?.source?.id;

const trad = await admin.put(`/files/${fileA}/translations`, {
  targetId,
  items: [
    { sourceId: sA1, content: '你好' },
    { sourceId: sA2, content: '再见' },
  ],
});
record('场景', '录入 A 图前两条译文', trad.status === 200, JSON.stringify(trad.body).slice(0, 160));
record(
  '场景',
  '第三条刻意不录（验证原文兜底与实际统计）',
  true,
);

// 给 sA1 一份校对稿，验证「校对稿优先于选中稿」
// ⚠️ 校对是**独立端点** /proofreads。写到 /translations 上会被那个 schema
// 拒掉（它要求每项带 content），第一次跑就撞在这个上面。
const proof = await admin.put(`/files/${fileA}/proofreads`, {
  targetId,
  items: [{ sourceId: sA1, proofreadContent: '你好呀（校对后）' }],
});
record('场景', '给第一条写校对稿', proof.status === 200, JSON.stringify(proof.body).slice(0, 160));

const tradB = await admin.put(`/files/${fileB}/translations`, {
  targetId,
  items: [{ sourceId: sB1, content: '第二张' }],
});
record('场景', '录入 B 图译文', tradB.status === 200, JSON.stringify(tradB.body).slice(0, 120));

// ── 三、导出体检 ────────────────────────────────────────────
console.log('\n三、导出体检（preview）');

const preview = await admin.get(`/projects/${projectId}/exports/preview?targetId=${targetId}`);
record('体检', '能取到导出体检报告', preview.status === 200, JSON.stringify(preview.body).slice(0, 200));

const stats = preview.body?.markerStats;
record('体检', '图片数正确', preview.body?.fileCount === 2, String(preview.body?.fileCount));
record('体检', '标号总数正确（3 + 1）', stats?.total === 4, JSON.stringify(stats));
record(
  '体检',
  '「已有译文」只算真翻了的（3 条，不含原文兜底的那条）',
  stats?.translated === 3,
  JSON.stringify(stats),
);
record('体检', '「已校对」认出那条校对稿', stats?.proofread === 1, JSON.stringify(stats));
record(
  '体检',
  '原文兜底与空标号被如实计入「没翻」',
  stats?.fallbackToSource === 1 && stats?.empty === 0,
  JSON.stringify(stats),
);
record(
  '体检',
  '列出没翻的那张图（用导出后的名字）',
  JSON.stringify(preview.body?.filesWithoutTranslation) === JSON.stringify(['001.png']),
  JSON.stringify(preview.body?.filesWithoutTranslation),
);

// ── 四、LabelPlus txt ───────────────────────────────────────
console.log('\n四、LabelPlus txt');

const txtRes = await admin.bytes(`/projects/${projectId}/exports/labelplus?targetId=${targetId}`);
record('txt', '能下载 txt', txtRes.status === 200, `HTTP ${txtRes.status}`);

const txt = txtRes.buf.toString('utf8');
record('txt', '首字节是 UTF-8 BOM', txtRes.buf[0] === 0xef && txtRes.buf[1] === 0xbb && txtRes.buf[2] === 0xbf, '');
record('txt', '行尾是 CRLF', txt.includes('\r\n') && !/[^\r]\n/.test(txt), '');
record(
  'txt',
  'Content-Type 是 text/plain; charset=utf-8',
  (txtRes.headers.get('content-type') ?? '').includes('charset=utf-8'),
  txtRes.headers.get('content-type') ?? '',
);
record(
  'txt',
  'Content-Disposition 带 UTF-8 文件名（中文作品名不乱码）',
  (txtRes.headers.get('content-disposition') ?? '').includes("filename*=UTF-8''"),
  txtRes.headers.get('content-disposition') ?? '',
);

const lines = txt.replace(/^﻿/, '').split('\r\n');
record('txt', '版本行是 1.0,1.0', lines[0] === '1.0,1.0', lines[0]);
record('txt', '第一个分隔符是单独一行的 -', lines[1] === '-', JSON.stringify(lines[1]));
record('txt', '组名是 框内 / 框外', lines[2] === '框内' && lines[3] === '框外', JSON.stringify(lines.slice(2, 4)));

record('txt', '包含两个文件头', (txt.match(/^>>>>>>\[.+?\]<<<<<<$/gm) ?? []).length === 2, '');
record('txt', '文件头用的是文件名', txt.includes('>>>>>>[001.png]<<<<<<') && txt.includes('>>>>>>[002.png]<<<<<<'), '');

// 标号头：------[n]------[x,y,组号]
const heads = [...txt.matchAll(/^------\[(\d+)\]------\[([0-9.]+),([0-9.]+),(\d+)\]$/gm)].map((m) => ({
  index: Number(m[1]),
  x: Number(m[2]),
  y: Number(m[3]),
  group: Number(m[4]),
}));
record('txt', '四条标号头都出来了', heads.length === 4, JSON.stringify(heads));

const a1 = heads[0];
record('txt', '坐标是 4 位小数且归一化', txt.includes('[0.1000,0.2000,'), txt.slice(txt.indexOf('------'), txt.indexOf('------') + 60));
record('txt', '框内落在组 1', a1?.group === 1, JSON.stringify(a1));
record('txt', '框外落在组 2（第二条标号）', heads[1]?.group === 2, JSON.stringify(heads[1]));
record(
  'txt',
  '序号在同一张图内从 1 连续递增',
  JSON.stringify(heads.slice(0, 3).map((h) => h.index)) === JSON.stringify([1, 2, 3]),
  JSON.stringify(heads.map((h) => h.index)),
);

record('txt', '校对稿优先于选中稿', txt.includes('你好呀（校对后）') && !txt.includes('\r\n你好\r\n'), '');
record('txt', '未校对的用选中译文', txt.includes('再见') && txt.includes('第二张'), '');
record(
  'txt',
  '没译文的那条用原文兜底（不让标号凭空消失）',
  txt.includes('まだ翻訳していない'),
  '',
);

// 序号与画布一致的前提：不能因为「空译文」而跳号。
// 这里第三条标号有原文，所以一定在；真正要验的是「一条都不少」。
record(
  'txt',
  '标号一条都没少（序号连续到 4，B 图是 1）',
  heads[3]?.index === 1 && heads.length === 4,
  JSON.stringify(heads),
);

// 权限：团队路人（无作品角色）不该能导出
const deniedTxt = await out.client.bytes(`/projects/${projectId}/exports/labelplus?targetId=${targetId}`);
record('权限', '团队路人导出被拒（403）', deniedTxt.status === 403, `HTTP ${deniedTxt.status}`);

const deniedPreview = await out.client.get(`/projects/${projectId}/exports/preview?targetId=${targetId}`);
record('权限', '团队路人读体检报告也被拒', deniedPreview.status === 403, `HTTP ${deniedPreview.status}`);

// ── 五、成品回传 ────────────────────────────────────────────
console.log('\n五、成品回传');

const noOutputYet = await admin.get(`/files/${fileA}/outputs`);
record('成品', '一开始没有成品', noOutputYet.status === 200 && noOutputYet.body?.count === 0, JSON.stringify(noOutputYet.body));

const up1 = await uploadOutput(admin, fileA, '001_嵌字.png', makePng(800, 1200));
record('成品', '回传第一版成功', up1.status === 201 || up1.status === 200, `HTTP ${up1.status} ${JSON.stringify(up1.body).slice(0, 200)}`);
record('成品', '第一版版本号是 1', up1.body?.output?.version === 1, JSON.stringify(up1.body?.output));

const up2 = await uploadOutput(admin, fileA, '001_嵌字_v2.png', makePng(820, 1240));
record('成品', '再传一次得到第 2 版', up2.body?.output?.version === 2, JSON.stringify(up2.body?.output));
record('成品', '两版尺寸各自独立记录', up2.body?.output?.width === 820, String(up2.body?.output?.width));

const list = await admin.get(`/files/${fileA}/outputs`);
record('成品', '列表有两版', list.body?.count === 2, JSON.stringify(list.body?.count));
record('成品', '列表最新在前', list.body?.outputs?.[0]?.version === 2, JSON.stringify(list.body?.outputs?.map((o) => o.version)));
record('成品', '列表不暴露存储键', list.body?.outputs?.[0]?.storageKey === undefined, '');

// 成品字节流
const outId = list.body?.outputs?.[0]?.id;
const rawRes = await admin.bytes(`/files/${fileA}/outputs/${outId}/media/raw`);
record('成品', '成品原图能读出来', rawRes.status === 200 && rawRes.buf.length > 0, `HTTP ${rawRes.status}, ${rawRes.buf.length} 字节`);
record('成品', '成品响应带 immutable 长缓存', (rawRes.headers.get('cache-control') ?? '').includes('immutable'), rawRes.headers.get('cache-control') ?? '');
const thumbRes = await admin.bytes(`/files/${fileA}/outputs/${outId}/media/thumb`);
record('成品', '成品缩略图能读出来（WebP）', thumbRes.status === 200 && thumbRes.buf.length > 0, `HTTP ${thumbRes.status}`);

// 拿别的文件 id + 这个成品 id 去取字节 —— 必须取不到
const crossRes = await admin.bytes(`/files/${fileB}/outputs/${outId}/media/raw`);
record('成品', '用别的文件 id 取不到这份成品（防越权）', crossRes.status === 404, `HTTP ${crossRes.status}`);

// 文件列表要带上成品数（卡片徽标靠它，不能靠 N+1）
const filesList = await admin.get(`/projects/${projectId}/files`);
const rowA = filesList.body?.files?.find((f) => f.id === fileA);
record('成品', '文件列表带 outputCount', rowA?.outputCount === 2, JSON.stringify(rowA?.outputCount));

// ── 状态机：分别验证「译文没齐」与「没有成品」两道门槛 ──────
//
// ⚠️ A 图**测不了**成品那道门槛：状态机沿途每一站都校验，
// A 图还留着一条没翻的标号，「已翻译」那一关会先拦住。
// 所以 B 图先把译文与校对补齐、独缺成品，这道门槛才隔离得出来。
const earlyTypeset = await admin.post(`/files/${fileA}/state`, { to: 'typeset' });
record(
  '成品',
  'A 图译文没齐时被拦，且理由点明是「译文」而不是别的',
  earlyTypeset.status === 409 && /译文|翻译/.test(earlyTypeset.body?.message ?? ''),
  `HTTP ${earlyTypeset.status} ${JSON.stringify(earlyTypeset.body).slice(0, 160)}`,
);

await admin.put(`/files/${fileB}/translations`, { targetId, items: [{ sourceId: sB1, content: '第二张' }] });
await admin.put(`/files/${fileB}/proofreads`, { targetId, items: [{ sourceId: sB1, proofreadContent: '第二张（校对后）' }] });

const walkB = await admin.post(`/files/${fileB}/state`, { to: 'typesetting' });
record(
  '成品',
  'B 图（译文校对齐）可以推进到「嵌字中」',
  walkB.status === 200,
  `HTTP ${walkB.status} ${JSON.stringify(walkB.body).slice(0, 160)}`,
);

const noOutput = await admin.post(`/files/${fileB}/state`, { to: 'typeset' });
record(
  '成品',
  '没有成品时进不了「已嵌字」，且理由点明是缺「成品」',
  noOutput.status === 409 && /成品/.test(noOutput.body?.message ?? ''),
  `HTTP ${noOutput.status} ${JSON.stringify(noOutput.body).slice(0, 160)}`,
);

const upB = await uploadOutput(admin, fileB, '002_嵌字.png', makePng(820, 1220));
record('成品', 'B 图回传成品', upB.status === 200 || upB.status === 201, `HTTP ${upB.status}`);

const nowTypeset = await admin.post(`/files/${fileB}/state`, { to: 'typeset' });
record(
  '成品',
  '回传成品之后就能进「已嵌字」',
  nowTypeset.status === 200,
  `HTTP ${nowTypeset.status} ${JSON.stringify(nowTypeset.body).slice(0, 160)}`,
);

// 权限：团队路人不能回传
const deniedUp = await uploadOutput(out.client, fileB, 'x.png', makePng(100, 100));
record('权限', '团队路人回传成品被拒（403）', deniedUp.status === 403, `HTTP ${deniedUp.status}`);

// 嵌字角色应该能回传
const tsUp = await uploadOutput(ts.client, fileB, '002_嵌字_b.png', makePng(830, 1230));
record('权限', '嵌字角色可以回传成品', tsUp.status === 200 || tsUp.status === 201, `HTTP ${tsUp.status} ${JSON.stringify(tsUp.body).slice(0, 160)}`);

// 拒绝非图片
const badUp = await uploadOutput(admin, fileB, 'not-an-image.png', Buffer.from('这不是图片'));
record('成品', '坏文件被拒（不是图片）', badUp.status === 400, `HTTP ${badUp.status} ${JSON.stringify(badUp.body).slice(0, 140)}`);

// ── 六、压缩包 ──────────────────────────────────────────────
console.log('\n六、工程包与成品包');

const zipRes = await admin.bytes(`/projects/${projectId}/exports/project.zip?targetId=${targetId}`);
record('工程包', '能下载', zipRes.status === 200, `HTTP ${zipRes.status}`);

let entries = {};
try {
  entries = unzipSync(new Uint8Array(zipRes.buf));
} catch (err) {
  record('工程包', '能解开（zip 结构合法）', false, String(err?.message ?? err));
}
const names = Object.keys(entries);
record('工程包', '能解开（zip 结构合法）', names.length > 0, names.join(', '));

// ⚠️ 这一条是整条离线流程的命门：txt 里的文件名必须与包里的条目**逐字一致**，
// 否则官方 PS 脚本按文件名找不到图，一个标号都嵌不上，而且不报错。
const txtInZip = entries[`${PROJECT_NAME}_zh-CN.txt`];
record('工程包', '含与作品名+语言同名的 txt', Boolean(txtInZip), names.join(', '));

if (txtInZip) {
  const txtInZipText = Buffer.from(txtInZip).toString('utf8');
  const txtNames = [...txtInZipText.matchAll(/^>>>>>>\[(.+?)\]<<<<<<$/gm)].map((m) => m[1]);
  const imageNames = names.filter((n) => /\.(png|jpe?g|webp)$/i.test(n));
  record(
    '工程包',
    '**txt 里的文件名与包内图片名逐字一致**（不一致 PS 脚本会静默嵌不上）',
    JSON.stringify(txtNames) === JSON.stringify(imageNames),
    `txt: ${JSON.stringify(txtNames)} / 包: ${JSON.stringify(imageNames)}`,
  );
  // 与**当前**内容比，不能跟第 4 节那份比 —— 中间为了走状态机
  // 补录了 B 图的译文与校对，txt 本来就该跟着变。
  const freshTxt = (await admin.bytes(`/projects/${projectId}/exports/labelplus?targetId=${targetId}`)).buf.toString('utf8');
  record(
    '工程包',
    '包里的 txt 与同时刻单独下载的 txt 逐字节一致',
    txtInZipText === freshTxt,
    `长度 包内 ${txtInZipText.length} / 单独 ${freshTxt.length}`,
  );
  record(
    '工程包',
    '补录译文之后 txt 确实变了（不是缓存了旧内容）',
    freshTxt !== txt && freshTxt.includes('第二张（校对后）'),
    '',
  );
}

record('工程包', '含图片', names.includes('001.png') && names.includes('002.png'), names.join(', '));
record('工程包', '含 manifest.json', Boolean(entries['manifest.json']), '');
record('工程包', '含说明.txt', Boolean(entries['说明.txt']), '');

if (entries['manifest.json']) {
  try {
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'));
    record('工程包', 'manifest.json 能解析且带上了标号', Array.isArray(manifest.files) && manifest.files[0].markers.length === 3, '');
    record(
      '工程包',
      'manifest 里的坐标与 txt 一致',
      manifest.files[0].markers[0].x === 0.1 && manifest.files[0].markers[0].y === 0.2,
      JSON.stringify(manifest.files[0].markers[0]),
    );
  } catch (err) {
    record('工程包', 'manifest.json 能解析', false, String(err?.message ?? err));
  }
}

const outZipRes = await admin.bytes(`/projects/${projectId}/exports/outputs.zip?targetId=${targetId}`);
record('成品包', '能下载', outZipRes.status === 200, `HTTP ${outZipRes.status}`);

let outEntries = {};
try {
  outEntries = unzipSync(new Uint8Array(outZipRes.buf));
} catch (err) {
  record('成品包', '能解开', false, String(err?.message ?? err));
}
const outNames = Object.keys(outEntries);
record('成品包', '两张图的成品都在', outNames.length === 2, outNames.join(', '));
record(
  '成品包',
  'A 图取的是最新版（v2 是 820×1240）',
  (() => {
    const key = outNames.find((n) => n.startsWith('001'));
    if (!key) return false;
    const png = Buffer.from(outEntries[key]);
    // PNG 的 IHDR 在固定偏移：宽 16-19、高 20-23（大端）
    return png.readUInt32BE(16) === 820 && png.readUInt32BE(20) === 1240;
  })(),
  'A 图应取 v2（820×1240）而不是 v1（800×1200）',
);
record(
  '成品包',
  '没有缺图时不带 X-Missing-Files',
  outZipRes.headers.get('x-missing-files') === null,
  outZipRes.headers.get('x-missing-files') ?? '(无)',
);

// ── 七、删掉一版成品 ────────────────────────────────────────
console.log('\n七、删除成品');

const del = await admin.del(`/files/${fileA}/outputs/${up2.body?.output?.id}`);
record('删除', '删掉第 2 版', del.status === 200 && del.body?.remaining === 1, JSON.stringify(del.body));

const afterDel = await admin.get(`/files/${fileA}/outputs`);
record('删除', '只剩一版且是第 1 版', afterDel.body?.count === 1 && afterDel.body?.outputs?.[0]?.version === 1, JSON.stringify(afterDel.body?.outputs?.map((o) => o.version)));

const goneRaw = await admin.bytes(`/files/${fileA}/outputs/${up2.body?.output?.id}/media/raw`);
record('删除', '删掉的成品字节也取不到了', goneRaw.status === 404, `HTTP ${goneRaw.status}`);

// 成品包应当回到 v1 的尺寸
const outZip2 = await admin.bytes(`/projects/${projectId}/exports/outputs.zip?targetId=${targetId}`);
const out2 = unzipSync(new Uint8Array(outZip2.buf));
const aKey = Object.keys(out2).find((n) => n.startsWith('001'));
const aPng = aKey ? Buffer.from(out2[aKey]) : Buffer.alloc(0);
record(
  '删除',
  '删掉 v2 之后成品包回落到 v1（800×1200）',
  aPng.length > 24 && aPng.readUInt32BE(16) === 800,
  aKey ? `${aPng.readUInt32BE(16)}×${aPng.readUInt32BE(20)}` : '(找不到 A 图)',
);

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name} —— ${f.detail}`);
  process.exit(1);
}
console.log('M5 导出与成品全部通过。');
