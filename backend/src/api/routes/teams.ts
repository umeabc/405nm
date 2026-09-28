import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { inviteCodes, rolePermissions, roles, teamMembers, teams, users } from '../../db/schema.js';
import {
  assertCanManageRole,
  assertNotCreatorRole,
  assertRoleWithinActor,
  getTeamAccess,
  requirePermission,
  requireTeamAccess,
  type TeamAccess,
} from '../../domain/authorize.js';
import { assertInviteRoleBelongsToTeam } from '../../domain/invite.js';
import { createSystemTeamRoles, listTeamRolesWithPermissions } from '../../domain/team-roles.js';
import { ALL_PERMISSION_CODES, PERMISSIONS, PERMISSION_SCOPES } from '../../domain/permissions.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { generateInviteCode, validateDisplayName } from '../../lib/validate.js';
import { clientIp, requireAuth } from '../guards.js';

const idParam = z.object({ id: z.string().uuid('团队 ID 不合法') });

const createTeamSchema = z.object({
  name: z.string().trim().min(2, '团队名称至少 2 个字符').max(32, '团队名称最多 32 个字符'),
  intro: z.string().trim().max(200, '简介最多 200 个字符').optional(),
});

const updateTeamSchema = z.object({
  name: z.string().trim().min(2).max(32).optional(),
  intro: z.string().trim().max(200).optional(),
});

const createRoleSchema = z.object({
  name: z.string().trim().min(1, '请填写角色名').max(16, '角色名最多 16 个字符'),
  level: z.coerce.number().int().min(1, '角色等级至少为 1').max(499, '自定义角色等级不能达到 500'),
  intro: z.string().trim().max(100).optional(),
  permissions: z.array(z.string()).default([]),
  autoProjectAdmin: z.boolean().default(false),
});

const updateRoleSchema = createRoleSchema.partial();

const addMemberSchema = z.object({
  username: z.string().trim().min(1, '请填写用户名'),
  roleId: z.string().uuid('角色 ID 不合法'),
});

const changeMemberRoleSchema = z.object({ roleId: z.string().uuid('角色 ID 不合法') });

const createInviteSchema = z.object({
  roleId: z.string().uuid().nullish(),
  maxUses: z.coerce.number().int().min(1).max(1000).nullish(),
  expiresAt: z.string().datetime().nullish(),
  note: z.string().trim().max(60).optional(),
  count: z.coerce.number().int().min(1).max(20).default(1),
});

/** 前端要按权限渲染界面，所以角色列表带上权限码；权限目录本身也开放给登录用户读。 */
function serializeRole(role: typeof roles.$inferSelect, permissions: string[]) {
  return {
    id: role.id,
    name: role.name,
    level: role.level,
    intro: role.intro,
    isSystem: role.isSystem,
    systemCode: role.systemCode,
    autoProjectAdmin: role.autoProjectAdmin,
    permissions,
  };
}

async function requireTeamPermission(
  teamId: string,
  user: Parameters<typeof getTeamAccess>[1],
  code: string,
): Promise<TeamAccess> {
  const access = await requireTeamAccess(teamId, user);
  requirePermission(access, code);
  return access;
}

