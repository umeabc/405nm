/**
 * 旧库文档 → 本站数据行。**纯函数**（除了 `loadInputs` 那一次只读查询），
 * 迁移写库与迁移核验各调一遍，同一份输入必须得到同一份输出 ——
 * 这是「核验能证明迁移没错」的前提。
 *
 * 行类型直接取 Drizzle 的 `$inferInsert`：少写一层类型，也就少一处
 * 「schema 改了、迁移这边没跟上」的漏网。凡是建表里带默认值的列，这里都显式给值 ——
 * 让 `now()` 或 `gen_random_uuid()` 兜底的话，核验就没法把这一列算出来了。
 */
import { naturalSortKey } from '@405nm/shared';
import { isNull } from 'drizzle-orm';
import type { DbLike } from '../db/client.js';
import { PROJECT_ROLE_TEMPLATES } from '../domain/project-roles.js';
import { db } from '../db/client.js';
import {
  fileCredits,
  files,
  inviteCodes,
  noticeReads,
  notices,
  projectMembers,
  projectRolePermissions,
  projectRoles,
  projectSets,
  projects,
  rolePermissions,
  roles,
  targets,
  teamMembers,
  teams,
  users,
} from '../db/schema.js';
import { newFileKey } from '../storage/keys.js';
import { passwordAlgoOf } from '../auth/password.js';
import type { ContentPlan } from './plan-content.js';
import type { Plan } from './plan.js';
import type { Report } from './report.js';
import { displayNameOf, mapProjectStatus, pickUsername } from './rules.js';
import { dateOr, legacyRef, lid, num, oidTime, ref, str, uuidv5, type Doc } from './source.js';

export type UserRow = typeof users.$inferInsert;
export type TeamRow = typeof teams.$inferInsert;
export type RoleRow = typeof roles.$inferInsert;
export type TeamMemberRow = typeof teamMembers.$inferInsert;
export type ProjectSetRow = typeof projectSets.$inferInsert;
export type ProjectRow = typeof projects.$inferInsert;
export type ProjectRoleRow = typeof projectRoles.$inferInsert;
export type ProjectMemberRow = typeof projectMembers.$inferInsert;
export type TargetRow = typeof targets.$inferInsert;
export type NoticeRow = typeof notices.$inferInsert;
export type NoticeReadRow = typeof noticeReads.$inferInsert;
export type InviteRow = typeof inviteCodes.$inferInsert;
export type FileRow = typeof files.$inferInsert;
export type CreditRow = typeof fileCredits.$inferInsert;
export type PermissionRow = typeof rolePermissions.$inferInsert;
export type ProjectPermissionRow = typeof projectRolePermissions.$inferInsert;

/**
 * 只在本站存在、旧库没有的东西 —— 决定了「改名/编号」这类冲突处理的结果。
 * 一次读齐、迁移与核验共用，免得两边读到不同的时刻而得出不同的用户名。
 */
export type MigrationInputs = {
  usernames: Set<string>;
  emails: Set<string>;
  teamNames: Set<string>;
  /** 新团队 id → 站内已有的最大作品编号（迁移的编号从它往后排） */
  projectSerials: Map<string, number>;
  inviteCodes: Set<string>;
};

export async function loadInputs(tx: DbLike = db): Promise<MigrationInputs> {
  const nativeUsers = await tx
    .select({ username: users.username, email: users.email })
    .from(users)
    .where(isNull(users.legacyId));
  const nativeTeams = await tx.select({ id: teams.id, name: teams.name }).from(teams).where(isNull(teams.legacyId));
  const nativeProjects = await tx
    .select({ teamId: projects.teamId, serial: projects.serial })
    .from(projects)
    .where(isNull(projects.legacyId));
  // 只看**本站自己发的**邀请码：把迁移来的也算进来，重跑时每个码都会「和自己冲突」
  const nativeInvites = await tx
    .select({ code: inviteCodes.code })
    .from(inviteCodes)
    .where(isNull(inviteCodes.legacyId));

  const projectSerials = new Map<string, number>();
  for (const row of nativeProjects) {
    projectSerials.set(row.teamId, Math.max(projectSerials.get(row.teamId) ?? 0, row.serial));
  }
  return {
    usernames: new Set(nativeUsers.map((u) => u.username)),
    emails: new Set(nativeUsers.map((u) => u.email).filter((e): e is string => !!e)),
    teamNames: new Set(nativeTeams.map((t) => t.name)),
    projectSerials,
    inviteCodes: new Set(nativeInvites.map((i) => i.code)),
  };
}

