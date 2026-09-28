#!/usr/bin/env node
/**
 * M2 端到端验证：作品集 / 作品 / 作品角色 / 目标语言 / 图片上传与媒体字节流 / 工作台 / 动态。
 *
 *   node tests/m2-verify.mjs [baseUrl]
 *
 * 在测试机上跑（脚本挂进容器，打内网地址）：
 *   docker compose -f deploy/docker-compose.yml run --rm \
 *     -v /opt/405nm/tests:/repo/tests:ro \
 *     -e M2_ADMIN_PASSWORD=... backend node /repo/tests/m2-verify.mjs
 *
 * ⚠️ 挂载点是 /repo/tests 而不是 /tests：这样 Node 的模块解析能从 /repo/node_modules
 * 找到依赖。挂到 /tests 的话，`import zlib` 之外的任何第三方模块都会解析失败。
 *
 * 与 m1-verify.mjs 同一套骨架：自带数据、断言带中文说明、失败以非零码退出。
 * 所有数据都带 run id 后缀，脚本可以反复跑而不互相干扰。
 */

import zlib from 'node:zlib';

const BASE = (process.argv[2] ?? 'http://backend:3000/api').replace(/\/$/, '');

const ADMIN_USERNAME = process.env.M2_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.M2_ADMIN_PASSWORD ?? '';

const RUN_ID = Date.now().toString(36);
const TEAM_NAME = `M2验证组-${RUN_ID}`;
const TEAM2_NAME = `M2隔离组-${RUN_ID}`;
const SET_NAME = `M2作品集-${RUN_ID}`;
const PROJECT_NAME = `M2作品-${RUN_ID}`;
const PROJECT2_NAME = `M2隔离作品-${RUN_ID}`;

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

  async request(method, path, body, raw = false) {
    const headers = {};
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });

    for (const rawCookie of res.headers.getSetCookie?.() ?? []) {
      const pair = rawCookie.split(';')[0];
      if (pair) this.cookie = pair;
    }

    if (!['application/json', 'text/plain'].some((t) => (res.headers.get('content-type') ?? '').includes(t))) {
      return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
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
  patch = (p, b) => this.request('PATCH', p, b);
  del = (p) => this.request('DELETE', p);
}

/* ── 造一张真 PNG ────────────────────────────────────────────
   不能拿假字节糊弄：后端要用 sharp 解码出宽高、生成缩略图。
   这里手写一个最小 PNG 编码器（IHDR + IDAT + IEND），
   好处是零依赖 —— 脚本在容器里、在开发机上都能直接跑。 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** 生成一张纯色 PNG。尺寸可控，便于断言 width/height 与缩略图缩放。 */