export async function registerTeamRoutes(app: FastifyInstance): Promise<void> {
  /** 权限目录：角色编辑器要拿它渲染可勾选项。 */
  app.get('/permissions', async (request) => {
    await requireAuth(request);
    return {
      scopes: PERMISSION_SCOPES,
      permissions: PERMISSIONS.map((p) => ({
        code: p.code,
        scope: p.scope,
        label: p.label,
        intro: p.intro ?? '',
      })),
    };
  });

  /** 我加入的团队。工作台与团队切换都用它。 */
  app.get('/teams', async (request) => {
    const user = await requireAuth(request);

    const rows = await db
      .select({ team: teams, role: roles })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(roles, eq(roles.id, teamMembers.roleId))
      .where(eq(teamMembers.userId, user.id))
      .orderBy(asc(teams.name));

    const memberCounts = await db
      .select({ teamId: teamMembers.teamId, total: count() })
      .from(teamMembers)
      .where(
        inArray(
          teamMembers.teamId,
          rows.length > 0 ? rows.map((r) => r.team.id) : ['00000000-0000-0000-0000-000000000000'],
        ),
      )
      .groupBy(teamMembers.teamId);

    const countByTeam = new Map(memberCounts.map((m) => [m.teamId, Number(m.total)]));

    // 顺带把我在这几个团队里的权限码一次查出来。界面据此决定要不要显示
    // 「新建作品」这类入口 —— 多一次查询，换掉的是「点了才知道没权限」。
    const permRows =
      rows.length > 0
        ? await db
            .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
            .from(rolePermissions)
            .where(
              inArray(
                rolePermissions.roleId,
                rows.map((r) => r.role.id),
              ),
            )
        : [];

    const permsByRole = new Map<string, string[]>();
    for (const row of permRows) {
      const list = permsByRole.get(row.roleId) ?? [];
      list.push(row.code);
      permsByRole.set(row.roleId, list);
    }

    return {
      teams: rows.map((row) => ({
        id: row.team.id,
        name: row.team.name,
        intro: row.team.intro,
        avatarKey: row.team.avatarKey,
        memberCount: countByTeam.get(row.team.id) ?? 0,
        myRole: { id: row.role.id, name: row.role.name, level: row.role.level, systemCode: row.role.systemCode },
        // 站点管理员在团队页拿到的是全集权限，这里也照此处理，
        // 否则管理员看到的是一个「什么都点不了」的界面。
        myPermissions: user.isSiteAdmin
          ? [...ALL_PERMISSION_CODES].sort()
          : (permsByRole.get(row.role.id) ?? []).sort(),
      })),
    };
  });

  /** 建团队。任何登录用户都能建，建完自己就是创建人 —— 与彩翻一致。 */
  app.post('/teams', async (request, reply) => {
    const user = await requireAuth(request);

    const parsed = createTeamSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const nameError = validateDisplayName(parsed.data.name);
    if (nameError) throw badRequest(nameError, 'INVALID_TEAM_NAME');

    const existing = await db.select({ id: teams.id }).from(teams).where(eq(teams.name, parsed.data.name)).limit(1);
    if (existing.length > 0) throw conflict('该团队名称已被占用', 'TEAM_NAME_TAKEN');

    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(teams)
        .values({ name: parsed.data.name, intro: parsed.data.intro ?? '' })
        .returning();
      const team = inserted[0];
      if (!team) throw new Error('创建团队失败');
      return team;
    });

    // 系统角色必须在事务外建：它要回写 teams.default_role_id，
    // 而事务内的自引用更新容易踩到未提交读的问题，这里不值得讨巧。
    const roleIds = await createSystemTeamRoles(created.id);
    const creatorRoleId = roleIds.get('creator');
    if (!creatorRoleId) throw new Error('创建系统角色失败');

    await db.insert(teamMembers).values({
      teamId: created.id,
      userId: user.id,
      roleId: creatorRoleId,
    });

    await logOp({
      actorId: user.id,
      teamId: created.id,
      action: 'team.create',
      targetType: 'team',
      targetId: created.id,
      targetName: created.name,
      ip: clientIp(request),
    });

    reply.code(201);
    return { team: { id: created.id, name: created.name, intro: created.intro } };
  });

  app.get('/teams/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const access = await requireTeamAccess(id, user);

    const roleList = await listTeamRolesWithPermissions(id);

    return {
      team: {
        id: access.team.id,
        name: access.team.name,
        intro: access.team.intro,
        avatarKey: access.team.avatarKey,
        status: access.team.status,
        createdAt: access.team.createdAt,
      },
      my: {
        isSiteAdmin: access.isSiteAdmin,
        role: access.role
          ? { id: access.role.id, name: access.role.name, level: access.role.level, systemCode: access.role.systemCode }
          : null,
        permissions: [...access.permissions].sort(),
      },
      roles: roleList.map((r) => serializeRole(r, r.permissions)),
    };
  });

  app.patch('/teams/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const access = await requireTeamPermission(id, user, 'team.edit');

    const parsed = updateTeamSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    if (parsed.data.name && parsed.data.name !== access.team.name) {
      const dup = await db.select({ id: teams.id }).from(teams).where(eq(teams.name, parsed.data.name)).limit(1);
      if (dup.length > 0) throw conflict('该团队名称已被占用', 'TEAM_NAME_TAKEN');
    }

    await db
      .update(teams)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.intro !== undefined ? { intro: parsed.data.intro } : {}),
        updatedAt: new Date(),
      })
      .where(eq(teams.id, id));

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'team.update',
      targetType: 'team',
      targetId: id,
      targetName: parsed.data.name ?? access.team.name,
      detail: parsed.data,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.delete('/teams/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const access = await requireTeamPermission(id, user, 'team.delete');

    // 团队删除会级联带走成员关系、角色与邀请码；作品数据在 M2 接入，
    // 届时这里要显式做一次「还有作品就不许删」的检查。
    await db.delete(teams).where(eq(teams.id, id));

    await logOp({
      actorId: user.id,
      action: 'team.delete',
      targetType: 'team',
      targetId: id,
      targetName: access.team.name,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  // ── 成员 ──────────────────────────────────────────────────

  app.get('/teams/:id/members', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    await requireTeamAccess(id, user);

    const rows = await db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarKey: users.avatarKey,
        status: users.status,
        joinedAt: teamMembers.createdAt,
        roleId: roles.id,
        roleName: roles.name,
        roleLevel: roles.level,
        roleSystemCode: roles.systemCode,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .innerJoin(roles, eq(roles.id, teamMembers.roleId))
      .where(eq(teamMembers.teamId, id))
      .orderBy(desc(roles.level), asc(users.username));

    return { members: rows };
  });

  /** 直接把已注册用户加进团队（与「发邀请码让对方自己注册」两条路）。 */
  app.post('/teams/:id/members', async (request, reply) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const access = await requireTeamPermission(id, user, 'team.member.invite');

    const parsed = addMemberSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const targetRows = await db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(eq(users.username, parsed.data.username))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw notFound('该用户不存在', 'USER_NOT_FOUND');

    const roleRows = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, parsed.data.roleId), eq(roles.teamId, id)))
      .limit(1);
    const role = roleRows[0];
    if (!role) throw badRequest('所选角色不属于该团队', 'ROLE_TEAM_MISMATCH');

    assertCanManageRole(access, role.level, '该角色');

    const already = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, target.id)))
      .limit(1);
    if (already.length > 0) throw conflict('该用户已在团队中', 'ALREADY_MEMBER');

    await db.insert(teamMembers).values({ teamId: id, userId: target.id, roleId: role.id });

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'team.member.add',
      targetType: 'user',
      targetId: target.id,
      targetName: target.username,
      detail: { roleId: role.id, roleName: role.name },
      ip: clientIp(request),
    });

    reply.code(201);
    return { ok: true };
  });

  app.patch('/teams/:id/members/:userId', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    const access = await requireTeamPermission(id, user, 'team.member.change_role');

    const parsed = changeMemberRoleSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const targetRows = await db
      .select({ member: teamMembers, role: roles, username: users.username })
      .from(teamMembers)
      .innerJoin(roles, eq(roles.id, teamMembers.roleId))
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, params.userId)))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw notFound('该成员不在团队中', 'MEMBER_NOT_FOUND');

    assertNotCreatorRole(target.role);

    const newRoleRows = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, parsed.data.roleId), eq(roles.teamId, id)))
      .limit(1);
    const newRole = newRoleRows[0];
    if (!newRole) throw badRequest('所选角色不属于该团队', 'ROLE_TEAM_MISMATCH');

    // 两道守卫：得管得动「他现在这个角色」，也得管得动「要换成的新角色」。
    // 少任何一道都能被用来提权。
    assertCanManageRole(access, target.role.level, '该成员');
    assertCanManageRole(access, newRole.level, '该角色');

    await db
      .update(teamMembers)
      .set({ roleId: newRole.id })
      .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, params.userId)));

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'team.member.change_role',
      targetType: 'user',
      targetId: params.userId,
      targetName: target.username,
      detail: { from: target.role.name, to: newRole.name },
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.delete('/teams/:id/members/:userId', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    const access = await requireTeamPermission(id, user, 'team.member.remove');

    const targetRows = await db
      .select({ role: roles, username: users.username })
      .from(teamMembers)
      .innerJoin(roles, eq(roles.id, teamMembers.roleId))
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, params.userId)))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw notFound('该成员不在团队中', 'MEMBER_NOT_FOUND');

    assertNotCreatorRole(target.role);
    assertCanManageRole(access, target.role.level, '该成员');

    await db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, params.userId)));

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'team.member.remove',
      targetType: 'user',
      targetId: params.userId,
      targetName: target.username,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  // ── 角色 ──────────────────────────────────────────────────

  app.get('/teams/:id/roles', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    await requireTeamAccess(id, user);

    const list = await listTeamRolesWithPermissions(id);
    return { roles: list.map((r) => serializeRole(r, r.permissions)) };
  });

  app.post('/teams/:id/roles', async (request, reply) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const access = await requireTeamPermission(id, user, 'team.role.create');

    const parsed = createRoleSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const { name, level, intro, permissions, autoProjectAdmin } = parsed.data;

    const validCodes = new Set(PERMISSIONS.filter((p) => p.scope === 'team').map((p) => p.code));
    const unknown = permissions.filter((c) => !validCodes.has(c));
    if (unknown.length > 0) throw badRequest(`存在无效的权限码：${unknown.join('、')}`, 'UNKNOWN_PERMISSION');

    assertRoleWithinActor(access, { level, permissions });

    const dup = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.teamId, id), eq(roles.name, name)))
      .limit(1);
    if (dup.length > 0) throw conflict('该角色名已存在', 'ROLE_NAME_TAKEN');

    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(roles)
        .values({
          scope: 'team',
          teamId: id,
          name,
          level,
          intro: intro ?? '',
          isSystem: false,
          autoProjectAdmin,
        })
        .returning({ id: roles.id });

      const roleId = inserted[0]?.id;
      if (!roleId) throw new Error('创建角色失败');

      if (permissions.length > 0) {
        await tx.insert(rolePermissions).values(permissions.map((code) => ({ roleId, permissionCode: code })));
      }
      return roleId;
    });

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'team.role.create',
      targetType: 'role',
      targetId: created,
      targetName: name,
      detail: { level, permissions },
      ip: clientIp(request),
    });

    reply.code(201);
    return { roleId: created };
  });

  app.patch('/teams/:id/roles/:roleId', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const params = z.object({ roleId: z.string().uuid() }).parse(request.params);
    const access = await requireTeamPermission(id, user, 'team.role.edit');

    const parsed = updateRoleSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const roleRows = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, params.roleId), eq(roles.teamId, id)))
      .limit(1);
    const role = roleRows[0];
    if (!role) throw notFound('角色不存在', 'ROLE_NOT_FOUND');

    assertCanManageRole(access, role.level, '该角色');

    // 系统角色的权限集合是代码定义的，改了就与代码不一致 —— 只允许改名字和简介。
    if (role.isSystem && parsed.data.permissions) {
      throw badRequest('系统内置角色的权限不可修改', 'SYSTEM_ROLE_IMMUTABLE');
    }

    if (parsed.data.permissions) {
      const validCodes = new Set(PERMISSIONS.filter((p) => p.scope === 'team').map((p) => p.code));
      const unknown = parsed.data.permissions.filter((c) => !validCodes.has(c));
      if (unknown.length > 0) throw badRequest(`存在无效的权限码：${unknown.join('、')}`, 'UNKNOWN_PERMISSION');

      assertRoleWithinActor(access, {
        level: parsed.data.level ?? role.level,
        permissions: parsed.data.permissions,
      });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(roles)
        .set({
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
          ...(parsed.data.level !== undefined ? { level: parsed.data.level } : {}),
          ...(parsed.data.intro !== undefined ? { intro: parsed.data.intro } : {}),
          ...(parsed.data.autoProjectAdmin !== undefined
            ? { autoProjectAdmin: parsed.data.autoProjectAdmin }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(roles.id, role.id));

      if (parsed.data.permissions) {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
        if (parsed.data.permissions.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(parsed.data.permissions.map((code) => ({ roleId: role.id, permissionCode: code })));
        }
      }
    });

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'team.role.update',
      targetType: 'role',
      targetId: role.id,
      targetName: parsed.data.name ?? role.name,
      detail: parsed.data,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.delete('/teams/:id/roles/:roleId', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const params = z.object({ roleId: z.string().uuid() }).parse(request.params);
    const access = await requireTeamPermission(id, user, 'team.role.delete');

    const roleRows = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, params.roleId), eq(roles.teamId, id)))
      .limit(1);
    const role = roleRows[0];
    if (!role) throw notFound('角色不存在', 'ROLE_NOT_FOUND');
    if (role.isSystem) throw badRequest('系统内置角色不可删除', 'SYSTEM_ROLE_IMMUTABLE');

    assertCanManageRole(access, role.level, '该角色');

    const inUse = await db
      .select({ total: count() })
      .from(teamMembers)
      .where(eq(teamMembers.roleId, role.id));
    if (Number(inUse[0]?.total ?? 0) > 0) {
      throw conflict('该角色仍有成员在使用，请先调整他们的角色', 'ROLE_IN_USE');
    }

    // 邀请码引用了这个角色时，外键是 set null，会退化成「入团用默认角色」——
    // 与其静默降级，不如让操作者显式处理。
    const usedByInvite = await db
      .select({ total: count() })
      .from(inviteCodes)
      .where(eq(inviteCodes.roleId, role.id));
    if (Number(usedByInvite[0]?.total ?? 0) > 0) {
      throw conflict('该角色仍被邀请码引用，请先停用或删除相关邀请码', 'ROLE_IN_USE_BY_INVITE');
    }

    await db.delete(roles).where(eq(roles.id, role.id));

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'team.role.delete',
      targetType: 'role',
      targetId: role.id,
      targetName: role.name,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  // ── 邀请码 ────────────────────────────────────────────────

  app.get('/teams/:id/invites', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    await requireTeamPermission(id, user, 'team.invite.manage');

    const rows = await db
      .select({
        invite: inviteCodes,
        roleName: roles.name,
        createdByName: users.displayName,
        createdByUsername: users.username,
      })
      .from(inviteCodes)
      .leftJoin(roles, eq(roles.id, inviteCodes.roleId))
      .leftJoin(users, eq(users.id, inviteCodes.createdBy))
      .where(eq(inviteCodes.teamId, id))
      .orderBy(desc(inviteCodes.createdAt));

    return {
      invites: rows.map((row) => ({
        id: row.invite.id,
        code: row.invite.code,
        roleId: row.invite.roleId,
        roleName: row.roleName,
        maxUses: row.invite.maxUses,
        usedCount: row.invite.usedCount,
        expiresAt: row.invite.expiresAt,
        enabled: row.invite.enabled,
        note: row.invite.note,
        createdAt: row.invite.createdAt,
        createdBy: row.createdByName || row.createdByUsername || null,
      })),
    };
  });

  app.post('/teams/:id/invites', async (request, reply) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    await requireTeamPermission(id, user, 'team.invite.manage');

    const parsed = createInviteSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const { roleId, maxUses, expiresAt, note, count: howMany } = parsed.data;
    await assertInviteRoleBelongsToTeam(id, roleId);

    const values = Array.from({ length: howMany }, () => ({
      code: generateInviteCode(),
      teamId: id,
      roleId: roleId ?? null,
      maxUses: maxUses ?? null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      note: note ?? '',
      createdBy: user.id,
    }));

    const inserted = await db.insert(inviteCodes).values(values).returning({
      id: inviteCodes.id,
      code: inviteCodes.code,
    });

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'invite.create',
      targetType: 'invite',
      targetId: id,
      targetName: inserted.map((i) => i.code).join('、'),
      detail: { count: howMany, roleId: roleId ?? null, maxUses: maxUses ?? null },
      ip: clientIp(request),
    });

    reply.code(201);
    // 明文只在这一次返回 —— 列表接口也会给出，因为这里是团队内部使用，
    // 与图译空间「只显示一次」的策略不同：管理员需要随时把码再发给别人。
    return { invites: inserted };
  });

  app.patch('/teams/:id/invites/:inviteId', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const params = z.object({ inviteId: z.string().uuid() }).parse(request.params);
    await requireTeamPermission(id, user, 'team.invite.manage');

    const parsed = z
      .object({ enabled: z.boolean() })
      .safeParse(request.body);
    if (!parsed.success) throw badRequest('参数不合法');

    const rows = await db
      .update(inviteCodes)
      .set({ enabled: parsed.data.enabled })
      .where(and(eq(inviteCodes.id, params.inviteId), eq(inviteCodes.teamId, id)))
      .returning({ id: inviteCodes.id, code: inviteCodes.code });

    const updated = rows[0];
    if (!updated) throw notFound('邀请码不存在', 'INVITE_NOT_FOUND');

    await logOp({
      actorId: user.id,
      teamId: id,
      action: parsed.data.enabled ? 'invite.enable' : 'invite.disable',
      targetType: 'invite',
      targetId: updated.id,
      targetName: updated.code,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.delete('/teams/:id/invites/:inviteId', async (request) => {
    const user = await requireAuth(request);
    const { id } = idParam.parse(request.params);
    const params = z.object({ inviteId: z.string().uuid() }).parse(request.params);
    await requireTeamPermission(id, user, 'team.invite.manage');

    const rows = await db
      .delete(inviteCodes)
      .where(and(eq(inviteCodes.id, params.inviteId), eq(inviteCodes.teamId, id)))
      .returning({ id: inviteCodes.id, code: inviteCodes.code });

    const removed = rows[0];
    if (!removed) throw notFound('邀请码不存在', 'INVITE_NOT_FOUND');

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'invite.delete',
      targetType: 'invite',
      targetId: removed.id,
      targetName: removed.code,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  /** 供后台统计用：全部团队的概览（站点管理员）。 */
  app.get('/admin/teams', async (request) => {
    const user = await requireAuth(request);
    if (!user.isSiteAdmin) throw badRequest('该操作仅站点管理员可用', 'FORBIDDEN');

    const rows = await db
      .select({
        team: teams,
        memberCount: sql<number>`(select count(*) from ${teamMembers} where ${teamMembers.teamId} = ${teams.id})`,
      })
      .from(teams)
      .orderBy(asc(teams.name));

    return {
      teams: rows.map((r) => ({
        id: r.team.id,
        name: r.team.name,
        intro: r.team.intro,
        status: r.team.status,
        memberCount: Number(r.memberCount),
        createdAt: r.team.createdAt,
      })),
    };
  });
}