// ── 三个「站内唯一」的字段：用户名 / 团队名 / 作品编号 ─────

/**
 * 用户名（登录用）。昵称原样保留，**改的只是登录名** ——
 * 旧站对用户名几乎没有限制（空格、斜杠、超长都收），本站是 `[\w.\-一-龥]{3,32}`。
 */
export function assignUsernames(plan: Plan, inputs: MigrationInputs, report: Report): Map<string, string> {
  const taken = new Set(inputs.usernames);
  const out = new Map<string, string>();
  for (const u of plan.users) {
    const legacy = str(u.n).trim();
    const username = pickUsername(legacy, u._id, taken);
    taken.add(username);
    if (username !== legacy) {
      report.lose('user-renamed', '旧站用户名在本站不合规或已被占用：登录名改写，昵称仍显示原标题里', u._id, false);
    }
    out.set(u._id, username);
  }
  return out;
}

/** 邮箱。本站唯一且统一小写；撞上站内已有邮箱时只保留用户名登录，不静默改邮箱。 */
export function assignEmails(plan: Plan, inputs: MigrationInputs, report: Report): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const u of plan.users) {
    const email = plan.userEmail.get(u._id) ?? null;
    if (email && inputs.emails.has(email)) {
      report.lose('user-email-taken', '邮箱已被本站另一个账号占用：这个账号不带邮箱迁入（只能用用户名登录）', u._id);
      out.set(u._id, null);
      continue;
    }
    out.set(u._id, email);
  }
  return out;
}

export function assignTeamNames(plan: Plan, inputs: MigrationInputs, report: Report): Map<string, string> {
  const taken = new Set(inputs.teamNames);
  const out = new Map<string, string>();
  for (const t of plan.teams) {
    const base = str(t.n).trim() || `团队_${t._id.slice(-6)}`;
    let name = base;
    for (let n = 1; taken.has(name); n += 1) name = n === 1 ? `${base}（旧站）` : `${base}（旧站${n}）`;
    if (name !== base) report.lose('team-renamed', '团队名与本站已有团队重名：加「（旧站）」后缀', t._id, false);
    taken.add(name);
    out.set(t._id, name);
  }
  return out;
}

/** 作品编号按「团队内、旧库创建顺序」接着站内已有的最大值往后排。 */
export function assignSerials(plan: Plan, inputs: MigrationInputs): Map<string, number> {
  const next = new Map(inputs.projectSerials);
  const out = new Map<string, number>();
  for (const p of plan.projects) {
    const teamId = lid('team', plan.projectTeam.get(p._id)!);
    const serial = (next.get(teamId) ?? 0) + 1;
    next.set(teamId, serial);
    out.set(p._id, serial);
  }
  return out;
}

/** 新团队建作品时要用的项目角色模板：id 也按确定性规则生成，核验才算得出来。 */
export const projectTemplateId = (teamOid: string, code: string): string =>
  uuidv5(`moeflow:project_role_template:${code}@${teamOid}`);

/** 一次算齐「取决于站内现状」的那些字段：迁移与核验共用同一份，结论才不会两边不同。 */
export type Derived = {
  inputs: MigrationInputs;
  usernames: Map<string, string>;
  emails: Map<string, string | null>;
  teamNames: Map<string, string>;
  serials: Map<string, number>;
};

export async function derive(tx: DbLike, plan: Plan, report: Report): Promise<Derived> {
  const inputs = await loadInputs(tx);
  return {
    inputs,
    usernames: assignUsernames(plan, inputs, report),
    emails: assignEmails(plan, inputs, report),
    teamNames: assignTeamNames(plan, inputs, report),
    serials: assignSerials(plan, inputs),
  };
}

// ── 行 ──────────────────────────────────────────────────────

export function userRow(doc: Doc, username: string, email: string | null): UserRow {
  const created = dateOr(doc.c, doc._id);
  return {
    id: lid('user', doc._id),
    username,
    email,
    displayName: displayNameOf(doc.n, doc._id),
    // 旧站的哈希**原样搬**：登录时校验通过再就地升级成本站的 scrypt（见 routes/auth.ts）。
    // 迁过来就用不了的哈希（格式不认识）在计划阶段已经记过有损点。
    passwordHash: str(doc.p),
    passwordAlgo: passwordAlgoOf(str(doc.p)),
    avatarKey: null,
    isSiteAdmin: doc.admin === true,
    status: doc.b === true ? 'disabled' : 'active',
    legacyId: legacyRef('user', doc._id),
    createdAt: created,
    updatedAt: created,
  };
}

