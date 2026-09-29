import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  creditDirectory,
  files,
  outputs,
  projects,
  publishJobs,
  publishTemplates,
  publishAccounts,
  targets,
  type User,
} from '../../db/schema.js';
import { requirePermission, requireProjectAccess, requireProjectPermission, requireTeamAccess } from '../../domain/authorize.js';
import { STATE_RANK } from '../../domain/workflow.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { requirePlatform, listPlatforms } from '../../platforms/registry.js';
import { checkAllAccounts, saveCredentials, serializeAccount, verifyAccount } from '../../publish/accounts.js';
import { applyTemplate, languagesWithOutputs, resolveLanguage, suggestSlots } from '../../publish/compose.js';
import { PUBLISH_KINDS, SLOT_LABELS, defaultTemplates } from '../../publish/render.js';
import { clientIp, requireAuth } from '../guards.js';

/**
 * 发布：账号、账号库、模板、草稿与队列。
 *
 * 权限分两层，**两层都要过**：
 *  - 项目域 `publish.create` / `publish.approve` —— 「这条内容可以发」是作品的事；
 *  - 团队域 `publish.schedule` —— 「可以用这个团队的官方号对外发声」是团队的事。
 *
 * 只查项目域的话，一个作品的监理就能把内容发到团队的官方账号上 ——
 * 那是把「团队对外发声」这件更大的事，交给了一个作品级授权。
 */

const teamParam = z.object({ id: z.string().uuid('团队 ID 不合法') });
const projectParam = z.object({ id: z.string().uuid('作品 ID 不合法') });
const jobParam = z.object({ jobId: z.string().uuid('任务 ID 不合法') });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
  return parsed.data;
}

const credentialsSchema = z.object({
  sessdata: z.string().trim().min(1, '请填写 SESSDATA').max(4000),
  biliJct: z.string().trim().min(1, '请填写 bili_jct').max(200),
});

const accountSchema = z.object({
  platform: z.string().trim().min(1).max(32).default('bilibili'),
  label: z.string().trim().min(1, '请填写账号名称').max(40),
  ...credentialsSchema.shape,
});

const jobFieldsSchema = z.object({
  title: z.string().trim().max(120).default(''),
  text: z.string().max(4000).default(''),
  kind: z.enum(PUBLISH_KINDS).default('原创'),
  accountId: z.string().uuid('发布账号不合法').nullable().optional(),
  topic: z.object({ id: z.union([z.string(), z.number()]), name: z.string().trim().max(60) }).nullable().optional(),
  slots: z.record(z.string(), z.object({ name: z.string().max(60).optional(), handle: z.string().max(60).optional(), uid: z.string().max(40).optional() })).optional(),
  images: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string().max(180).default('image.jpg'),
        width: z.coerce.number().int().min(0).default(0),
        height: z.coerce.number().int().min(0).default(0),
      }),
    )
    .max(9)
    .optional(),
});

