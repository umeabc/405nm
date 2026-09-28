#!/usr/bin/env node
/**
 * M1 端到端验证：身份 / 团队 / 角色权限 / 邀请码 / 站点后台。
 *
 *   node tests/m1-verify.mjs [baseUrl]
 *
 * 在测试机上跑（脚本在容器网络里，所以直接打 backend:3000）：
 *   docker compose -f deploy/docker-compose.yml run --rm \
 *     -v /opt/405nm/tests:/tests:ro backend node /tests/m1-verify.mjs
 *
 * 这是回归脚本的雏形：自带数据、自建自清、断言用中文说明、失败即以非零码退出。
 * 后续 M2+ 的接口验证继续往这里加分组。
 */

const BASE = (process.argv[2] ?? 'http://backend:3000/api').replace(/\/$/, '');

const ADMIN_USERNAME = process.env.M1_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.M1_ADMIN_PASSWORD ?? '';

const RUN_ID = Date.now().toString(36);
const TEAM_NAME = `验证组-${RUN_ID}`;
const MEMBER_USERNAME = `verify_${RUN_ID}`;
const MEMBER_PASSWORD = 'verify-pass-123';

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

/** 带 cookie jar 的极简客户端。 */
class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }

  async request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
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
    return { status: res.status, body: json };
  }

  get = (p) => this.request('GET', p);
  post = (p, b) => this.request('POST', p, b);
  patch = (p, b) => this.request('PATCH', p, b);
  put = (p, b) => this.request('PUT', p, b);
  del = (p) => this.request('DELETE', p);
}

const admin = new Client('admin');
const member = new Client('member');
const anon = new Client('anon');

console.log(`\n405nm M1 验证 —— ${BASE}\n`);

// ── 一、错误信封 ────────────────────────────────────────────
console.log('一、错误信封与鉴权');

{
  const res = await anon.post('/auth/login', {});
  record('信封', '参数缺失返回业务错误信封（不含 Fastify 的 statusCode 字段）',
    res.status === 400 && res.body?.error && res.body?.message && res.body.statusCode === undefined,
    JSON.stringify(res.body));

  const me = await anon.get('/auth/me');
  record('鉴权', '未登录访问 /auth/me 返回 401', me.status === 401, `HTTP ${me.status}`);

  const teams = await anon.get('/teams');
  record('鉴权', '未登录访问 /teams 返回 401', teams.status === 401, `HTTP ${teams.status}`);

  const nope = await anon.get('/definitely-not-a-route');
  record('信封', '未知路由返回 404 NOT_FOUND', nope.status === 404 && nope.body?.error === 'NOT_FOUND');
}

if (!ADMIN_PASSWORD) {
  console.error('\n未提供 M1_ADMIN_PASSWORD，无法继续。');
  process.exit(2);
}

const login = await admin.post('/auth/login', {
  username: ADMIN_USERNAME,
  password: ADMIN_PASSWORD,
});
if (login.status !== 200) {
  console.error(`\n管理员登录失败（HTTP ${login.status}）：${JSON.stringify(login.body)}`);
  process.exit(2);
}

// ── 二、团队与系统角色 ──────────────────────────────────────
console.log('\n二、团队与系统角色');

const teamRes = await admin.post('/teams', { name: TEAM_NAME, intro: 'M1 自动验证' });
record('团队', '创建团队返回 201', teamRes.status === 201, `HTTP ${teamRes.status}`);
const teamId = teamRes.body?.team?.id;
if (!teamId) {
  console.error('未能取得 teamId，后续验证无法进行。');
  process.exit(2);
}

const rolesRes = await admin.get(`/teams/${teamId}/roles`);
const roles = rolesRes.body?.roles ?? [];
record('团队', '建团队时自动生成 5 个系统角色', roles.length === 5, `实际 ${roles.length}`);
record('团队', '角色等级覆盖 100/200/300/400/500',
  [100, 200, 300, 400, 500].every((lv) => roles.some((r) => r.level === lv)),
  roles.map((r) => `${r.name}=${r.level}`).join(' '));

const creatorRole = roles.find((r) => r.systemCode === 'creator');
const adminRole = roles.find((r) => r.systemCode === 'admin');
record('团队', '创建人角色自动持有项目管理员开关', creatorRole?.autoProjectAdmin === true);
record('团队', '管理员角色不含「解散团队」（那是创建人保留动作）',
  adminRole ? !adminRole.permissions.includes('team.delete') : false);