export function teamRow(doc: Doc, name: string, plan: Plan, inputs: MigrationInputs): TeamRow {
  const maxMembers = Math.trunc(num(doc.u, 100000));
  const migrated = plan.projects.filter((p) => plan.projectTeam.get(p._id) === doc._id).length;
  const created = dateOr(doc.m_c, doc._id);
  return {
    id: lid('team', doc._id),
    name,
    intro: str(doc.i),
    avatarKey: null,
    defaultRoleId: plan.teamRoles.defaultRole.get(doc._id) ?? null,
    // 旧站的 100000 就是「不限」；直接搬过来的话，界面上会显示成一个人数上限
    maxMembers: maxMembers < 100000 ? maxMembers : null,
    // 编号游标要越过迁进来的作品，否则本站新建作品会撞 (team, serial) 唯一键
    projectSeq: (inputs.projectSerials.get(lid('team', doc._id)) ?? 0) + migrated,
    status: 'active',
    legacyId: legacyRef('team', doc._id),
    createdAt: created,
    updatedAt: dateOr(doc.m_e, doc._id),
  };
}

export function teamMemberRows(plan: Plan): TeamMemberRow[] {
  return plan.teamMembers.map((m) => ({
    teamId: lid('team', m.group),
    userId: lid('user', m.user),
    roleId: m.roleId,
    createdAt: m.createdAt,
  }));
}

export function projectSetRows(plan: Plan): ProjectSetRow[] {
  return plan.projectSets.map((s) => ({
    id: lid('project_set', s._id),
    teamId: lid('team', plan.projectSetTeam.get(s._id) ?? s._id),
    name: plan.projectSetName.get(s._id)!,
    intro: str(s.i),
    orderIndex: plan.projectSetOrder.get(s._id) ?? 0,
    coverFileId: null,
    createdBy: null,
    legacyId: legacyRef('project_set', s._id),
    createdAt: dateOr(s.ct, s._id),
    updatedAt: dateOr(s.et, s._id),
  }));
}

export function projectRows(plan: Plan, serials: Map<string, number>): ProjectRow[] {
  return plan.projects.map((p) => {
    const original = str(p.sn).trim();
    const translated = str(p.tn).trim();
    const lines = [str(p.i).trim()];
    // 本站作品没有「原名/译名」两个字段，并进简介末尾 —— 丢掉的话，
    // 「原名：xxx」这种信息在库上就再也找不回来了。
    if (original) lines.push(`原名：${original}`);
    if (translated) lines.push(`译名：${translated}`);
    const status = mapProjectStatus(p.st);
    const creator = plan.projectCreator.get(p._id);
    const setId = plan.projectSet.get(p._id) ?? null;
    return {
      id: lid('project', p._id),
      teamId: lid('team', plan.projectTeam.get(p._id)!),
      setId: setId ? lid('project_set', setId) : null,
      serial: serials.get(p._id) ?? 1,
      name: str(p.n).trim() || `作品_${p._id.slice(-6)}`,
      intro: lines.filter(Boolean).join('\n'),
      author: '',
      sourceLanguage: plan.projectLanguage.get(p._id) ?? 'und',
      coverFileId: null,
      status,
      archivedAt: status === 'archived' ? firstDate([p.ft, p.pft, p.pdt, p.m_e], p._id) : null,
      createdBy: creator ? lid('user', creator) : null,
      legacyId: legacyRef('project', p._id),
      createdAt: dateOr(p.m_c, p._id),
      updatedAt: dateOr(p.m_e, p._id),
    };
  });
}

export function noticeRows(plan: Plan): NoticeRow[] {
  return plan.notices.map((n) => {
    const created = dateOr(n.ct, n._id);
    const cu = ref(n.cu);
    return {
      id: lid('notice', n._id),
      title: str(n.t).trim(),
      content: str(n.c),
      enabled: n.e !== false,
      createdBy: cu && plan.userIds.has(cu) ? lid('user', cu) : null,
      createdAt: created,
      updatedAt: created,
    };
  });
}