export async function registerPublishRoutes(app: FastifyInstance): Promise<void> {
  // ══ 发布账号（团队域）══════════════════════════════════════

  app.get('/publish/platforms', async (request) => {
    await requireAuth(request);
    return { platforms: listPlatforms() };
  });

  app.get('/teams/:id/publish/accounts', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    await requireTeamAccess(teamId, user);

    const rows = await db
      .select()
      .from(publishAccounts)
      .where(eq(publishAccounts.teamId, teamId))
      .orderBy(asc(publishAccounts.label));

    // 序列化时只给掩码 —— 这里是凭据不外泄的唯一收口点
    return { accounts: rows.map(serializeAccount) };
  });

  app.post('/teams/:id/publish/accounts', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    const body = parse(accountSchema, request.body);
    try {
      requirePlatform(body.platform);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : '不支持的平台', 'UNSUPPORTED_PLATFORM');
    }

    const inserted = await db
      .insert(publishAccounts)
      .values({ teamId, platform: body.platform, label: body.label, createdBy: user.id })
      .onConflictDoNothing()
      .returning();

    const created = inserted[0];
    if (!created) throw conflict('同名的发布账号已存在', 'ACCOUNT_EXISTS');

    // 建完立刻校验一次：不通就把它标成 expired 并**如实告诉用户**，
    // 而不是留一个「看起来建好了、其实发不出去」的账号。
    const saved = await saveCredentials(created, { sessdata: body.sessdata, biliJct: body.biliJct });

    const rows = await db.select().from(publishAccounts).where(eq(publishAccounts.id, created.id)).limit(1);
    reply.code(201);
    return {
      account: rows[0] ? serializeAccount(rows[0]) : null,
      verified: saved.ok,
      ...(saved.ok ? {} : { warning: saved.error }),
    };
  });

  /** 换凭据。**先校验、通过才覆盖**（见 publish/accounts.ts 的说明）。 */
  app.put('/teams/:id/publish/accounts/:accountId/credentials', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    const { accountId } = parse(z.object({ accountId: z.string().uuid() }), request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    const account = await loadAccount(teamId, accountId);
    const body = parse(credentialsSchema, request.body);

    const result = await saveCredentials(account, { sessdata: body.sessdata, biliJct: body.biliJct });
    if (!result.ok) {
      // 400 而不是 500：这是「你给的 Cookie 不对」，不是服务器坏了
      throw badRequest(result.error, 'CREDENTIAL_REJECTED');
    }

    await logOp({
      actorId: user.id,
      teamId,
      action: 'publish.account.credentials',
      targetType: 'team',
      targetId: teamId,
      targetName: account.label,
      detail: { accountId, platformName: result.profile.name },
      ip: clientIp(request),
    });

    return { account: serializeAccount(result.account), profile: result.profile };
  });

  app.post('/teams/:id/publish/accounts/:accountId/verify', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    const { accountId } = parse(z.object({ accountId: z.string().uuid() }), request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    const account = await loadAccount(teamId, accountId);
    const result = await verifyAccount(account);
    const rows = await db.select().from(publishAccounts).where(eq(publishAccounts.id, accountId)).limit(1);
    return {
      ok: result.ok,
      account: rows[0] ? serializeAccount(rows[0]) : null,
      ...(result.error ? { error: result.error } : {}),
    };
  });

  app.post('/teams/:id/publish/accounts/verify-all', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');
    const report = await checkAllAccounts(() => {});
    return { ok: true, report };
  });

  app.patch('/teams/:id/publish/accounts/:accountId', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    const { accountId } = parse(z.object({ accountId: z.string().uuid() }), request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    const body = parse(
      z.object({ label: z.string().trim().min(1).max(40).optional(), enabled: z.boolean().optional() }),
      request.body,
    );
    await loadAccount(teamId, accountId);

    await db
      .update(publishAccounts)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(publishAccounts.id, accountId));

    const rows = await db.select().from(publishAccounts).where(eq(publishAccounts.id, accountId)).limit(1);
    return { account: rows[0] ? serializeAccount(rows[0]) : null };
  });

  app.delete('/teams/:id/publish/accounts/:accountId', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    const { accountId } = parse(z.object({ accountId: z.string().uuid() }), request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');
    await loadAccount(teamId, accountId);

    // 已排期/已发布的任务里存的是 accountId 外键（set null），删账号不会丢任务，
    // 但那些任务会变成「账号已不存在」—— 所以先拦一道，让运营自己去处理。
    const pending = await db
      .select({ id: publishJobs.id })
      .from(publishJobs)
      .where(and(eq(publishJobs.accountId, accountId), inArray(publishJobs.status, ['draft', 'pending', 'publishing', 'needs_review'])));
    if (pending.length > 0) {
      throw conflict(`还有 ${pending.length} 条未完成的发布任务用着这个账号，先处理它们再删`, 'ACCOUNT_IN_USE');
    }

    await db.delete(publishAccounts).where(eq(publishAccounts.id, accountId));
    return { ok: true };
  });

  // ══ 账号库（署名成员目录）══════════════════════════════════

  app.get('/teams/:id/publish/credits', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    await requireTeamAccess(teamId, user);

    const rows = await db
      .select()
      .from(creditDirectory)
      .where(eq(creditDirectory.teamId, teamId))
      .orderBy(asc(creditDirectory.status), asc(creditDirectory.name));

    return { entries: rows.map(serializeCredit) };
  });

  app.post('/teams/:id/publish/credits', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    const body = parse(
      z.object({
        name: z.string().trim().min(1, '请填写名字').max(60),
        handle: z.string().trim().min(1, '请填写 @ 用的 handle').max(60),
        platformUid: z.string().trim().max(40).default(''),
        note: z.string().trim().max(200).default(''),
      }),
      request.body,
    );

    const inserted = await db
      .insert(creditDirectory)
      .values({ teamId, ...body, handle: body.handle.replace(/^@/, ''), createdBy: user.id })
      .onConflictDoNothing()
      .returning();

    const created = inserted[0];
    if (!created) throw conflict('这个 handle 已经登记过了', 'HANDLE_EXISTS');
    reply.code(201);
    return { entry: serializeCredit(created) };
  });

  app.patch('/teams/:id/publish/credits/:entryId', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    const { entryId } = parse(z.object({ entryId: z.string().uuid() }), request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        handle: z.string().trim().min(1).max(60).optional(),
        platformUid: z.string().trim().max(40).optional(),
        status: z.enum(['active', 'left']).optional(),
        note: z.string().trim().max(200).optional(),
      }),
      request.body,
    );

    const rows = await db
      .update(creditDirectory)
      .set({
        ...body,
        ...(body.handle ? { handle: body.handle.replace(/^@/, '') } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(creditDirectory.id, entryId), eq(creditDirectory.teamId, teamId)))
      .returning();

    if (!rows[0]) throw notFound('这条记录不存在', 'CREDIT_NOT_FOUND');
    return { entry: serializeCredit(rows[0]) };
  });

  app.delete('/teams/:id/publish/credits/:entryId', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    const { entryId } = parse(z.object({ entryId: z.string().uuid() }), request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    await db
      .delete(creditDirectory)
      .where(and(eq(creditDirectory.id, entryId), eq(creditDirectory.teamId, teamId)));
    return { ok: true };
  });

  // ══ 正文模板 ═══════════════════════════════════════════════

  app.get('/teams/:id/publish/templates', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    await requireTeamAccess(teamId, user);

    let rows = await db
      .select()
      .from(publishTemplates)
      .where(eq(publishTemplates.teamId, teamId))
      .orderBy(asc(publishTemplates.name));

    // 团队一个模板都没有时，塞两份默认的进去 —— 空的模板列表会让「生成发布草稿」
    // 看起来像个没做完的功能。
    if (rows.length === 0) {
      await db
        .insert(publishTemplates)
        .values(defaultTemplates().map((t) => ({ ...t, teamId })))
        .onConflictDoNothing();
      rows = await db
        .select()
        .from(publishTemplates)
        .where(eq(publishTemplates.teamId, teamId))
        .orderBy(asc(publishTemplates.name));
    }

    return { templates: rows };
  });

  app.post('/teams/:id/publish/templates', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    const body = parse(
      z.object({
        name: z.string().trim().min(1, '请填写模板名').max(40),
        content: z.string().min(1, '请填写正文模板').max(4000),
        maxImages: z.coerce.number().int().min(0).max(9).default(9),
        variables: z.array(z.object({ key: z.string().max(40), label: z.string().max(40), type: z.string().max(20), placeholder: z.string().max(120).default('') })).max(20).default([]),
      }),
      request.body,
    );

    const inserted = await db
      .insert(publishTemplates)
      .values({ teamId, ...body, createdBy: user.id })
      .onConflictDoNothing()
      .returning();

    if (!inserted[0]) throw conflict('同名模板已存在', 'TEMPLATE_EXISTS');
    reply.code(201);
    return { template: inserted[0] };
  });

  app.delete('/teams/:id/publish/templates/:templateId', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    const { templateId } = parse(z.object({ templateId: z.string().uuid() }), request.params);
    requirePermission(await requireTeamAccess(teamId, user), 'publish.account.manage');

    await db
      .delete(publishTemplates)
      .where(and(eq(publishTemplates.id, templateId), eq(publishTemplates.teamId, teamId)));
    return { ok: true };
  });

  // ══ 草稿 ═══════════════════════════════════════════════════

  /** 生成草稿前的素材：能发哪个语言、默认署名、可用账号、模板。 */
  app.get('/projects/:id/publish/prepare', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'publish.create');

    const query = parse(z.object({ kind: z.enum(PUBLISH_KINDS).default('翻嵌') }), request.query);

    const [languages, accounts, templates, slots, filesReady] = await Promise.all([
      languagesWithOutputs(projectId),
      db.select().from(publishAccounts).where(and(eq(publishAccounts.teamId, access.project.teamId), eq(publishAccounts.enabled, true))),
      db.select().from(publishTemplates).where(eq(publishTemplates.teamId, access.project.teamId)),
      suggestSlots(projectId, query.kind),
      db
        .select({ state: files.state, id: files.id })
        .from(files)
        .where(and(eq(files.projectId, projectId), isNull(files.deletedAt))),
    ]);

    // 可发布的门槛与状态机一致：全部文件都要 ≥ typeset
    const notReady = filesReady.filter((f) => rankOfState(f.state) < STATE_RANK.typeset).length;

    return {
      languages,
      accounts: accounts.map(serializeAccount),
      templates,
      slots,
      slotLabels: SLOT_LABELS,
      kinds: PUBLISH_KINDS,
      filesTotal: filesReady.length,
      filesNotReady: notReady,
      canPublish: notReady === 0 && filesReady.length > 0,
    };
  });

  /**
   * 生成草稿。
   *
   * **图片在这里就快照下来**（取该语言下每张图的最新成品）：任务一旦入队，
   * 后面成品换版本、作品被改，都不该影响一条已经排好期的动态。
   */
  app.post('/projects/:id/publish/drafts', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'publish.create');

    const body = parse(
      jobFieldsSchema.extend({
        targetId: z.string().uuid().nullable().optional(),
        /** 客户端可以带一个幂等键，重复提交（双击、重试）不会产生两条草稿 */
        idempotencyKey: z.string().trim().min(8).max(80).optional(),
        variables: z.record(z.string(), z.unknown()).optional(),
        templateId: z.string().uuid().optional(),
      }),
      request.body,
    );

    // 先按 targetId 定语言；没传就落到「作品只有一种目标语言时取它」——
    // 少了这一步，单语言作品不传 targetId 时会拿空串去查成品，一条都查不到。
    const requested = body.targetId ? await languageOfTarget(projectId, body.targetId) : undefined;
    const language = await resolveLanguage(projectId, requested);
    const images = body.images?.length ? body.images : await snapshotOutputs(projectId, language);

    // 有的语言一张成品都没有 —— 生成一个没有图的草稿没有意义，直接说清楚
    if (images.length === 0) {
      throw badRequest('这个作品还没有可发布的成品图（先让嵌字回传成品）', 'NO_OUTPUTS');
    }

    // 模板变量在保存时就渲染一次，让运营立刻看到成品正文；
    // 发布时 renderFinalText 还会再补署名与提及（那次才是权威的）
    let text = body.text;
    if (body.templateId) {
      const tplRows = await db
        .select()
        .from(publishTemplates)
        .where(and(eq(publishTemplates.id, body.templateId), eq(publishTemplates.teamId, access.project.teamId)))
        .limit(1);
      const tpl = tplRows[0];
      if (!tpl) throw notFound('模板不存在', 'TEMPLATE_NOT_FOUND');
      text = applyTemplate(tpl.content, body.variables ?? {}, body.slots ?? {});
    }

    const inserted = await db
      .insert(publishJobs)
      .values({
        teamId: access.project.teamId,
        projectId,
        language,
        accountId: body.accountId ?? null,
        createdBy: user.id,
        idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(),
        kind: body.kind,
        title: body.title,
        text,
        topic: body.topic ?? null,
        slots: body.slots ?? {},
        images: images.map((i) => ({ key: i.key, name: i.name, width: i.width ?? 0, height: i.height ?? 0 })),
        status: 'draft',
      })
      .onConflictDoNothing({ target: publishJobs.idempotencyKey })
      .returning();

    let created = inserted[0];
    if (!created) {
      // 幂等键撞了：说明是同一次提交的重放，把原来那条还给他
      const existing = await db
        .select()
        .from(publishJobs)
        .where(eq(publishJobs.idempotencyKey, body.idempotencyKey ?? ''))
        .limit(1);
      created = existing[0];
      if (!created) throw conflict('生成草稿失败', 'DRAFT_FAILED');
      reply.code(200);
      return { job: serializeJob(created), reused: true };
    }

    reply.code(201);
    return { job: serializeJob(created), reused: false };
  });

  // ══ 队列 ═══════════════════════════════════════════════════

  app.get('/teams/:id/publish/jobs', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(teamParam, request.params);
    await requireTeamAccess(teamId, user);

    const query = parse(
      z.object({ status: z.string().trim().max(20).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      request.query,
    );

    const conditions = [eq(publishJobs.teamId, teamId)];
    if (query.status) conditions.push(eq(publishJobs.status, query.status));

    const rows = await db
      .select()
      .from(publishJobs)
      .where(and(...conditions))
      // 默认按排期倒序：最近要发的在最上面
      .orderBy(desc(publishJobs.scheduledAt), desc(publishJobs.createdAt))
      .limit(query.limit);

    return { jobs: rows.map(serializeJob) };
  });

  app.get('/projects/:id/publish/jobs', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    await requireProjectAccess(projectId, user);

    const rows = await db
      .select()
      .from(publishJobs)
      .where(eq(publishJobs.projectId, projectId))
      .orderBy(desc(publishJobs.createdAt))
      .limit(50);

    return { jobs: rows.map(serializeJob) };
  });

  app.get('/publish/jobs/:jobId', async (request) => {
    const user = await requireAuth(request);
    const { jobId } = parse(jobParam, request.params);
    const job = await loadJobForUser(jobId, user);
    return { job: serializeJob(job) };
  });

  /** 改草稿。**只有草稿能改** —— 已排期的任务改动会让「什么时候发什么」失去意义。 */
  app.patch('/publish/jobs/:jobId', async (request) => {
    const user = await requireAuth(request);
    const { jobId } = parse(jobParam, request.params);
    const job = await loadJobForUser(jobId, user);
    await requireProjectPermission(
      await requireProjectAccess(job.projectId!, user),
      'publish.create',
    );

    if (job.status !== 'draft') {
      throw conflict('只有草稿可以修改；已排期的任务请先取消再改', 'NOT_DRAFT');
    }

    const body = parse(jobFieldsSchema.partial(), request.body);
    const rows = await db
      .update(publishJobs)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(publishJobs.id, jobId))
      .returning();

    return { job: serializeJob(rows[0]!) };
  });

  /**
   * 排期 / 立即发布。
   *
   * 两道闸门都要过：项目域 `publish.approve`（这条内容可以发）+
   * 团队域 `publish.schedule`（可以用团队的官方号对外发声）。
   */
  app.post('/publish/jobs/:jobId/schedule', async (request) => {
    const user = await requireAuth(request);
    const { jobId } = parse(jobParam, request.params);
    const job = await loadJobForUser(jobId, user);

    const access = await requireProjectAccess(job.projectId!, user);
    requireProjectPermission(access, 'publish.approve');
    requirePermission(await requireTeamAccess(job.teamId, user), 'publish.schedule');

    if (!job.accountId) throw badRequest('还没有选择发布账号', 'NO_ACCOUNT');
    if (!job.images || (Array.isArray(job.images) && job.images.length === 0)) {
      throw badRequest('草稿里一张图都没有', 'NO_IMAGES');
    }

    const body = parse(
      z.object({ scheduledAt: z.string().datetime({ offset: true }).nullable().optional() }),
      request.body,
    );

    // 不给时间就是「现在发」—— 排到当前时刻的下一个 tick
    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();

    const rows = await db
      .update(publishJobs)
      .set({
        status: 'pending',
        scheduledAt,
        attempts: 0,
        lastError: '',
        claimedAt: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(publishJobs.id, jobId), inArray(publishJobs.status, ['draft', 'failed', 'canceled'])))
      .returning();

    if (!rows[0]) throw conflict('这条任务当前的状态不允许排期', 'BAD_STATUS');

    await logOp({
      actorId: user.id,
      teamId: job.teamId,
      action: 'publish.schedule',
      targetType: 'project',
      targetId: job.projectId ?? job.teamId,
      targetName: access.project.name,
      detail: { jobId, scheduledAt: scheduledAt.toISOString() },
      ip: clientIp(request),
    });

    return { job: serializeJob(rows[0]) };
  });

  app.post('/publish/jobs/:jobId/cancel', async (request) => {
    const user = await requireAuth(request);
    const { jobId } = parse(jobParam, request.params);
    const job = await loadJobForUser(jobId, user);
    await requireProjectPermission(await requireProjectAccess(job.projectId!, user), 'publish.create');

    if (job.status === 'published' || job.status === 'publishing') {
      throw conflict('已经发出去了或正在发，无法取消', 'CANNOT_CANCEL');
    }

    const rows = await db
      .update(publishJobs)
      .set({ status: 'canceled', claimedAt: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(publishJobs.id, jobId))
      .returning();

    return { job: serializeJob(rows[0]!) };
  });

  /**
   * 人工处置「不确定发出去了没有」的任务。
   *
   * 两个动作，**必须显式说明发生了什么**：
   *  - `confirmed`：我去 B 站看过了，确实发出去了 → 回填链接，收尾；
   *  - `notPublished`：确实没发出去 → 重新排队（这时才允许重发）。
   *
   * 界面上的文案要把这两个选项的后果写清楚，别让人随手点。
   */
  app.post('/publish/jobs/:jobId/resolve', async (request) => {
    const user = await requireAuth(request);
    const { jobId } = parse(jobParam, request.params);
    const job = await loadJobForUser(jobId, user);

    const access = await requireProjectAccess(job.projectId!, user);
    requireProjectPermission(access, 'publish.approve');
    requirePermission(await requireTeamAccess(job.teamId, user), 'publish.schedule');

    if (job.status !== 'needs_review') {
      throw conflict('只有「待人工确认」的任务需要这样处理', 'NOT_NEEDS_REVIEW');
    }

    const body = parse(
      z.object({
        outcome: z.enum(['confirmed', 'notPublished']),
        externalUrl: z.string().trim().max(300).default(''),
      }),
      request.body,
    );

    if (body.outcome === 'confirmed') {
      const rows = await db
        .update(publishJobs)
        .set({
          status: 'published',
          publishedAt: job.publishedAt ?? new Date(),
          externalUrl: body.externalUrl || job.externalUrl,
          lastError: '',
          updatedAt: new Date(),
        })
        .where(eq(publishJobs.id, jobId))
        .returning();
      return { job: serializeJob(rows[0]!) };
    }

    const rows = await db
      .update(publishJobs)
      .set({
        status: 'pending',
        scheduledAt: new Date(),
        attempts: 0,
        claimedAt: null,
        leaseExpiresAt: null,
        lastError: '人工确认未发出，重新排队',
        updatedAt: new Date(),
      })
      .where(eq(publishJobs.id, jobId))
      .returning();

    return { job: serializeJob(rows[0]!) };
  });
}

