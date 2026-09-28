import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  projectMembers,
  projectRolePermissions,
  projectRoles,
  projectSets,
  projects,
  teamMembers,
  teams,
  targets,
  users,
} from '../../db/schema.js';
import {
  assertCanManageProjectRole,
  projectMemberCandidates,
  requireProjectAccess,
  requireProjectPermission,
  requireTeamAccess,
  type ProjectAccess,
} from '../../domain/authorize.js';
import { LANGUAGES, normalizeLanguage, languageLabel } from '../../domain/languages.js';
import {
  DEFAULT_PROJECT_ROLE_SYSTEM_CODE,
  assertProjectScopePermissions,
  instantiateProjectRoles,
  listProjectRolesWithPermissions,
  permissionsOfProjectRoles,
  syncProjectRoleDefaults,
} from '../../domain/project-roles.js';
import { buildProjectCards, queryProjects } from '../../domain/project-stats.js';
import { PROJECT_STAGES } from '../../domain/workflow.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { clientIp, requireAuth } from '../guards.js';

/**
 * 作品集 / 作品 / 作品成员 / 作品角色 / 目标语言。
 *
 * 权限分两层，务必分清（这是本文件里最容易写错的地方）：
 *  - **团队级动作**（建作品、建作品集）走 `requireTeamAccess` + 团队权限码；
 *  - **作品级动作**（改作品、管成员）走 `requireProjectAccess` + 作品权限码。
 * 两者不是包含关系：一个团队管理员通过 `auto_project_admin` 会拿到作品管理权限，
 * 但一个只挂了「翻译」的人即便团队角色很高，也不该能改作品资料 ——
 * 这条边界靠 `access.permissions` 判定，不靠等级猜测。
 */

const uuidParam = z.object({ id: z.string().uuid('ID 不合法') });
const projectParam = z.object({ id: z.string().uuid('作品 ID 不合法') });
const setParam = z.object({ id: z.string().uuid(), setId: z.string().uuid('作品集 ID 不合法') });
const memberParam = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid('用户 ID 不合法'),
});
const roleParam = z.object({ id: z.string().uuid(), roleId: z.string().uuid('角色 ID 不合法') });
const targetParam = z.object({ id: z.string().uuid(), targetId: z.string().uuid('目标语言 ID 不合法') });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
  return parsed.data;
}

const createProjectSchema = z.object({
  name: z.string().trim().min(1, '请填写作品名').max(120, '作品名最多 120 个字符'),
  intro: z.string().trim().max(2000).optional(),
  author: z.string().trim().max(80, '原作者最多 80 个字符').optional(),
  sourceLanguage: z.string().trim().min(1).max(20).optional(),
  setId: z.string().uuid().nullish(),
  targetLanguages: z.array(z.string().trim().min(1).max(20)).max(10).optional(),
});

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    intro: z.string().trim().max(2000).optional(),
    author: z.string().trim().max(80).optional(),
    sourceLanguage: z.string().trim().min(1).max(20).optional(),
    setId: z.string().uuid().nullish(),
    coverFileId: z.string().uuid().nullish(),
  })
  // 严格模式：多出来的字段一律报错，而不是被 zod 静默剥掉。
  // M1 踩过这个坑 —— 提交了字段、返回 ok、什么都没改，排查花了不少时间。
  .strict();

const createSetSchema = z.object({
  name: z.string().trim().min(1, '请填写作品集名称').max(60, '名称最多 60 个字符'),
  intro: z.string().trim().max(500).optional(),
  orderIndex: z.coerce.number().int().min(0).max(9999).optional(),
});

const addMemberSchema = z.object({
  userId: z.string().uuid('用户 ID 不合法'),
  projectRoleId: z.string().uuid('角色 ID 不合法'),
});

const changeMemberRoleSchema = z.object({ projectRoleId: z.string().uuid('角色 ID 不合法') });