export function noticeReadRows(plan: Plan): NoticeReadRow[] {
  return plan.noticeReads.map((r) => ({
    noticeId: lid('notice', r.notice),
    userId: lid('user', r.user),
    readAt: r.readAt,
  }));
}

export function inviteRows(plan: Plan): InviteRow[] {
  return plan.invites.map(({ doc, code, team, roleId }) => {
    const cu = ref(doc.cu);
    return {
      id: lid('invitation_code', doc._id),
      code,
      teamId: team ? lid('team', team) : null,
      roleId,
      // 旧站没有次数与有效期：本站也用「不限次、不过期」承接，语义一致
      maxUses: null,
      usedCount: Math.trunc(num(doc.u, 0)),
      expiresAt: null,
      enabled: doc.e !== false,
      note: '',
      createdBy: cu && plan.userIds.has(cu) ? lid('user', cu) : null,
      createdAt: dateOr(doc.ct, doc._id),
      legacyId: legacyRef('invitation_code', doc._id),
    };
  });
}

// ── 文件与署名 ──────────────────────────────────────────────

/** 图片字节给出的事实。**必须来自真实字节**：旧站的 `fs` 字段单位是 KB，凑不出精确字节数。 */
export type FileFacts = { ext: string; size: number; md5: string; sha256: string; width: number; height: number };

/** 修订链深度（首版 = 1）。带环保护：旧库理论上不该有环，真有也不能让迁移卡死。 */
function revisionDepth(oid: string, plan: Plan): number {
  const seen = new Set([oid]);
  let depth = 1;
  let cur = oid;
  for (;;) {
    const prev = plan.fileOldRevision.get(cur);
    if (!prev || seen.has(prev)) return depth;
    seen.add(prev);
    depth += 1;
    cur = prev;
  }
}

export function fileRow(doc: Doc, plan: Plan, content: ContentPlan, facts: FileFacts): FileRow {
  const project = plan.fileProject.get(doc._id)!;
  const root = plan.fileRoot.get(doc._id) ?? doc._id;
  const prev = plan.fileOldRevision.get(doc._id) ?? null;
  const name = str(doc.n).trim() || `file_${doc._id.slice(-6)}`;
  const created = oidTime(doc._id);
  return {
    id: lid('file', doc._id),
    teamId: lid('team', plan.projectTeam.get(project)!),
    projectId: lid('project', project),
    name,
    sortName: naturalSortKey(name),
    // 键由 id + 扩展名 + 入库时间派生：重跑得到同一个键，缺字节时也能先把行写上（占位）
    storageKey: newFileKey(lid('file', doc._id), facts.ext, created),
    size: facts.size,
    width: facts.width,
    height: facts.height,
    md5: facts.md5,
    sha256: facts.sha256,
    state: content.fileState.get(doc._id) ?? 'sourced',
    revision: revisionDepth(doc._id, plan),
    parentId: lid('file', root),
    oldRevisionId: prev ? lid('file', prev) : null,
    activated: doc.ac !== false,
    uploadedBy: null,
    legacyId: legacyRef('file', doc._id),
    createdAt: created,
    updatedAt: dateOr(doc.et, doc._id),
    deletedAt: null,
  };
}

/**
 * 署名台账行。**按计划顺序插入**，`seq` 由序列分配 —— 显示顺序就是插入顺序，
 * 这一点是全案最容易被忽略的：旧站的署名是一个自由文本串，顺序即显示顺序，
 * 台账按 `seq` 排序回拼，插入时乱序就等于悄悄改了署名。
 */
export function creditRows(doc: Doc, plan: Plan, createdAt: Date): CreditRow[] {
  const file = doc._id;
  const project = plan.fileProject.get(file)!;
  const teamId = lid('team', plan.projectTeam.get(project)!);
  return (plan.credits.get(file) ?? []).map((c) => ({
    id: c.id,
    fileId: lid('file', file),
    teamId,
    role: c.role,
    userId: c.userOid ? lid('user', c.userOid) : null,
    displayName: c.name,
    source: 'manual',
    createdBy: null,
    createdAt,
  }));
}

/** 归档时间：旧站有四个「结束」时间字段，谁先有值用谁，都没有就退到 ObjectId 时间。 */
export function inviteConflicts(plan: Plan, inputs: MigrationInputs): string[] {
  return inviteRows(plan)
    .map((row) => row.code)
    .filter((code) => inputs.inviteCodes.has(code));
}

