import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { permissions, rolePermissions, roles, teams } from '../db/schema.js';
import {
  DEFAULT_TEAM_ROLE_SYSTEM_CODE,
  PERMISSIONS,
  SYSTEM_TEAM_ROLES,
} from './permissions.js';

/**
 * 权限码目录的落库。幂等，可在启动时反复执行。
 * 两件事：把代码里的词表同步进 `permissions` 表（供外键引用），并**删除已废弃的码**。
 */
export async function ensurePermissionCatalog(): Promise<void> {
  for (const p of PERMISSIONS) {
    await db
      .insert(permissions)
      .values({ code: p.code, scope: p.scope, label: p.label, intro: p.intro ?? '' })
      .onConflictDoUpdate({
        target: permissions.code,
        set: { scope: p.scope, label: p.label, intro: p.intro ?? '' },
      });
  }

  // 词表是代码定义的，库里多出来的说明是从旧版本残留的 —— 清掉，
  // 否则它会被误授予角色。靠外键级联，角色关联会一并删除。
  const valid = new Set(PERMISSIONS.map((p) => p.code));
  const existing = await db.select({ code: permissions.code }).from(permissions);
  for (const row of existing) {
    if (!valid.has(row.code)) {
      await db.delete(permissions).where(eq(permissions.code, row.code));
    }
  }
}

/**
 * 为一个团队创建全部系统内置角色，并把它设为默认角色。
 * 建团队时调用一次；角色由代码定义，不允许在界面上被删除。
 */
export async function createSystemTeamRoles(
  teamId: string,
): Promise<Map<string, string>> {
  const created = new Map<string, string>();

  for (const def of SYSTEM_TEAM_ROLES) {
    const inserted = await db
      .insert(roles)
      .values({
        scope: 'team',
        teamId,
        name: def.name,
        level: def.level,
        intro: def.intro,
        isSystem: true,
        systemCode: def.systemCode,
        autoProjectAdmin: def.autoProjectAdmin,
      })
      .returning({ id: roles.id });

    const roleId = inserted[0]?.id;
    if (!roleId) throw new Error(`创建系统角色失败：${def.systemCode}`);
    created.set(def.systemCode, roleId);

    if (def.permissions.length > 0) {
      await db
        .insert(rolePermissions)
        .values(def.permissions.map((code) => ({ roleId, permissionCode: code })))
        .onConflictDoNothing();
    }
  }

  const defaultRoleId = created.get(DEFAULT_TEAM_ROLE_SYSTEM_CODE);
  if (defaultRoleId) {
    await db.update(teams).set({ defaultRoleId }).where(eq(teams.id, teamId));
  }

  return created;
}

/** 供「角色列表」用：把角色与其权限码一次查出来。 */
export async function listTeamRolesWithPermissions(teamId: string) {
  const roleRows = await db
    .select()
    .from(roles)
    .where(and(eq(roles.scope, 'team'), eq(roles.teamId, teamId)))
    .orderBy(roles.level);

  if (roleRows.length === 0) return [];

  const permRows = await db
    .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .where(eq(roles.teamId, teamId));

  const byRole = new Map<string, string[]>();
  for (const row of permRows) {
    const list = byRole.get(row.roleId) ?? [];
    list.push(row.code);
    byRole.set(row.roleId, list);
  }

  return roleRows.map((role) => ({
    ...role,
    permissions: (byRole.get(role.id) ?? []).sort(),
  }));
}
