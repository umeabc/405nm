/** 第一步：权限目录 → 用户 → 团队 → 角色 → 成员 → 公告 → 邀请码。 */
import { db } from '../db/client.js';
import {
  inviteCodes,
  noticeReads,
  notices,
  rolePermissions,
  roles,
  teamMembers,
  teams,
  users,
} from '../db/schema.js';
import { ensurePermissionCatalog } from '../domain/team-roles.js';
import type { Ctx } from './plan.js';
import {
  inviteConflicts,
  inviteRows,
  noticeReadRows,
  noticeRows,
  projectTemplateRows,
  teamMemberRows,
  teamRoleRows,
  teamRow,
  userRow,
  type Derived,
} from './rows.js';
import { insertById, insertRows } from './util.js';

/**
 * 顺序有讲究：用户与团队必须在角色之前（默认角色要指向已存在的行），
 * 团队成员在角色之后。公告的 `created_by` 也指向用户，所以排在用户之后。
 */
export async function stepOrg(ctx: Ctx, d: Derived): Promise<void> {
  const { plan, report } = ctx;

  // 权限目录是代码定义的，先同步一遍 —— 否则角色权限会挂在还不存在的权限码上（外键拒绝）
  await ensurePermissionCatalog();

  await insertById(
    db,
    users as never,
    plan.users.map((u) => userRow(u, d.usernames.get(u._id)!, d.emails.get(u._id) ?? null)),
    report,
    'users',
  );

  await insertById(
    db,
    teams as never,
    plan.teams.map((t) => teamRow(t, d.teamNames.get(t._id)!, plan, d.inputs)),
    report,
    'teams',
  );

  const teamRoles = teamRoleRows(plan);
  await insertById(db, roles as never, teamRoles.roles, report, 'roles（团队）');
  await insertRows(
    db,
    rolePermissions,
    teamRoles.permissions,
    report,
    'role_permissions（团队）',
    [rolePermissions.roleId, rolePermissions.permissionCode],
  );

  // 项目角色模板：迁进来的团队也要有全套，否则它新建作品时无角色可用
  const templates = projectTemplateRows(plan);
  await insertById(db, roles as never, templates.roles, report, 'roles（项目模板）');
  await insertRows(
    db,
    rolePermissions,
    templates.permissions,
    report,
    'role_permissions（项目模板）',
    [rolePermissions.roleId, rolePermissions.permissionCode],
  );

  await insertRows(
    db,
    teamMembers,
    teamMemberRows(plan),
    report,
    'team_members',
    [teamMembers.teamId, teamMembers.userId],
  );

  await insertById(db, notices as never, noticeRows(plan), report, 'notices');
  await insertRows(
    db,
    noticeReads,
    noticeReadRows(plan),
    report,
    'notice_reads',
    [noticeReads.noticeId, noticeReads.userId],
  );

  // 邀请码撞码会让整批插入失败，先判一次：这属于**不该自动糊过去**的冲突
  const conflicts = inviteConflicts(plan, d.inputs);
  report.check(
    'invite-code-conflict',
    conflicts.length ? 'fail' : 'ok',
    conflicts.length
      ? `有 ${conflicts.length} 个旧邀请码与站内已有码相同（${conflicts.slice(0, 5).join('、')}）：需要先改掉其中一个`
      : '旧邀请码与站内已有码无冲突',
    { conflicts },
  );
  await insertById(db, inviteCodes as never, inviteRows(plan), report, 'invite_codes');
}