record('团队', '创建人角色持有全部团队权限', (creatorRole?.permissions?.length ?? 0) >= 20,
  `实际 ${creatorRole?.permissions?.length}`);

const permsRes = await admin.get('/permissions');
record('团队', '权限目录可读且含团队域与项目域',
  (permsRes.body?.permissions ?? []).some((p) => p.scope === 'team')
  && (permsRes.body?.permissions ?? []).some((p) => p.scope === 'project'));

// ── 三、邀请码与注册入团 ────────────────────────────────────
console.log('\n三、邀请码与注册入团');

const inviteRes = await admin.post(`/teams/${teamId}/invites`, { maxUses: 3, note: 'M1 验证' });
const inviteCode = inviteRes.body?.invites?.[0]?.code;
record('邀请码', '生成邀请码返回 201 且形如 XXXX-XXXX-XXXX',
  inviteRes.status === 201 && /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(inviteCode ?? ''),
  String(inviteCode));

const lowerCode = (inviteCode ?? '').toLowerCase();
const regRes = await member.post('/auth/register', {
  username: MEMBER_USERNAME,
  password: MEMBER_PASSWORD,
  displayName: '验证成员',
  inviteCode: lowerCode,
});
record('邀请码', '邀请码大小写不敏感（全小写也能注册成功）',
  regRes.status === 200 && regRes.body?.user?.username === MEMBER_USERNAME,
  `HTTP ${regRes.status} ${JSON.stringify(regRes.body)}`);

const myTeams = await member.get('/teams');
const joined = (myTeams.body?.teams ?? [])[0];
record('邀请码', '注册后自动加入邀请码绑定的团队', joined?.id === teamId);
record('邀请码', '入团角色为团队默认角色（见习成员/100）',
  joined?.myRole?.systemCode === 'beginner' && joined?.myRole?.level === 100,
  JSON.stringify(joined?.myRole));

const reuse = await anon.post('/auth/register', {
  username: `verify2_${RUN_ID}`,
  password: MEMBER_PASSWORD,
  inviteCode: inviteCode,
});
record('邀请码', '同一邀请码在剩余次数内可再次使用（多次使用）', reuse.status === 200, `HTTP ${reuse.status}`);

const badInvite = await anon.post('/auth/register', {
  username: `verify3_${RUN_ID}`,
  password: MEMBER_PASSWORD,
  inviteCode: 'AAAA-BBBB-CCCC',
});
record('邀请码', '无效邀请码被拒且给出具体原因',
  badInvite.status === 400 && badInvite.body?.error === 'INVITE_INVALID',
  JSON.stringify(badInvite.body));

// ── 四、权限守卫 ────────────────────────────────────────────
console.log('\n四、权限守卫（见习成员）');

const denyInvite = await member.post(`/teams/${teamId}/invites`, { maxUses: 1 });
record('权限', '见习成员不能生成邀请码（403）', denyInvite.status === 403, `HTTP ${denyInvite.status}`);

const denyRole = await member.post(`/teams/${teamId}/roles`, {
  name: '越权角色',
  level: 400,
  permissions: ['team.access'],
});
record('权限', '见习成员不能创建角色（403）', denyRole.status === 403, `HTTP ${denyRole.status}`);

const denyMembers = await member.get(`/teams/${teamId}/invites`);
record('权限', '见习成员不能查看邀请码列表（403）', denyMembers.status === 403, `HTTP ${denyMembers.status}`);

// ── 五、等级守卫（提权路径）────────────────────────────────
console.log('\n五、等级守卫（把成员提为管理员后逐条试提权）');

const membersRes = await admin.get(`/teams/${teamId}/members`);
const memberRow = (membersRes.body?.members ?? []).find((m) => m.username === MEMBER_USERNAME);
record('等级', '成员列表可查到新成员且带角色等级', Boolean(memberRow) && memberRow.roleLevel === 100,
  JSON.stringify(memberRow ?? {}));

const promote = await admin.patch(`/teams/${teamId}/members/${memberRow?.userId}`, {
  roleId: adminRole?.id,
});
record('等级', '创建人可把成员提升为管理员', promote.status === 200, `HTTP ${promote.status} ${JSON.stringify(promote.body)}`);

const promoteCheck = await member.get('/teams');
record('等级', '提升后该成员角色变为管理员/400',
  (promoteCheck.body?.teams ?? [])[0]?.myRole?.level === 400,
  JSON.stringify((promoteCheck.body?.teams ?? [])[0]?.myRole));