function makePng(width, height, [r, g, b] = [240, 131, 106]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 用 multipart 上传一张图。不手写 Content-Type —— 让 fetch 自己带 boundary。 */
async function uploadImage(client, projectId, filename, buffer = makePng(60, 80)) {
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
const outsider = new Client('outsider');

console.log(`\n405nm M2 验证 —— ${BASE}\n`);

if (!ADMIN_PASSWORD) {
  console.error('未提供 M2_ADMIN_PASSWORD，无法继续。');
  process.exit(2);
}

const login = await admin.post('/auth/login', { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
if (login.status !== 200) {
  console.error(`管理员登录失败（HTTP ${login.status}）：${JSON.stringify(login.body)}`);
  process.exit(2);
}

// ── 一、前端参数与语言目录 ──────────────────────────────────
console.log('一、前端参数与语言目录');

{
  const config = await admin.get('/client-config');
  record(
    '参数',
    '/client-config 返回图片上限与存储驱动',
    config.status === 200 && config.body?.maxImageMb > 0 && typeof config.body?.storageDriver === 'string',
    JSON.stringify(config.body),
  );

  const langs = await admin.get('/languages');
  record(
    '语言',
    '语言目录含常见语种且带展示名',
    langs.status === 200 && langs.body?.languages?.some((l) => l.code === 'zh-CN' && l.label),
    JSON.stringify(langs.body?.languages?.map((l) => l.code)),
  );
}

// ── 二、作品集与作品 ────────────────────────────────────────
console.log('\n二、作品集与作品');

const team = await admin.post('/teams', { name: TEAM_NAME, intro: 'M2 自动验证' });
const teamId = team.body?.team?.id;
record('团队', '创建验证团队', team.status === 201 && Boolean(teamId), JSON.stringify(team.body));

const team2 = await admin.post('/teams', { name: TEAM2_NAME, intro: 'M2 隔离验证' });
const team2Id = team2.body?.team?.id;

const setRes = await admin.post(`/teams/${teamId}/project-sets`, { name: SET_NAME, intro: 'M2' });
const setId = setRes.body?.set?.id;
record('作品集', '创建作品集', setRes.status === 201 && Boolean(setId), JSON.stringify(setRes.body));

const dupSet = await admin.post(`/teams/${teamId}/project-sets`, { name: SET_NAME });
record('作品集', '同名作品集被拒（409）', dupSet.status === 409, `HTTP ${dupSet.status}`);

const project = await admin.post(`/teams/${teamId}/projects`, {
  name: PROJECT_NAME,
  author: 'M2 验证作者',
  sourceLanguage: 'ja',
  targetLanguages: ['zh-CN'],
  setId,
});
const projectId = project.body?.project?.id;
record(
  '作品',
  '创建作品并分配编号 #1',
  project.status === 201 && project.body?.project?.serial === 1,
  JSON.stringify(project.body),
);

const project2 = await admin.post(`/teams/${team2Id}/projects`, {
  name: PROJECT2_NAME,
  sourceLanguage: 'ja',
  targetLanguages: ['zh-CN'],
});
const project2Id = project2.body?.project?.id;
record('作品', '另一个团队的作品编号独立从 #1 开始', project2.body?.project?.serial === 1, JSON.stringify(project2.body));

const conflictLang = await admin.post(`/teams/${teamId}/projects`, {
  name: `${PROJECT_NAME}-冲突`,
  sourceLanguage: 'ja',
  targetLanguages: ['ja'],
});
record('作品', '目标语言与源语言相同被拒（400）', conflictLang.status === 400, `HTTP ${conflictLang.status}`);

const detail = await admin.get(`/projects/${projectId}`);
record(
  '作品',
  '作品详情含 7 个项目角色与创建人身份',
  detail.status === 200 && detail.body?.roles?.length === 7 && detail.body?.my?.role?.systemCode === 'creator',
  `roles=${detail.body?.roles?.length} myRole=${detail.body?.my?.role?.systemCode}`,
);
record(
  '作品',
  '目标是 zh-CN 且带展示名',
  detail.body?.targets?.[0]?.language === 'zh-CN' && Boolean(detail.body?.targets?.[0]?.label),
  JSON.stringify(detail.body?.targets),
);
record(
  '作品',
  '创建人自动成为作品成员',
  detail.body?.project?.members?.some((m) => m.roleSystemCode === 'creator' || m.roleName === '创建人'),
  JSON.stringify(detail.body?.project?.members?.map((m) => m.roleName)),
);
record(
  '权限',
  '创建人拥有 project.delete 与 file.add',
  detail.body?.my?.permissions?.includes('project.delete') && detail.body?.my?.permissions?.includes('file.add'),
  '',
);

// ── 三、权限矩阵（普通成员 / 跨团队隔离）────────────────────
console.log('\n三、权限矩阵与跨团队隔离');

/*
 * 第二个身份刻意**不走注册**，而是「管理员建号 + 拉进团队」。
 * 原因：注册接口有「单 IP 每小时 3 次」的限流（防批量刷号），
 * 而验证脚本要能反复跑 —— 走注册的话，一小时内跑第四次就会卡在 429 上，
 * 让人误以为功能坏了。注册链路本身由 m1-verify.mjs 覆盖。
 */
const memberName = `m2_${RUN_ID}`;
const createdUser = await admin.post('/admin/users', {
  username: memberName,
  password: 'm2-verify-pass-1',
  displayName: 'M2 验证成员',
});
const memberUserId = createdUser.body?.user?.id;
record('成员', '管理员创建验证成员', createdUser.status === 201 && Boolean(memberUserId), JSON.stringify(createdUser.body));

const teamDetail = await admin.get(`/teams/${teamId}`);
const memberRoleId = teamDetail.body?.roles?.find((r) => r.systemCode === 'member')?.id;
const joined = await admin.post(`/teams/${teamId}/members`, { username: memberName, roleId: memberRoleId });
record('成员', '把验证成员加入团队', joined.status === 201, JSON.stringify(joined.body));

const outsiderLogin = await outsider.post('/auth/login', { username: memberName, password: 'm2-verify-pass-1' });
record('成员', '验证成员可登录', outsiderLogin.status === 200, `HTTP ${outsiderLogin.status}`);

{
  // 团队成员默认是「成员」角色（autoProjectAdmin=false），能看作品但不能改。
  const view = await outsider.get(`/projects/${projectId}`);
  record('权限', '团队成员可查看团队内的作品', view.status === 200, `HTTP ${view.status}`);
  record(
    '权限',
    '普通成员没有作品权限码（团队角色不提权）',
    Array.isArray(view.body?.my?.permissions) && view.body.my.permissions.length === 0,
    JSON.stringify(view.body?.my?.permissions),
  );

  const tryEdit = await outsider.patch(`/projects/${projectId}`, { name: '改名试试' });
  record('权限', '普通成员改作品资料被拒（403）', tryEdit.status === 403, `HTTP ${tryEdit.status}`);

  const tryUpload = await uploadImage(outsider, projectId, 'sneak.png');
  record('权限', '普通成员未经授权不能上传（403）', tryUpload.status === 403, `HTTP ${tryUpload.status}`);

  const foreign = await outsider.get(`/projects/${project2Id}`);
  record('隔离', '访问别的团队的作品返回 404', foreign.status === 404, `HTTP ${foreign.status}`);
}

// ── 四、图片上传与媒体字节流 ────────────────────────────────
console.log('\n四、图片上传与媒体字节流');

const fileIds = new Map();
{
  const first = await uploadImage(admin, projectId, 'page1.png', makePng(60, 80));
  record(
    '上传',
    '上传成功且返回真实宽高',
    first.status === 201 && first.body?.uploaded?.[0]?.width === 60 && first.body?.uploaded?.[0]?.height === 80,
    JSON.stringify(first.body),
  );
  if (first.body?.uploaded?.[0]) fileIds.set('page1.png', first.body.uploaded[0].id);

  for (const [name, buffer] of [
    ['page2.png', makePng(60, 80, [100, 140, 200])],
    ['page10.png', makePng(60, 80, [90, 170, 120])],
  ]) {
    const res = await uploadImage(admin, projectId, name, buffer);
    if (res.body?.uploaded?.[0]) fileIds.set(name, res.body.uploaded[0].id);
    record('上传', `上传 ${name}`, res.status === 201, JSON.stringify(res.body));
  }

  // 同一作品内重复字节 → 计为 duplicate，不算失败
  const dup = await uploadImage(admin, projectId, 'page1-copy.png', makePng(60, 80));
  record(
    '上传',
    '同一作品内相同内容被识别为重复（不报错，计入 duplicates）',
    dup.body?.duplicates?.length === 1 && dup.body?.uploaded?.length === 0,
    JSON.stringify(dup.body),
  );
}

{
  const list = await admin.get(`/projects/${projectId}/files`);
  const names = list.body?.files?.map((f) => f.name) ?? [];
  record('列表', '列出 3 张图片', names.length === 3, JSON.stringify(names));
  record(
    '排序',
    '按页码自然排序（page1 → page2 → page10）',
    JSON.stringify(names) === JSON.stringify(['page1.png', 'page2.png', 'page10.png']),
    JSON.stringify(names),
  );
}

{
  const fileId = fileIds.get('page1.png');

  for (const [variant, expectType] of [
    ['thumb', 'image/webp'],
    ['preview', 'image/webp'],
    ['raw', 'image/png'],
  ]) {
    const res = await admin.request('GET', `/files/${fileId}/media/${variant}`);
    record(
      '媒体',
      `${variant} 返回 200 且类型为 ${expectType}`,
      res.status === 200 &&
        (res.headers.get('content-type') ?? '').includes(expectType) &&
        res.buffer?.length > 0,
      `HTTP ${res.status} ${res.headers.get('content-type')} ${res.buffer?.length}B`,
    );
  }

  const cached = await admin.request('GET', `/files/${fileId}/media/thumb`);
  record(
    '媒体',
    '响应带 immutable 长缓存',
    (cached.headers.get('cache-control') ?? '').includes('immutable'),
    cached.headers.get('cache-control') ?? '',
  );

  const etag = cached.headers.get('etag');
  const notModified = await fetch(`${BASE}/files/${fileId}/media/thumb`, {
    headers: { cookie: admin.cookie, 'if-none-match': etag },
  });
  record('媒体', 'ETag 命中返回 304', notModified.status === 304, `HTTP ${notModified.status}`);

  // 团队成员可以读图（团队边界内的正常使用）
  const byMember = await outsider.request('GET', `/files/${fileId}/media/thumb`);
  record('媒体', '团队成员可读本团队作品的图', byMember.status === 200, `HTTP ${byMember.status}`);

  const badVariant = await admin.get(`/files/${fileId}/media/original`);
  record('媒体', '非法变体名被拒（400）', badVariant.status === 400, `HTTP ${badVariant.status}`);
}

{
  // 隔离：让 outsider 去读另一个团队作品的图
  const otherUpload = await uploadImage(admin, project2Id, 'other.png');
  const otherFileId = otherUpload.body?.uploaded?.[0]?.id;
  const denied = await outsider.request('GET', `/files/${otherFileId}/media/thumb`);
  record('隔离', '非本团队成员读图返回 404（不泄露存在性）', denied.status === 404, `HTTP ${denied.status}`);
}

// ── 五、改名 / 删除 ─────────────────────────────────────────
console.log('\n五、改名与删除');

{
  const fileId = fileIds.get('page10.png');

  // 第一刀：改名成 page0 —— 它应该从队尾**移动到队首**，
  // 这才证明「改的是排序位置，而不只是显示名」。
  const renamed = await admin.patch(`/files/${fileId}`, { name: 'page0.png' });
  record('改名', '重命名成功', renamed.status === 200, JSON.stringify(renamed.body));

  const afterFirst = await admin.get(`/projects/${projectId}/files`);
  const firstNames = afterFirst.body?.files?.map((f) => f.name) ?? [];
  record(
    '改名',
    '改名后排序位置随之变化（page0 排到最前）',
    JSON.stringify(firstNames) === JSON.stringify(['page0.png', 'page1.png', 'page2.png']),
    JSON.stringify(firstNames),
  );

  // 第二刀：page0 → page03。**零填充的数字要按数值比**：
  // page03 是第 3 页，所以它该排在 page2 之后，而不是按字符串排在前面。
  // 这条断言守的是 naturalSortKey 的补零逻辑 —— 页码顺序错了，
  // 翻校时整部作品的页序就是乱的。
  await admin.patch(`/files/${fileId}`, { name: 'page03.png' });
  const afterSecond = await admin.get(`/projects/${projectId}/files`);
  const secondNames = afterSecond.body?.files?.map((f) => f.name) ?? [];
  record(
    '排序',
    '零填充按数值比较（page03 排在 page2 之后）',
    JSON.stringify(secondNames) === JSON.stringify(['page1.png', 'page2.png', 'page03.png']),
    JSON.stringify(secondNames),
  );

  const history = await admin.get(`/files/${fileId}`);
  record(
    '状态',
    '文件带状态流水（入库一条）',
    history.body?.history?.some((h) => h.to === 'sourced'),
    JSON.stringify(history.body?.history),
  );
}

{
  const removed = await admin.del(`/files/${fileIds.get('page1.png')}`);
  record('删除', '软删除成功', removed.status === 200, `HTTP ${removed.status}`);

  const list = await admin.get(`/projects/${projectId}/files`);
  record('删除', '删除后不在默认列表中', list.body?.files?.length === 2, `剩余 ${list.body?.files?.length}`);

  const withDeleted = await admin.get(`/projects/${projectId}/files?includeDeleted=1`);
  record('删除', '带 includeDeleted 时仍可见（软删除）', withDeleted.body?.files?.length === 3, `含删除 ${withDeleted.body?.files?.length}`);

  const media = await admin.request('GET', `/files/${fileIds.get('page1.png')}/media/thumb`);
  record('删除', '已删除的图不再提供字节（404）', media.status === 404, `HTTP ${media.status}`);
}

// ── 六、目标语言 ────────────────────────────────────────────
console.log('\n六、目标语言');

{
  const added = await admin.post(`/projects/${projectId}/targets`, { language: 'zh-TW' });
  record('目标语言', '新增 zh-TW', added.status === 201, JSON.stringify(added.body));

  const dup = await admin.post(`/projects/${projectId}/targets`, { language: 'zh-TW' });
  record('目标语言', '重复新增被拒（409）', dup.status === 409, `HTTP ${dup.status}`);

  const alias = await admin.post(`/projects/${projectId}/targets`, { language: 'zh_CN' });
  record('目标语言', '别名写法被归一化后识别为重复（409）', alias.status === 409, `HTTP ${alias.status}`);

  const beforeDelete = await admin.get(`/projects/${projectId}`);
  const target = beforeDelete.body?.targets?.find((t) => t.language === 'zh-TW');
  const removed = await admin.del(`/projects/${projectId}/targets/${target?.id}`);
  record('目标语言', '删除 zh-TW', removed.status === 200, `HTTP ${removed.status}`);
}

// ── 七、工作台 / 动态 / 用量 ────────────────────────────────
console.log('\n七、工作台、动态与用量');

{
  const workbench = await admin.get('/workbench');
  const card = workbench.body?.projects?.find((p) => p.id === projectId);
  record('工作台', '工作台返回该作品', Boolean(card), `共 ${workbench.body?.projects?.length} 部`);
  // 到这里上传过 3 张，其中 1 张已被软删除 —— 进度只算**在册**的图，
  // 删掉的页面不该继续拖着作品的状态。所以这里要的是 2 而不是 3。
  record(
    '工作台',
    '进度只计在册图片（上传 3 删 1 → 2 页）',
    card?.progress?.fileCount === 2 && card?.progress?.translatedCount === 0,
    JSON.stringify(card?.progress),
  );
  record('工作台', '档位为「翻译中」', card?.stage === 'translating', String(card?.stage));
  record(
    '工作台',
    'chips 计数包含该作品',
    (workbench.body?.counts?.translating ?? 0) >= 1,
    JSON.stringify(workbench.body?.counts),
  );
  // 作品卡上那块图是整张卡片的信息重心。没指定封面时应该自动用第一页，
  // 否则工作台就是一排占位框。
  record(
    '工作台',
    '未指定封面时自动取第一页',
    typeof card?.coverFileId === 'string' && card.coverFileId.length > 0,
    String(card?.coverFileId),
  );

  const filtered = await admin.get('/workbench?stage=published');
  record(
    '工作台',
    '按档位筛选生效',
    !filtered.body?.projects?.some((p) => p.id === projectId),
    `${filtered.body?.projects?.length} 部已发布`,
  );

  const ofTeam = await admin.get(`/teams/${teamId}/projects`);
  record(
    '作品列表',
    '团队作品列表含该作品',
    ofTeam.body?.projects?.some((p) => p.id === projectId),
    `${ofTeam.body?.projects?.length} 部`,
  );
}

{
  const activity = await admin.get(`/activity?teamId=${teamId}`);
  const actions = activity.body?.activity?.map((a) => a.action) ?? [];
  record('动态', '团队动态含上传记录', actions.includes('file.upload'), JSON.stringify(actions.slice(0, 8)));
  record(
    '动态',
    '动态已渲染成中文句子（不是原始动作名）',
    activity.body?.activity?.every((a) => typeof a.text === 'string' && !a.text.includes('undefined')),
    JSON.stringify(activity.body?.activity?.[0]?.text),
  );
  // 兜底文案（「…执行了操作：」）出现即说明**有动作漏了描述映射** ——
  // 那在界面上就是一行带英文动作名的天书。这条断言是给「加功能忘了补动态文案」兜底的。
  const unmapped = activity.body?.activity?.filter((a) => a.text.includes('执行了操作：')) ?? [];
  record(
    '动态',
    '本流程涉及的动作都有中文描述（没有落进兜底文案）',
    unmapped.length === 0,
    JSON.stringify(unmapped.map((a) => a.action)),
  );

  const memberView = await outsider.get(`/activity?teamId=${teamId}`);
  record('动态', '团队成员可读团队动态', memberView.status === 200, `HTTP ${memberView.status}`);

  const otherTeam = await outsider.get(`/activity?teamId=${team2Id}`);
  record('隔离', '成员读别的团队的动态返回 404', otherTeam.status === 404, `HTTP ${otherTeam.status}`);
}

{
  const usage = await admin.get(`/teams/${teamId}/storage`);
  record(
    '用量',
    '团队用量按数据库求和非零',
    usage.status === 200 && usage.body?.team?.fileCount >= 2 && usage.body?.team?.usedBytes > 0,
    JSON.stringify(usage.body?.team),
  );

  const siteUsage = await admin.get('/admin/storage-usage');
  record(
    '用量',
    '站点用量返回磁盘余量与分团队统计',
    siteUsage.status === 200 &&
      typeof siteUsage.body?.disk?.usedBytes === 'number' &&
      Array.isArray(siteUsage.body?.byTeam),
    JSON.stringify(siteUsage.body?.disk),
  );
}

// ── 八、作品成员 ────────────────────────────────────────────
console.log('\n八、作品成员');

{
  const candidates = await admin.get(`/projects/${projectId}/member-candidates`);
  record(
    '作品成员',
    '候选列表含团队成员且不含创建人',
    candidates.status === 200 &&
      candidates.body?.candidates?.some((c) => c.userId === memberUserId) &&
      !candidates.body.candidates.some((c) => c.roleName === '创建人'),
    JSON.stringify(candidates.body?.candidates?.map((c) => c.displayName)),
  );

  const roleList = await admin.get(`/projects/${projectId}`);
  const translatorRole = roleList.body?.roles?.find((r) => r.systemCode === 'translator');
  const added = await admin.post(`/projects/${projectId}/members`, {
    userId: memberUserId,
    projectRoleId: translatorRole?.id,
  });
  record('作品成员', '把成员加为「翻译」', added.status === 201, JSON.stringify(added.body));

  const members = await admin.get(`/projects/${projectId}/members`);
  record(
    '作品成员',
    '成员列表显示其作品角色',
    members.body?.members?.some((m) => m.userId === memberUserId && m.roleSystemCode === 'translator'),
    JSON.stringify(members.body?.members?.map((m) => `${m.displayName}:${m.roleName}`)),
  );

  const memberDetail = await outsider.get(`/projects/${projectId}`);
  record(
    '作品成员',
    '获得作品角色后，该成员拿到对应权限码',
    memberDetail.body?.my?.permissions?.includes('tra.add') &&
      memberDetail.body?.my?.permissions?.includes('file.add'),
    JSON.stringify(memberDetail.body?.my?.permissions),
  );
  record(
    '作品成员',
    '翻译角色不含删除图片权限',
    !memberDetail.body?.my?.permissions?.includes('file.delete'),
    JSON.stringify(memberDetail.body?.my?.permissions),
  );

  // 现在他是「翻译」，可以上传了 —— 验证权限链真的通了，而不只是权限码列表好看。
  const canUploadNow = await uploadImage(outsider, projectId, 'by-translator.png', makePng(40, 60, [10, 20, 30]));
  record('作品成员', '获得 file.add 后可以上传', canUploadNow.status === 201, JSON.stringify(canUploadNow.body));

  const removeCreator = await admin
    .del(`/projects/${projectId}/members/${detail.body?.project?.members?.find((m) => m.roleName === '创建人')?.userId}`)
    .catch(() => ({ status: 0 }));
  record('作品成员', '创建人不可被移出作品（403）', removeCreator.status === 403, `HTTP ${removeCreator.status}`);

  const removed = await admin.del(`/projects/${projectId}/members/${memberUserId}`);
  record('作品成员', '移出成员成功', removed.status === 200, `HTTP ${removed.status}`);

  const afterRemove = await outsider.get(`/projects/${projectId}`);
  record(
    '作品成员',
    '移出后作品权限码被收回',
    afterRemove.body?.my?.permissions?.length === 0,
    JSON.stringify(afterRemove.body?.my?.permissions),
  );
}

// ── 九、归档 ────────────────────────────────────────────────
console.log('\n九、结项归档');

{
  const archived = await admin.post(`/projects/${projectId}/archive`);
  record('归档', '结项归档成功', archived.status === 200, `HTTP ${archived.status}`);

  const workbench = await admin.get('/workbench');
  record(
    '归档',
    '归档作品不出现在工作台默认列表',
    !workbench.body?.projects?.some((p) => p.id === projectId),
    '',
  );

  const archivedList = await admin.get('/workbench?status=archived');
  record(
    '归档',
    '显式查归档时可见',
    archivedList.body?.projects?.some((p) => p.id === projectId),
    '',
  );

  await admin.post(`/projects/${projectId}/unarchive`);
  const back = await admin.get('/workbench');
  record('归档', '取消归档后回到列表', back.body?.projects?.some((p) => p.id === projectId), '');
}

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('M2 全部通过。');
