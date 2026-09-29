/** 计划：用户 / 团队 / 团队角色 / 团队成员 / 公告 / 邀请码。 */
import { passwordAlgoOf } from '../auth/password.js';
import { normalizeInviteCode } from '../lib/validate.js';
import type { Plan } from './plan.js';
import { planMembers, planRoles, TEAM_ROLE_SPEC } from './plan-roles.js';
import type { Report } from './report.js';
import { mapTeamSystemCode } from './rules.js';
import { dateOr, ref, str, type MoeflowExport } from './source.js';

export async function planOrg(exp: MoeflowExport, plan: Plan, report: Report): Promise<void> {
  // ── 用户 ──
  plan.users = await exp.all('user');
  plan.userIds = new Set(plan.users.map((u) => u._id));
  plan.userByName = new Map();
  plan.userEmail = new Map();
  const emailSeen = new Set<string>();
  for (const u of plan.users) {
    const name = str(u.n).trim();
    if (name && !plan.userByName.has(name)) plan.userByName.set(name, u._id);
    // 本站邮箱唯一且统一小写；旧站按原样存，可能有只差大小写的两个账号
    const email = str(u.e).trim().toLowerCase();
    if (email && emailSeen.has(email)) {
      report.lose('user-email-duplicate', '邮箱与另一个旧账号只差大小写：保留先注册的，这个账号不带邮箱迁入（只能用用户名登录）', u._id);
    }
    plan.userEmail.set(u._id, email && !emailSeen.has(email) ? email : null);
    if (email) emailSeen.add(email);
    if (str(u.s).trim()) report.lose('user-signature', '个人签名：本站没有这个字段，不迁', u._id);
    if (str(u.a)) report.lose('user-avatar', '用户头像：不迁（文件留在旧存储，本人可重新上传）', u._id);
    const hash = str(u.p);
    if (!hash || passwordAlgoOf(hash) === 'unknown') {
      report.lose('user-password-unusable', '密码哈希缺失或格式不认识：该账号迁过去登不上，需要管理员重置密码', u._id);
    }
  }

  // ── 团队 ──
  plan.teams = await exp.all('team');
  plan.teamIds = new Set(plan.teams.map((t) => t._id));
  for (const t of plan.teams) {
    if (str(t.a)) report.lose('team-avatar', '团队头像：不迁（文件留在旧存储）', t._id);
    if ([t.om, t.ou, t.og, t.ot].some((v) => Number(v ?? 0) > 0)) {
      report.lose('team-ocr-quota', 'OCR 限额/用量：本站没有 OCR 功能，不迁', t._id, false);
    }
    if (Number(t.m_a) === 2) report.lose('team-open-apply', '「允许任何人申请加入」：本站只能凭邀请码或手工拉人入团', t._id, false);
  }

  plan.teamRoles = planRoles(TEAM_ROLE_SPEC, await exp.all('team_role'), plan.teams, report);
  plan.teamMembers = planMembers(await exp.all('team_user_relation'), plan.teamIds, plan.userIds, plan.teamRoles, report, 'team');

  // ── 公告与已读 ──
  plan.notices = await exp.all('notice');
  plan.noticeIds = new Set(plan.notices.map((n) => n._id));
  plan.noticeReads = [];
  const readSeen = new Set<string>();
  for (const doc of await exp.all('user_notice_read')) {
    const user = ref(doc.u);
    if (!user || !plan.userIds.has(user)) {
      report.lose('orphan-notice-read-user', '用户不迁移的公告已读记录：不迁', doc._id, false);
      continue;
    }
    for (const raw of Array.isArray(doc.r) ? doc.r : []) {
      const notice = ref(raw);
      if (!notice || !plan.noticeIds.has(notice)) {
        report.lose('orphan-notice-read-notice', '指向已删除公告的已读记录：不迁', `${doc._id}:${String(raw)}`, false);
        continue;
      }
      const key = `${notice}:${user}`;
      if (readSeen.has(key)) continue;
      readSeen.add(key);
      plan.noticeReads.push({ notice, user, readAt: dateOr(doc.ut, doc._id) });
    }
  }

  // ── 邀请码 ──
  plan.invites = [];
  const codeSeen = new Set<string>();
  for (const doc of await exp.all('invitation_code')) {
    const code = normalizeInviteCode(str(doc.c));
    if (!code) {
      report.lose('invite-empty-code', '邀请码为空：不迁', doc._id);
      continue;
    }
    if (codeSeen.has(code)) {
      report.lose('invite-duplicate-code', '邀请码忽略大小写后重复：只保留第一个', doc._id);
      continue;
    }
    const team = ref(doc.t);
    if (doc.t != null && (!team || !plan.teamIds.has(team))) {
      report.lose('orphan-invite', '所属团队不迁移的邀请码：不迁', doc._id);
      continue;
    }
    codeSeen.add(code);
    let roleId: string | null = null;
    const legacyRole = str(doc.r).trim();
    if (team && legacyRole) {
      const code405 = mapTeamSystemCode(legacyRole);
      roleId = code405 ? (plan.teamRoles.byCode.get(`${team}:${code405}`) ?? null) : null;
      if (!roleId) report.lose('invite-role-fallback', '邀请码指定的角色对不上：改为「用团队默认角色」', doc._id);
    }
    plan.invites.push({ doc, code, team, roleId });
  }
}