// ── 内部工具 ────────────────────────────────────────────────

async function loadAccount(teamId: string, accountId: string) {
  const rows = await db
    .select()
    .from(publishAccounts)
    .where(and(eq(publishAccounts.id, accountId), eq(publishAccounts.teamId, teamId)))
    .limit(1);
  const account = rows[0];
  if (!account) throw notFound('发布账号不存在', 'ACCOUNT_NOT_FOUND');
  return account;
}

async function loadJobForUser(jobId: string, user: User) {
  const rows = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job) throw notFound('发布任务不存在', 'JOB_NOT_FOUND');
  // 走团队访问权：任务可能没有关联作品（比如纯公告），那条路径也必须是安全的
  await requireTeamAccess(job.teamId, user);
  return job;
}

async function languageOfTarget(projectId: string, targetId: string): Promise<string> {
  const rows = await db
    .select({ language: targets.language })
    .from(targets)
    .where(and(eq(targets.id, targetId), eq(targets.projectId, projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('该作品下没有这个目标语言', 'TARGET_NOT_FOUND');
  return row.language;
}

/** 未使用，保留说明：语言解析现在统一走 publish/compose.ts 的 resolveLanguage。 */

/** 取该语言下每张图的最新成品，按自然序。**这就是「一键导出发布包」的那一步。** */
async function snapshotOutputs(projectId: string, language: string) {
  const fileRows = await db
    .select({ id: files.id, name: files.name })
    .from(files)
    .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), eq(files.activated, true)))
    .orderBy(asc(files.sortName));

  if (fileRows.length === 0) return [];

  const outputRows = await db
    .select({ fileId: outputs.fileId, storageKey: outputs.storageKey, name: outputs.name, version: outputs.version })
    .from(outputs)
    .where(and(inArray(outputs.fileId, fileRows.map((f) => f.id)), eq(outputs.language, language)))
    .orderBy(asc(outputs.fileId), desc(outputs.version));

  const latest = new Map<string, { storageKey: string; name: string }>();
  for (const row of outputRows) {
    if (!latest.has(row.fileId)) latest.set(row.fileId, { storageKey: row.storageKey, name: row.name });
  }

  return fileRows
    .map((file) => {
      const out = latest.get(file.id);
      if (!out) return null;
      const stem = file.name.replace(/\.[^.]*$/, '') || file.name;
      const ext = out.name.match(/\.[^.]{1,8}$/)?.[0] ?? '.png';
      return { key: out.storageKey, name: `${stem}${ext}`, width: 0, height: 0 };
    })
    .filter((v): v is { key: string; name: string; width: number; height: number } => v !== null);
}

function serializeCredit(row: typeof creditDirectory.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    platformUid: row.platformUid,
    status: row.status,
    note: row.note,
    /** 界面上要能一眼看出「这个人的 @ 点了没反应」是因为没填 uid */
    mentionable: row.platformUid !== '',
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeJob(row: typeof publishJobs.$inferSelect) {
  return {
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    language: row.language,
    accountId: row.accountId,
    kind: row.kind,
    title: row.title,
    text: row.text,
    topic: row.topic,
    mentions: row.mentions,
    slots: row.slots,
    images: row.images,
    status: row.status,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    externalUrl: row.externalUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 未知状态按 0 算（= 最靠前）。
 *
 * 库里存的是 text，理论上可能出现代码不认识的状态（回滚版本、迁移进来的旧值）。
 * 那种时候判成「还没到嵌字」是**安全侧**：宁可拦住一次发布让人来问，
 * 也不要拿一个不认识的状态去放行。
 */
function rankOfState(state: string): number {
  return STATE_RANK[state as keyof typeof STATE_RANK] ?? 0;
}