const roleBodySchema = z.object({
  name: z.string().trim().min(1, '请填写角色名').max(16, '角色名最多 16 个字符').optional(),
  level: z.coerce.number().int().min(1).max(499).optional(),
  intro: z.string().trim().max(100).optional(),
  permissions: z.array(z.string()).optional(),
});

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  /** 语言目录：作品表单与目标语言都用它渲染下拉。 */
  app.get('/languages', async (request) => {
    await requireAuth(request);
    return { languages: LANGUAGES };
  });

  /** 五档进度标签，前端不必自己硬编码中文。 */
  app.get('/workflow/stages', async (request) => {
    await requireAuth(request);
    return { stages: PROJECT_STAGES };
  });

  // ── 作品集 ────────────────────────────────────────────────

  app.get('/teams/:id/project-sets', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(uuidParam, request.params);
    await requireTeamAccess(id, user);

    const rows = await db
      .select()
      .from(projectSets)
      .where(eq(projectSets.teamId, id))
      .orderBy(asc(projectSets.orderIndex), asc(projectSets.name));

    const counts = await db
      .select({ setId: projects.setId, total: count() })
      .from(projects)
      .where(and(eq(projects.teamId, id), eq(projects.status, 'active')))
      .groupBy(projects.setId);

    const countBySet = new Map(counts.map((c) => [c.setId ?? '', Number(c.total)]));

    return {
      sets: rows.map((s) => ({
        id: s.id,
        name: s.name,
        intro: s.intro,
        orderIndex: s.orderIndex,
        projectCount: countBySet.get(s.id) ?? 0,
      })),
    };
  });

  app.post('/teams/:id/project-sets', async (request, reply) => {
    const user = await requireAuth(request);
    const { id } = parse(uuidParam, request.params);
    const access = await requireTeamAccess(id, user);
    if (!access.permissions.has('project_set.create')) throw forbidden('没有权限创建作品集（需要 project_set.create）');

    const body = parse(createSetSchema, request.body);

    const existing = await db
      .select({ id: projectSets.id })
      .from(projectSets)
      .where(and(eq(projectSets.teamId, id), eq(projectSets.name, body.name)))
      .limit(1);
    if (existing.length > 0) throw conflict('同名作品集已存在', 'SET_NAME_TAKEN');

    const inserted = await db
      .insert(projectSets)
      .values({
        teamId: id,
        name: body.name,
        intro: body.intro ?? '',
        orderIndex: body.orderIndex ?? 0,
        createdBy: user.id,
      })
      .returning();
    const created = inserted[0];
    if (!created) throw new Error('创建作品集失败');

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'project_set.create',
      targetType: 'project_set',
      targetId: created.id,
      targetName: created.name,
      ip: clientIp(request),
    });

    reply.code(201);
    return { set: { id: created.id, name: created.name, intro: created.intro } };
  });

  app.patch('/teams/:id/project-sets/:setId', async (request) => {
    const user = await requireAuth(request);
    const { id, setId } = parse(setParam, request.params);
    const access = await requireTeamAccess(id, user);
    if (!access.permissions.has('project_set.edit')) throw forbidden('没有权限修改作品集（需要 project_set.edit）');

    const body = parse(createSetSchema.partial(), request.body);

    const updated = await db
      .update(projectSets)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(projectSets.id, setId), eq(projectSets.teamId, id)))
      .returning({ id: projectSets.id });
    if (updated.length === 0) throw notFound('作品集不存在', 'SET_NOT_FOUND');

    return { ok: true };
  });

  app.delete('/teams/:id/project-sets/:setId', async (request) => {
    const user = await requireAuth(request);
    const { id, setId } = parse(setParam, request.params);
    const access = await requireTeamAccess(id, user);
    if (!access.permissions.has('project_set.delete')) {
      throw forbidden('没有权限删除作品集（需要 project_set.delete）');
    }

    // 不连坐删作品：作品集只是归类，删掉归类不该把作品一起带走。
    // 外键是 ON DELETE SET NULL，作品会自动变成「未归类」。
    const removed = await db
      .delete(projectSets)
      .where(and(eq(projectSets.id, setId), eq(projectSets.teamId, id)))
      .returning({ id: projectSets.id, name: projectSets.name });
    if (removed.length === 0) throw notFound('作品集不存在', 'SET_NOT_FOUND');

    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'project_set.delete',
      targetType: 'project_set',
      targetId: setId,
      targetName: removed[0]?.name ?? '',
      ip: clientIp(request),
    });

    return { ok: true };
  });

  // ── 作品 ──────────────────────────────────────────────────

  app.get('/teams/:id/projects', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(uuidParam, request.params);
    await requireTeamAccess(id, user);

    const query = parse(
      z.object({
        setId: z.string().uuid().optional(),
        ungrouped: z.coerce.boolean().optional(),
        status: z.string().optional(),
        keyword: z.string().trim().max(60).optional(),
      }),
      request.query,
    );

    const rows = await queryProjects({
      teamId: id,
      status: query.status ?? 'active',
      ...(query.ungrouped ? { setId: null } : query.setId ? { setId: query.setId } : {}),
      ...(query.keyword ? { keyword: query.keyword } : {}),
    });

    return { projects: await buildProjectCards(rows, user.id) };
  });

  app.post('/teams/:id/projects', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(uuidParam, request.params);
    const access = await requireTeamAccess(teamId, user);
    if (!access.permissions.has('project.create')) {
      throw forbidden('没有权限创建作品（需要 project.create）');
    }

    const body = parse(createProjectSchema, request.body);

    if (body.setId) {
      const setRows = await db
        .select({ id: projectSets.id })
        .from(projectSets)
        .where(and(eq(projectSets.id, body.setId), eq(projectSets.teamId, teamId)))
        .limit(1);
      if (setRows.length === 0) throw badRequest('作品集不存在或不属于该团队', 'SET_NOT_FOUND');
    }

    const sourceLanguage = normalizeLanguage(body.sourceLanguage ?? 'ja') || 'ja';
    const targetLanguages = [...new Set((body.targetLanguages ?? ['zh-CN']).map(normalizeLanguage))].filter(
      Boolean,
    );
    if (targetLanguages.includes(sourceLanguage)) {
      throw badRequest('目标语言不能与源语言相同', 'LANGUAGE_CONFLICT');
    }

    const created = await db.transaction(async (tx) => {
      // 编号分配：靠团队行上的计数器原子自增。两个请求同时建作品也不会撞号。
      const seqRows = await tx
        .update(teams)
        .set({ projectSeq: sql`${teams.projectSeq} + 1`, updatedAt: new Date() })
        .where(eq(teams.id, teamId))
        .returning({ seq: teams.projectSeq });
      const serial = seqRows[0]?.seq;
      if (serial === undefined) throw new Error('分配作品编号失败');

      const inserted = await tx
        .insert(projects)
        .values({
          teamId,
          setId: body.setId ?? null,
          serial,
          name: body.name,
          intro: body.intro ?? '',
          author: body.author ?? '',
          sourceLanguage,
          createdBy: user.id,
        })
        .returning();
      const project = inserted[0];
      if (!project) throw new Error('创建作品失败');

      // 建作品时把团队的项目角色模板复制成这个作品自己的角色，
      // 之后改某个作品的岗位不会波及同团队其他作品。
      const roleIds = await instantiateProjectRoles(project.id, teamId, tx);
      const creatorRoleId =
        roleIds.get('creator') ?? roleIds.get(DEFAULT_PROJECT_ROLE_SYSTEM_CODE);
      if (!creatorRoleId) throw new Error('初始化作品角色失败');

      await tx.insert(projectMembers).values({
        projectId: project.id,
        userId: user.id,
        projectRoleId: creatorRoleId,
        createdBy: user.id,
      });

      if (targetLanguages.length > 0) {
        await tx
          .insert(targets)
          .values(
            targetLanguages.map((language, index) => ({
              projectId: project.id,
              language,
              label: languageLabel(language),
              orderIndex: index,
            })),
          )
          .onConflictDoNothing();
      }

      return project;
    });

    await logOp({
      actorId: user.id,
      teamId,
      action: 'project.create',
      targetType: 'project',
      targetId: created.id,
      targetName: created.name,
      detail: { serial: created.serial, targetLanguages },
      ip: clientIp(request),
    });

    reply.code(201);
    return {
      project: {
        id: created.id,
        serial: created.serial,
        name: created.name,
        intro: created.intro,
        author: created.author,
        sourceLanguage: created.sourceLanguage,
        setId: created.setId,
      },
    };
  });

  /** 作品详情。**所有作品页面的入口**，一次把界面要用的东西给全。 */
  app.get('/projects/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);

    const [cardRows, roleList, targetList] = await Promise.all([
      db
        .select({ project: projects, teamName: teams.name })
        .from(projects)
        .innerJoin(teams, eq(teams.id, projects.teamId))
        .where(eq(projects.id, id))
        .limit(1),
      listProjectRolesWithPermissions(id),
      db
        .select()
        .from(targets)
        .where(eq(targets.projectId, id))
        .orderBy(asc(targets.orderIndex), asc(targets.label)),
    ]);

    const card = (await buildProjectCards(cardRows, user.id))[0];
    if (!card) throw notFound('作品不存在', 'PROJECT_NOT_FOUND');

    return {
      project: card,
      my: {
        permissions: [...access.permissions].sort(),
        role: access.role
          ? {
              id: access.role.id,
              name: access.role.name,
              level: access.role.level,
              systemCode: access.role.systemCode,
            }
          : null,
        viaTeamRole: access.viaTeamRole,
        isSiteAdmin: access.teamAccess.isSiteAdmin,
      },
      roles: roleList.map((r) => ({
        id: r.id,
        name: r.name,
        level: r.level,
        intro: r.intro,
        isSystem: r.isSystem,
        systemCode: r.systemCode,
        permissions: r.permissions,
      })),
      targets: targetList.map((t) => ({
        id: t.id,
        language: t.language,
        label: t.label,
        orderIndex: t.orderIndex,
      })),
    };
  });

  app.patch('/projects/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.edit');

    const body = parse(updateProjectSchema, request.body);

    if (body.setId) {
      const setRows = await db
        .select({ id: projectSets.id })
        .from(projectSets)
        .where(and(eq(projectSets.id, body.setId), eq(projectSets.teamId, access.project.teamId)))
        .limit(1);
      if (setRows.length === 0) throw badRequest('作品集不存在或不属于该团队', 'SET_NOT_FOUND');
    }

    if (body.sourceLanguage) {
      const sourceLanguage = normalizeLanguage(body.sourceLanguage);
      const existingTargets = await db
        .select({ language: targets.language })
        .from(targets)
        .where(eq(targets.projectId, id));
      if (existingTargets.some((t) => t.language === sourceLanguage)) {
        throw badRequest('源语言不能与已有目标语言相同', 'LANGUAGE_CONFLICT');
      }
      body.sourceLanguage = sourceLanguage;
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.intro !== undefined) patch.intro = body.intro;
    if (body.author !== undefined) patch.author = body.author;
    if (body.sourceLanguage !== undefined) patch.sourceLanguage = body.sourceLanguage;
    if (body.setId !== undefined) patch.setId = body.setId;
    if (body.coverFileId !== undefined) patch.coverFileId = body.coverFileId;

    await db.update(projects).set(patch).where(eq(projects.id, id));

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'project.update',
      targetType: 'project',
      targetId: id,
      targetName: body.name ?? access.project.name,
      detail: body,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  /** 结项 / 归档。用独立的动作而不是 PATCH status —— 它是个语义明确的业务动作。 */
  app.post('/projects/:id/archive', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.finish');

    await db
      .update(projects)
      .set({ status: 'archived', archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(projects.id, id));

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'project.archive',
      targetType: 'project',
      targetId: id,
      targetName: access.project.name,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.post('/projects/:id/unarchive', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.finish');

    await db
      .update(projects)
      .set({ status: 'active', archivedAt: null, updatedAt: new Date() })
      .where(eq(projects.id, id));

    return { ok: true };
  });

  app.delete('/projects/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.delete');

    // 级联删除（外键 ON DELETE CASCADE）会带走文件行。
    // **存储上的图片不清**：真要回收空间得走一个显式的清理任务，
    // 在请求里删几万个文件会让这个接口超时，而且失败一半更难收拾。
    // 这是有意的取舍，清理入口留到 M5 的管理工具里。
    await db.delete(projects).where(eq(projects.id, id));

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'project.delete',
      targetType: 'project',
      targetId: id,
      targetName: access.project.name,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  // ── 作品成员 ──────────────────────────────────────────────

  app.get('/projects/:id/members', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    await requireProjectAccess(id, user);

    const rows = await db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarKey: users.avatarKey,
        status: users.status,
        joinedAt: projectMembers.createdAt,
        roleId: projectRoles.id,
        roleName: projectRoles.name,
        roleLevel: projectRoles.level,
        roleSystemCode: projectRoles.systemCode,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .innerJoin(projectRoles, eq(projectRoles.id, projectMembers.projectRoleId))
      .where(eq(projectMembers.projectId, id))
      .orderBy(sql`${projectRoles.level} DESC`, asc(users.displayName));

    return { members: rows };
  });

  app.get('/projects/:id/member-candidates', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.member.manage');

    return { candidates: await projectMemberCandidates(id, access.project.teamId) };
  });

  app.post('/projects/:id/members', async (request, reply) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.member.manage');

    const body = parse(addMemberSchema, request.body);

    const role = await loadProjectRole(id, body.projectRoleId);
    assertCanManageProjectRole(access, role.level, '该角色');
    await assertProjectRoleAssignable(access, role.permissions);

    // 必须先是团队成员：作品成员表不该成为绕过团队边界的口子。
    const inTeam = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, access.project.teamId), eq(teamMembers.userId, body.userId)))
      .limit(1);
    if (inTeam.length === 0) throw badRequest('该用户不在所属团队中', 'NOT_TEAM_MEMBER');

    const existing = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, body.userId)))
      .limit(1);
    if (existing.length > 0) throw conflict('该成员已在作品中', 'MEMBER_EXISTS');

    await db.insert(projectMembers).values({
      projectId: id,
      userId: body.userId,
      projectRoleId: body.projectRoleId,
      createdBy: user.id,
    });

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'project.member.add',
      targetType: 'project',
      targetId: id,
      targetName: access.project.name,
      detail: { userId: body.userId, role: role.name },
      ip: clientIp(request),
    });

    reply.code(201);
    return { ok: true };
  });

  app.patch('/projects/:id/members/:userId', async (request) => {
    const user = await requireAuth(request);
    const { id, userId } = parse(memberParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.member.manage');

    const body = parse(changeMemberRoleSchema, request.body);

    const current = await db
      .select({ role: projectRoles })
      .from(projectMembers)
      .innerJoin(projectRoles, eq(projectRoles.id, projectMembers.projectRoleId))
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)))
      .limit(1);
    const currentRole = current[0]?.role;
    if (!currentRole) throw notFound('该成员不在作品中', 'MEMBER_NOT_FOUND');

    assertCanManageProjectRole(access, currentRole.level, '该成员');

    const next = await loadProjectRole(id, body.projectRoleId);
    assertCanManageProjectRole(access, next.level, '该角色');
    await assertProjectRoleAssignable(access, next.permissions);

    await db
      .update(projectMembers)
      .set({ projectRoleId: body.projectRoleId })
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)));

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'project.member.change_role',
      targetType: 'project',
      targetId: id,
      targetName: access.project.name,
      detail: { userId, from: currentRole.name, to: next.name },
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.delete('/projects/:id/members/:userId', async (request) => {
    const user = await requireAuth(request);
    const { id, userId } = parse(memberParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.member.manage');

    const current = await db
      .select({ role: projectRoles })
      .from(projectMembers)
      .innerJoin(projectRoles, eq(projectRoles.id, projectMembers.projectRoleId))
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)))
      .limit(1);
    const currentRole = current[0]?.role;
    if (!currentRole) throw notFound('该成员不在作品中', 'MEMBER_NOT_FOUND');

    // 作品创建人是作品的锚：移掉他，就没人能结项、也没有兜底的负责人了。
    if (currentRole.systemCode === 'creator') {
      throw forbidden('作品创建人不能被移出作品');
    }
    assertCanManageProjectRole(access, currentRole.level, '该成员');

    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)));

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'project.member.remove',
      targetType: 'project',
      targetId: id,
      targetName: access.project.name,
      detail: { userId, role: currentRole.name },
      ip: clientIp(request),
    });

    return { ok: true };
  });

  // ── 作品角色 ──────────────────────────────────────────────

  app.post('/projects/:id/roles', async (request, reply) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.member.manage');

    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(16),
        level: z.coerce.number().int().min(1).max(499),
        intro: z.string().trim().max(100).optional(),
        permissions: z.array(z.string()).default([]),
      }),
      request.body,
    );

    assertCanManageProjectRole(access, body.level, '该角色');
    assertPermissionCodesWithinActor(access, body.permissions);
    await assertProjectScopePermissions(body.permissions);

    const inserted = await db
      .insert(projectRoles)
      .values({
        projectId: id,
        teamId: access.project.teamId,
        name: body.name,
        level: body.level,
        intro: body.intro ?? '',
        isSystem: false,
      })
      .onConflictDoNothing()
      .returning({ id: projectRoles.id });

    const roleId = inserted[0]?.id;
    if (!roleId) throw conflict('同名角色已存在', 'ROLE_NAME_TAKEN');

    if (body.permissions.length > 0) {
      await db
        .insert(projectRolePermissions)
        .values(body.permissions.map((code) => ({ projectRoleId: roleId, permissionCode: code })))
        .onConflictDoNothing();
    }

    reply.code(201);
    return { roleId };
  });

  app.patch('/projects/:id/roles/:roleId', async (request) => {
    const user = await requireAuth(request);
    const { id, roleId } = parse(roleParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.member.manage');

    const body = parse(roleBodySchema, request.body);
    const role = await loadProjectRole(id, roleId);

    if (role.systemCode) {
      // 系统角色的**名字与等级不动**：界面上按 systemCode 选图标、
      // 等级参与「谁能管谁」的判定，改动它们会静默改变治理结构。
      // 权限可以调 —— 每个团队对「校对能做什么」的理解本来就不同。
      if (body.name !== undefined && body.name !== role.name) {
        throw badRequest('系统内置角色的名称不可修改', 'SYSTEM_ROLE_LOCKED');
      }
      if (body.level !== undefined && body.level !== role.level) {
        throw badRequest('系统内置角色的等级不可修改', 'SYSTEM_ROLE_LOCKED');
      }
    } else {
      if (body.level !== undefined) assertCanManageProjectRole(access, body.level, '该角色');
      assertCanManageProjectRole(access, role.level, '该角色');
    }

    if (body.permissions) {
      assertPermissionCodesWithinActor(access, body.permissions);
      await assertProjectScopePermissions(body.permissions);
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.level !== undefined) patch.level = body.level;
    if (body.intro !== undefined) patch.intro = body.intro;

    await db.transaction(async (tx) => {
      await tx.update(projectRoles).set(patch).where(eq(projectRoles.id, roleId));

      if (body.permissions) {
        await tx.delete(projectRolePermissions).where(eq(projectRolePermissions.projectRoleId, roleId));
        if (body.permissions.length > 0) {
          await tx
            .insert(projectRolePermissions)
            .values(body.permissions.map((code) => ({ projectRoleId: roleId, permissionCode: code })))
            .onConflictDoNothing();
        }
      }
    });

    return { ok: true };
  });

  app.delete('/projects/:id/roles/:roleId', async (request) => {
    const user = await requireAuth(request);
    const { id, roleId } = parse(roleParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.member.manage');

    const role = await loadProjectRole(id, roleId);
    if (role.isSystem) throw badRequest('系统内置角色不可删除', 'SYSTEM_ROLE_LOCKED');
    assertCanManageProjectRole(access, role.level, '该角色');

    // 还有人挂在这个角色上就不能删 —— 外键是 RESTRICT，直接删会报 500，
    // 这里先查一次给出人话提示。
    const inUse = await db
      .select({ total: count() })
      .from(projectMembers)
      .where(eq(projectMembers.projectRoleId, roleId));
    if (Number(inUse[0]?.total ?? 0) > 0) {
      throw conflict('该角色下还有成员，请先调整他们的角色', 'ROLE_IN_USE');
    }

    await db.delete(projectRoles).where(eq(projectRoles.id, roleId));
    return { ok: true };
  });

  /**
   * 把代码里的默认权限同步到本作品的系统角色上（只加不减）。
   *
   * 作品的系统角色是建作品时从模板**复制**的快照，所以后来在代码里
   * 给某个默认角色加了权限（比如 M3 给「校对」加了打回权），
   * 已有的作品不会自动获得 —— 这时用这个动作补上，
   * 而不是干掉重建（那会丢掉成员的角色关联）。
   */
  app.post('/projects/:id/roles/sync', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'project.member.manage');

    const report = await db.transaction(async (tx) => syncProjectRoleDefaults(id, tx));

    if (report.length > 0) {
      await logOp({
        actorId: user.id,
        teamId: access.project.teamId,
        action: 'project.roles.sync',
        targetType: 'project',
        targetId: id,
        targetName: access.project.name,
        detail: report,
        ip: clientIp(request),
      });
    }

    return { ok: true, report };
  });

  // ── 目标语言 ──────────────────────────────────────────────

  app.post('/projects/:id/targets', async (request, reply) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'target.add');

    const body = parse(
      z.object({ language: z.string().trim().min(1).max(20), label: z.string().trim().max(40).optional() }),
      request.body,
    );

    const language = normalizeLanguage(body.language);
    if (!language) throw badRequest('请填写语言代码', 'INVALID_LANGUAGE');
    if (language === access.project.sourceLanguage) {
      throw badRequest('目标语言不能与源语言相同', 'LANGUAGE_CONFLICT');
    }

    const existing = await db
      .select({ id: targets.id })
      .from(targets)
      .where(and(eq(targets.projectId, id), eq(targets.language, language)))
      .limit(1);
    if (existing.length > 0) throw conflict('该目标语言已存在', 'TARGET_EXISTS');

    const maxOrder = await db
      .select({ max: sql<number>`COALESCE(MAX(${targets.orderIndex}), -1)` })
      .from(targets)
      .where(eq(targets.projectId, id));

    const inserted = await db
      .insert(targets)
      .values({
        projectId: id,
        language,
        label: body.label ?? languageLabel(language),
        orderIndex: Number(maxOrder[0]?.max ?? -1) + 1,
      })
      .returning();
    const created = inserted[0];
    if (!created) throw new Error('新增目标语言失败');

    reply.code(201);
    return { target: { id: created.id, language: created.language, label: created.label } };
  });

  app.patch('/projects/:id/targets/:targetId', async (request) => {
    const user = await requireAuth(request);
    const { id, targetId } = parse(targetParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'target.change');

    const body = parse(
      z.object({ label: z.string().trim().min(1).max(40).optional(), orderIndex: z.coerce.number().int().min(0).max(99).optional() }),
      request.body,
    );

    const updated = await db
      .update(targets)
      .set(body)
      .where(and(eq(targets.id, targetId), eq(targets.projectId, id)))
      .returning({ id: targets.id });
    if (updated.length === 0) throw notFound('目标语言不存在', 'TARGET_NOT_FOUND');

    return { ok: true };
  });

  app.delete('/projects/:id/targets/:targetId', async (request) => {
    const user = await requireAuth(request);
    const { id, targetId } = parse(targetParam, request.params);
    const access = await requireProjectAccess(id, user);
    requireProjectPermission(access, 'target.delete');

    const removed = await db
      .delete(targets)
      .where(and(eq(targets.id, targetId), eq(targets.projectId, id)))
      .returning({ id: targets.id });
    if (removed.length === 0) throw notFound('目标语言不存在', 'TARGET_NOT_FOUND');

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'target.delete',
      targetType: 'project',
      targetId: id,
      targetName: access.project.name,
      detail: { targetId },
      ip: clientIp(request),
    });

    return { ok: true };
  });
}

