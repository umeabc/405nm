import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  projectMembers,
  projectRolePermissions,
  projectRoles,
  projects,
  rolePermissions,
  roles,
  teamMembers,
  teams,
  users,
  type Project,
  type ProjectRole,
  type Role,
  type Team,
  type User,
} from '../db/schema.js';
import { ALL_PERMISSION_CODES } from './permissions.js';
import { forbidden, notFound } from '../lib/errors.js';

/**
 * 团队上下文：一个用户在一个团队里的角色与有效权限。
 *
 * 站点管理员拿到的是**全集**权限 —— 但仍需要显式带 teamId 调用，
 * 这样审计日志里始终有「他在哪个团队做了什么」，而不是一片无归属的操作。
 */
export type TeamAccess = {
  team: Team;
  /** 站点管理员不挂在具体角色上，为 null */
  role: Role | null;
  permissions: ReadonlySet<string>;
  isSiteAdmin: boolean;
};

export async function getTeamAccess(teamId: string, user: User): Promise<TeamAccess | null> {
  const teamRows = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  const team = teamRows[0];
  if (!team) return null;

  if (user.isSiteAdmin) {
    return {
      team,
      role: null,
      permissions: new Set(ALL_PERMISSION_CODES),
      isSiteAdmin: true,
    };
  }

  const rows = await db
    .select({ role: roles })
    .from(teamMembers)
    .innerJoin(roles, eq(roles.id, teamMembers.roleId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)))
    .limit(1);

  const role = rows[0]?.role;
  if (!role) return null;

  const permRows = await db
    .select({ code: rolePermissions.permissionCode })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, role.id));

  return {
    team,
    role,
    permissions: new Set(permRows.map((r) => r.code)),
    isSiteAdmin: false,
  };
}

/** 拿不到团队上下文 = 不是成员。对外统一 404，不暴露「这个团队是否存在」。 */
export async function requireTeamAccess(teamId: string, user: User): Promise<TeamAccess> {
  const access = await getTeamAccess(teamId, user);
  if (!access) throw notFound('团队不存在或你不在其中', 'TEAM_NOT_FOUND');
  return access;
}

export function can(access: TeamAccess, code: string): boolean {
  return access.permissions.has(code);
}

export function requirePermission(access: TeamAccess, code: string): void {
  if (!can(access, code)) {
    throw forbidden(`没有权限执行该操作（需要 ${code}）`);
  }
}

export function hasAnyPermission(access: TeamAccess, codes: readonly string[]): boolean {
  return codes.some((c) => access.permissions.has(c));
}

// ── 等级守卫 ────────────────────────────────────────────────
//
// 规则来自 moeflow 的 rbac：只能改动**等级严格低于自己**的成员，
// 而且创建人角色既不能被移除，也不能被改。站点管理员不受等级限制。

export function actorLevel(access: TeamAccess): number {
  return access.role?.level ?? Number.MAX_SAFE_INTEGER;
}

export function canManageRole(access: TeamAccess, targetLevel: number): boolean {
  if (access.isSiteAdmin) return true;
  return actorLevel(access) > targetLevel;
}

export function assertCanManageRole(access: TeamAccess, targetLevel: number, what = '该成员'): void {
  if (!canManageRole(access, targetLevel)) {
    throw forbidden(`你的等级不足以管理${what}（只能管理等级低于自己的成员）`);
  }
}

/** 创建人角色是团队的锚，任何情况下都不允许被改角色或移除。 */
export function assertNotCreatorRole(targetRole: Role | null | undefined, what = '该成员'): void {
  if (targetRole?.systemCode === 'creator') {
    throw forbidden(`${what}是团队创建人，无法变更或移除`);
  }
}

/** 角色等级不得高于操作者（防提权），自定义权限也不得超出操作者已有权限。 */
export function assertRoleWithinActor(
  access: TeamAccess,
  role: { level: number; permissions: readonly string[] },
): void {
  for (const code of role.permissions) {
    if (!access.permissions.has(code)) {
      throw forbidden(`不能授予你自己都没有的权限：${code}`);
    }
  }
  if (!access.isSiteAdmin && role.level >= actorLevel(access)) {
    throw forbidden('角色等级不能高于或等于你自己的等级');
  }
}

// ── 作品上下文 ──────────────────────────────────────────────

/**
 * 用户在某个作品里的角色与有效权限。
 *
 * 有效权限 = 作品角色权限 ∪ 「自动作品管理员」补授的权限。后者的来源是
 * **团队角色上的 `auto_project_admin` 开关**，而不是 moeflow 那套
 * `TeamRole.convert_to_project_role()` 隐式提权 —— 那边「哪些团队角色会提权」
 * 是写死在代码里的魔法，这里是一个看得见、改得动的布尔位。
 * 默认只有创建人与管理员为真（见 permissions.ts 的系统角色定义）。
 */
export type ProjectAccess = {
  project: Project;
  teamAccess: TeamAccess;
  /** 显式的作品角色；团队角色自动授权时为 null */
  role: ProjectRole | null;
  permissions: ReadonlySet<string>;
  /** 团队角色带 auto_project_admin 而额外获得的权限（用于界面区分「为什么我能操作」） */
  viaTeamRole: boolean;
};