/** 归档时间：旧站有四个「结束」时间字段，谁先有值用谁，都没有就退到 ObjectId 时间。 */
function firstDate(values: readonly unknown[], oid: string): Date {
  for (const v of values) {
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  }
  return oidTime(oid);
}

/** 团队角色（每个团队一套）+ 它们的权限行。 */
export function teamRoleRows(plan: Plan): { roles: RoleRow[]; permissions: PermissionRow[] } {
  const roleRows: RoleRow[] = [];
  const permissions: PermissionRow[] = [];
  for (const inst of plan.teamRoles.roles) {
    roleRows.push({
      id: inst.id,
      scope: 'team',
      teamId: lid('team', inst.group),
      name: inst.name,
      level: inst.level,
      intro: inst.intro,
      isSystem: inst.code !== null,
      systemCode: inst.code,
      autoProjectAdmin: inst.autoProjectAdmin,
      legacyId: inst.legacyId,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
    });
    for (const code of inst.permissions) permissions.push({ roleId: inst.id, permissionCode: code });
  }
  return { roles: roleRows, permissions };
}

/**
 * 项目角色**模板**（`roles` 表里 scope='project' 的那批）：本站建作品时会照它实例化一套作品角色，
 * 所以迁进来的团队必须补齐 —— 否则旧团队在建新作品时没有可用的角色。
 * id 走确定性规则，核验才不算出一堆随机 id。
 */
export function projectRoleRows(plan: Plan): { roles: ProjectRoleRow[]; permissions: ProjectPermissionRow[] } {
  const roleRows: ProjectRoleRow[] = [];
  const permissions: ProjectPermissionRow[] = [];
  for (const inst of plan.projectRoles.roles) {
    const teamOid = plan.projectTeam.get(inst.group);
    roleRows.push({
      id: inst.id,
      projectId: lid('project', inst.group),
      teamId: lid('team', teamOid ?? inst.group),
      name: inst.name,
      level: inst.level,
      intro: inst.intro,
      isSystem: inst.code !== null,
      systemCode: inst.code,
      // 指向团队的角色模板：模板改了不会回溯已有作品（本站的模板只用于新建作品）
      sourceTemplateId: inst.code && teamOid ? projectTemplateId(teamOid, inst.code) : null,
      legacyId: inst.legacyId,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
    });
    for (const code of inst.permissions) permissions.push({ projectRoleId: inst.id, permissionCode: code });
  }
  return { roles: roleRows, permissions };
}

export function projectMemberRows(plan: Plan): ProjectMemberRow[] {
  return plan.projectMembers.map((m) => ({
    projectId: lid('project', m.group),
    userId: lid('user', m.user),
    projectRoleId: m.roleId,
    createdBy: null,
    createdAt: m.createdAt,
  }));
}

export function targetRows(plan: Plan): TargetRow[] {
  return plan.targets.map((t) => ({
    id: lid('target', t._id),
    projectId: lid('project', plan.targetProject.get(t._id)!),
    language: plan.targetLanguage.get(t._id)!,
    label: plan.targetLabel.get(t._id)!,
    orderIndex: plan.targetOrder.get(t._id) ?? 0,
    legacyId: legacyRef('target', t._id),
    createdAt: dateOr(t.ct, t._id),
  }));
}

export function projectTemplateRows(plan: Plan): { roles: RoleRow[]; permissions: PermissionRow[] } {
  const roleRows: RoleRow[] = [];
  const permissions: PermissionRow[] = [];
  for (const team of plan.teams) {
    const created = oidTime(team._id);
    for (const tpl of PROJECT_ROLE_TEMPLATES) {
      const id = projectTemplateId(team._id, tpl.systemCode);
      roleRows.push({
        id,
        scope: 'project',
        teamId: lid('team', team._id),
        name: tpl.name,
        level: tpl.level,
        intro: tpl.intro,
        isSystem: true,
        systemCode: tpl.systemCode,
        autoProjectAdmin: false,
        legacyId: null,
        createdAt: created,
        updatedAt: created,
      });
      for (const code of tpl.permissions) permissions.push({ roleId: id, permissionCode: code });
    }
  }
  return { roles: roleRows, permissions };
}