/**
 * 读一个作品角色，顺便校验它确实属于这个作品。
 *
 * 连权限一起读回来：调用方几乎总是既要判等级、又要判权限集合
 * （「不能让一个人把权限授到他自己都没有的地步」），分成两次查只会多一次往返。
 */
async function loadProjectRole(projectId: string, roleId: string) {
  const rows = await db
    .select()
    .from(projectRoles)
    .where(and(eq(projectRoles.id, roleId), eq(projectRoles.projectId, projectId)))
    .limit(1);
  const role = rows[0];
  if (!role) throw notFound('角色不存在或不属于该作品', 'ROLE_NOT_FOUND');

  const perms = await permissionsOfProjectRoles([roleId]);
  return { ...role, permissions: perms.get(roleId) ?? [] };
}

/** 防提权：不能授予自己都没有的权限（与团队角色同一套规则）。 */
function assertPermissionCodesWithinActor(access: ProjectAccess, codes: readonly string[]): void {
  if (access.teamAccess.isSiteAdmin) return;
  for (const code of codes) {
    if (!access.permissions.has(code)) {
      throw forbidden(`不能授予你自己都没有的权限：${code}`);
    }
  }
}

async function assertProjectRoleAssignable(access: ProjectAccess, permissions: readonly string[]): Promise<void> {
  assertPermissionCodesWithinActor(access, permissions);
  await assertProjectScopePermissions(permissions);
}