async function permissionsOfProjectRole(roleId: string): Promise<string[]> {
  const rows = await db
    .select({ code: projectRolePermissions.permissionCode })
    .from(projectRolePermissions)
    .where(eq(projectRolePermissions.projectRoleId, roleId));
  return rows.map((r) => r.code);
}

export async function getProjectAccess(projectId: string, user: User): Promise<ProjectAccess | null> {
  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) return null;

  // 作品权限**建立在团队权限之上**：不在团队里就看不到作品，
  // 无论他在作品成员表里有没有行（那是脏数据，不该被放大成访问权）。
  const teamAccess = await getTeamAccess(project.teamId, user);
  if (!teamAccess) return null;

  // 显式的作品角色**先查出来**，站点管理员也要查。
  // 早先的写法是「站点管理员直接返回 role=null」，结果是：一个恰好是站点管理员的
  // 作品创建人在作品页上看到的是「团队角色授权」，而不是「我是创建人」——
  // 权限没错，但界面在说谎。角色是事实，与权限从哪儿来是两件事。
  const memberRows = await db
    .select({ role: projectRoles })
    .from(projectMembers)
    .innerJoin(projectRoles, eq(projectRoles.id, projectMembers.projectRoleId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)))
    .limit(1);

  const role = memberRows[0]?.role ?? null;

  if (user.isSiteAdmin) {
    return {
      project,
      teamAccess,
      role,
      permissions: new Set(ALL_PERMISSION_CODES),
      // viaTeamRole 的含义是「权限来自团队角色的 auto_project_admin」，
      // 站点管理员的权限不来自那里，所以为 false。
      viaTeamRole: false,
    };
  }

  const permissions = new Set<string>();
  if (role) {
    for (const code of await permissionsOfProjectRole(role.id)) permissions.add(code);
  }

  // 团队角色带 auto_project_admin → 补授「作品管理员」的权限。
  // 找的是作品自己的 admin 角色（建作品时从模板实例化出来的那份），
  // 所以团队模板改了不会回溯改变已有作品的授权。
  let viaTeamRole = false;
  if (teamAccess.role?.autoProjectAdmin) {
    const adminRoleRows = await db
      .select({ id: projectRoles.id })
      .from(projectRoles)
      .where(
        and(
          eq(projectRoles.projectId, projectId),
          eq(projectRoles.systemCode, 'admin'),
        ),
      )
      .limit(1);
    const adminRoleId = adminRoleRows[0]?.id;
    if (adminRoleId) {
      for (const code of await permissionsOfProjectRole(adminRoleId)) permissions.add(code);
      viaTeamRole = true;
    }
  }

  return { project, teamAccess, role, permissions, viaTeamRole };
}

export async function requireProjectAccess(projectId: string, user: User): Promise<ProjectAccess> {
  const access = await getProjectAccess(projectId, user);
  if (!access) throw notFound('作品不存在或你无权访问', 'PROJECT_NOT_FOUND');
  return access;
}

export function canInProject(access: ProjectAccess, code: string): boolean {
  return access.permissions.has(code);
}

export function requireProjectPermission(access: ProjectAccess, code: string): void {
  if (!access.permissions.has(code)) {
    throw forbidden(`没有权限执行该操作（需要 ${code}）`);
  }
}

/**
 * 作品内的等级守卫。作品成员角色的等级与团队角色的等级取**较大者** ——
 * 团队管理员即便在某个作品里只挂了「翻译」，也不该被一个见习成员踢出去。
 */
export function projectActorLevel(access: ProjectAccess): number {
  if (access.teamAccess.isSiteAdmin) return Number.MAX_SAFE_INTEGER;
  const teamLevel = access.teamAccess.role?.level ?? 0;
  const projectLevel = access.role?.level ?? 0;
  return Math.max(teamLevel, projectLevel);
}

export function assertCanManageProjectRole(access: ProjectAccess, targetLevel: number, what = '该成员'): void {
  if (access.teamAccess.isSiteAdmin) return;
  if (projectActorLevel(access) <= targetLevel) {
    throw forbidden(`你的等级不足以管理${what}（只能管理等级低于自己的成员）`);
  }
}

/**
 * 团队里有哪些人还没进这个作品 —— 供「添加成员」下拉用。
 * 返回带上昵称与团队角色名，免得前端为了显示一个人再查一次。
 */
export async function projectMemberCandidates(projectId: string, teamId: string) {
  const teamRows = await db
    .select({
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarKey: users.avatarKey,
      teamRoleName: roles.name,
      teamRoleLevel: roles.level,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .innerJoin(roles, eq(roles.id, teamMembers.roleId))
    .where(eq(teamMembers.teamId, teamId));

  const inProject = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));

  const joined = new Set(inProject.map((r) => r.userId));
  return teamRows
    .filter((r) => !joined.has(r.userId))
    .sort((a, b) => b.teamRoleLevel - a.teamRoleLevel || a.displayName.localeCompare(b.displayName));
}