const sameLevel = await member.post(`/teams/${teamId}/roles`, {
  name: '同级角色',
  level: 400,
  permissions: ['team.access'],
});
record('提权', '管理员不能创建与自己同级的角色（403）', sameLevel.status === 403, `HTTP ${sameLevel.status}`);

const overPerm = await member.post(`/teams/${teamId}/roles`, {
  name: '越权权限',
  level: 250,
  permissions: ['team.access', 'team.delete'],
});
record('提权', '不能授出自己没有的权限（team.delete）（403）', overPerm.status === 403, `HTTP ${overPerm.status}`);

const okRole = await member.post(`/teams/${teamId}/roles`, {
  name: '实习校对',
  level: 250,
  permissions: ['team.access', 'project.create'],
});
record('提权', '等级更低且权限是自己子集时可以创建（201）', okRole.status === 201, `HTTP ${okRole.status} ${JSON.stringify(okRole.body)}`);

const touchCreator = await member.patch(`/teams/${teamId}/members/${(membersRes.body?.members ?? []).find((m) => m.username === ADMIN_USERNAME)?.userId}`, {
  roleId: creatorRole?.id,
});
record('提权', '不能改动团队创建人的角色（403）', touchCreator.status === 403, `HTTP ${touchCreator.status}`);

const selfToCreator = await member.patch(`/teams/${teamId}/members/${memberRow?.userId}`, {
  roleId: creatorRole?.id,
});
record('提权', '不能把自己提为创建人（403）', selfToCreator.status === 403, `HTTP ${selfToCreator.status}`);

const removeCreator = await member.del(`/teams/${teamId}/members/${(membersRes.body?.members ?? []).find((m) => m.username === ADMIN_USERNAME)?.userId}`);
record('提权', '不能移除团队创建人（403）', removeCreator.status === 403, `HTTP ${removeCreator.status}`);

// ── 六、站点后台 ────────────────────────────────────────────
console.log('\n六、站点后台');

const nonAdminUsers = await member.get('/admin/users');
record('后台', '非站点管理员访问用户管理被拒（403）', nonAdminUsers.status === 403, `HTTP ${nonAdminUsers.status}`);

const usersRes = await admin.get('/admin/users?q=admin');
record('后台', '用户列表可搜索', usersRes.status === 200 && (usersRes.body?.users ?? []).length >= 1);

const strictRes = await admin.patch(`/admin/users/${memberRow?.userId}`, { isSiteAdmin: true });
record('后台', '用户更新接口严格校验未知字段（不再静默忽略）', strictRes.status === 400,
  `HTTP ${strictRes.status} ${JSON.stringify(strictRes.body)}`);

const selfDemote = await admin.patch(`/admin/users/${(usersRes.body?.users ?? [])[0]?.id}/site-admin`, {
  isSiteAdmin: false,
});
record('后台', '站点管理员不能降级自己（400）', selfDemote.status === 400, `HTTP ${selfDemote.status}`);

const settings = await admin.put('/admin/settings', { 'site.name': '405nm' });
record('后台', '站点设置可写', settings.status === 200, `HTTP ${settings.status}`);

const publicSettings = await anon.get('/site/settings');
record('后台', '站点设置可公开读取（登录页要用）', publicSettings.status === 200 && publicSettings.body?.settings?.['site.name'] === '405nm');

const nonAdminSettings = await member.put('/admin/settings', { 'site.name': 'HACKED' });
record('后台', '非站点管理员不能改站点设置（403）', nonAdminSettings.status === 403, `HTTP ${nonAdminSettings.status}`);

const notice = await admin.post('/admin/notices', { title: 'M1 验证', content: '这是一条自动验证公告' });
record('后台', '可发布公告', notice.status === 201, `HTTP ${notice.status}`);

const unread = await member.get('/notices?scope=unread');
record('后台', '用户端能读到未读公告', (unread.body?.unread ?? 0) >= 1, `unread=${unread.body?.unread}`);

const markRead = await member.post('/notices/read', { all: true });
record('后台', '可标记全部已读', markRead.status === 200 && (markRead.body?.marked ?? 0) >= 1);

const unreadAfter = await member.get('/notices?scope=unread');
record('后台', '标记后未读数归零', unreadAfter.body?.unread === 0, `unread=${unreadAfter.body?.unread}`);

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('全部通过。');
console.log(`\n验证产生的数据：团队「${TEAM_NAME}」(${teamId})，成员 ${MEMBER_USERNAME} —— 保留下来供前端联调使用。`);
