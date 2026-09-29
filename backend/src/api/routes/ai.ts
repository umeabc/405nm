/**
 * AI 机翻：模型配置 + 标号提案 + 译文提案。
 *
 * 权限是**两层都过**（与发布一致）：
 *  - 团队域 `quota.ocr` / `quota.mt` —— 「这个团队能不能用机翻额度和识别额度」是团队的事；
 *  - 项目域 `label.add` / `tra.add` —— 「往这个作品里写标号/译文」是作品的事。
 * 提案（propose）只要团队侧那层：它不写任何东西，但**要花钱**。
 *
 * 「只出提案」是本文件的核心约定：propose 一律不落库，apply 是独立的一次请求，
 * 由人看过之后再点。所以这里所有涉及写入的路由都叫 `/ai/...`（apply），
 * 而 propose 路由只读。
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { aiProviders, files, sources, targets, termBanks, terms } from '../../db/schema.js';
import { env } from '../../env.js';
import { languageLabel } from '../../domain/languages.js';
import { requirePermission, requireTeamAccess } from '../../domain/authorize.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { probeImage } from '../../lib/image.js';
import { logOp } from '../../lib/oplog.js';
import { variantKey } from '../../storage/keys.js';
import { storage } from '../../storage/index.js';
import { AiError } from '../../ai/client.js';
import { applyMarkers, applyTranslations } from '../../ai/apply.js';
import { proposeMarkers, type MarkerProposal } from '../../ai/markers.js';
import { credentialsPatch, listProviders, loadProviderConfig, toPublicProvider } from '../../ai/providers.js';
import { matchGlossary, proposeTranslations, type GlossaryEntry } from '../../ai/translate.js';
import { loadAccessibleFile, parseOrThrow } from '../file-access.js';
import { clientIp, requireAuth } from '../guards.js';

const fileParam = z.object({ id: z.string().uuid('文件 ID 不合法') });
const providerParam = z.object({ id: z.string().uuid('配置 ID 不合法') });

const providerInput = z.object({
  name: z.string().trim().min(1, '给这份配置起个名字').max(40),
  baseUrl: z
    .string()
    .trim()
    .url('接口地址要是一个完整网址，例如 https://api.openai.com/v1')
    .refine((v) => /^https?:\/\//.test(v), '只支持 http/https'),
  chatModel: z.string().trim().max(120).default(''),
  visionModel: z.string().trim().max(120).default(''),
  /** 省略 = 不改动已存的 key；空串 = 清掉 */
  apiKey: z.string().trim().max(400).optional(),
  proxyUrl: z.union([z.string().trim().max(300), z.literal('')]).optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const markerSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1).default(0),
  h: z.number().min(0).max(1).default(0),
  text: z.string().trim().min(1).max(4000),
  positionType: z.enum(['in', 'out']).default('in'),
});

/** 前端只需要「有没有配出口」这个事实，不需要地址本身。 */
const siteHints = () => ({ defaultProxyConfigured: Boolean(env.SOURCING_PROXY) });

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  // ── 模型配置（只动自己的）────────────────────────────────
  app.get('/ai/providers', async (request) => {
    const user = await requireAuth(request);
    const rows = await listProviders(user.id);
    return { providers: rows.map(toPublicProvider), site: siteHints() };
  });

  app.post('/ai/providers', async (request, reply) => {
    const user = await requireAuth(request);
    const body = parseOrThrow(providerInput, request.body);
    const rows = await db
      .insert(aiProviders)
      .values({
        userId: user.id,
        name: body.name,
        baseUrl: body.baseUrl.replace(/\/+$/, ''),
        chatModel: body.chatModel,
        visionModel: body.visionModel,
        credentials: credentialsPatch(body.apiKey, ''),
        proxyUrl: body.proxyUrl ?? '',
        isDefault: body.isDefault ?? false,
        enabled: body.enabled ?? true,
      })
      .returning();
    const row = rows[0]!;
    if (row.isDefault) await clearOtherDefaults(user.id, row.id);
    await logOp({
      actorId: user.id,
      action: 'ai.provider.create',
      targetType: 'ai_provider',
      targetId: row.id,
      targetName: row.name,
      ip: clientIp(request),
    });
    reply.code(201);
    return { provider: toPublicProvider(row) };
  });

  app.patch('/ai/providers/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = parseOrThrow(providerParam, request.params);
    const body = parseOrThrow(providerInput.partial(), request.body);
    const existing = await ownProvider(user.id, id);

    const rows = await db
      .update(aiProviders)
      .set({
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl.replace(/\/+$/, '') }),
        ...(body.chatModel === undefined ? {} : { chatModel: body.chatModel }),
        ...(body.visionModel === undefined ? {} : { visionModel: body.visionModel }),
        ...(body.proxyUrl === undefined ? {} : { proxyUrl: body.proxyUrl }),
        ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.apiKey === undefined ? {} : { credentials: credentialsPatch(body.apiKey, existing.credentials) }),
        updatedAt: new Date(),
      })
      .where(eq(aiProviders.id, id))
      .returning();
    const row = rows[0]!;
    if (row.isDefault) await clearOtherDefaults(user.id, row.id);
    return { provider: toPublicProvider(row) };
  });

  app.delete('/ai/providers/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = parseOrThrow(providerParam, request.params);
    await ownProvider(user.id, id);
    await db.delete(aiProviders).where(eq(aiProviders.id, id));
    return { ok: true };
  });

  // ── 自动标号：提案 → 应用 ────────────────────────────────
  app.post('/files/:id/ai/markers/propose', async (request) => {
    const user = await requireAuth(request);
    const { id } = parseOrThrow(fileParam, request.params);
    const body = parseOrThrow(
      z.object({ providerId: z.string().uuid().nullish(), hint: z.string().trim().max(200).optional() }),
      request.body ?? {},
    );
    const { file, access } = await loadAccessibleFile(id, user);
    // 「能不能用识别额度」是团队的决定；这一路不写库，但**要花钱**
    requirePermission(access.teamAccess, 'quota.ocr');

    const provider = await loadProviderConfig(user.id, body.providerId);
    if (!provider.visionModel) throw badRequest('这份模型配置没有指定「识图模型」', 'AI_NO_VISION_MODEL');

    const image = await loadVisionImage(file);
    const existing = await db.select({ x: sources.x, y: sources.y }).from(sources).where(eq(sources.fileId, id));
    const result = await proposeMarkers({ provider, image, existing, ...(body.hint ? { hint: body.hint } : {}) }).catch(asAppError);
    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'ai.markers.propose',
      targetType: 'file',
      targetId: id,
      targetName: file.name,
      detail: { count: result.proposals.length, model: result.model },
      ip: clientIp(request),
    });
    return { ...result, existing: existing.length };
  });

  app.post('/files/:id/ai/markers', async (request) => {
    const user = await requireAuth(request);
    const { id } = parseOrThrow(fileParam, request.params);
    const body = parseOrThrow(z.object({ markers: z.array(markerSchema).min(1).max(200) }), request.body);
    const { file, access } = await loadAccessibleFile(id, user, 'label.add');

    const created = await applyMarkers(id, body.markers as MarkerProposal[], user.id);
    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'ai.markers.apply',
      targetType: 'file',
      targetId: id,
      targetName: file.name,
      detail: { created: created.created },
      ip: clientIp(request),
    });
    return created;
  });

  // ── 机翻：提案 → 应用 ────────────────────────────────────
  app.post('/files/:id/ai/translations/propose', async (request) => {
    const user = await requireAuth(request);
    const { id } = parseOrThrow(fileParam, request.params);
    const body = parseOrThrow(
      z.object({
        targetId: z.string().uuid('目标语言 ID 不合法'),
        providerId: z.string().uuid().nullish(),
        bankIds: z.array(z.string().uuid()).max(20).optional(),
      }),
      request.body,
    );
    const { file, access } = await loadAccessibleFile(id, user);
    requirePermission(access.teamAccess, 'quota.mt');

    const target = await loadTarget(access.project.id, body.targetId);
    const provider = await loadProviderConfig(user.id, body.providerId);
    if (!provider.chatModel) throw badRequest('这份模型配置没有指定「对话模型」', 'AI_NO_CHAT_MODEL');

    // 只翻有原文的标号：空原文没有可翻的东西，翻出来是噪声
    const rows = await db
      .select({ id: sources.id, content: sources.content })
      .from(sources)
      .where(eq(sources.fileId, id))
      .orderBy(asc(sources.orderIndex), asc(sources.createdAt));
    const items = rows.filter((row) => row.content.trim() !== '').map((row) => ({ id: row.id, text: row.content }));
    if (items.length === 0) throw badRequest('这一页还没有标号原文，先打标号或跑一次自动标号', 'AI_NOTHING_TO_TRANSLATE');

    const glossary = await loadGlossary(access.project.teamId, target.language, body.bankIds);
    const used = matchGlossary(items.map((i) => i.text), glossary, env.AI_GLOSSARY_LIMIT);
    const result = await proposeTranslations({
      provider,
      targetLabel: languageLabel(target.language) || target.label,
      items,
      glossary: used,
      context: `作品《${access.project.name}》，页名「${file.name}」，目标语言 ${target.language}`,
    }).catch(asAppError);
    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'ai.translations.propose',
      targetType: 'file',
      targetId: id,
      targetName: file.name,
      detail: { target: target.language, count: result.proposals.length, model: result.model },
      ip: clientIp(request),
    });
    return { ...result, targetId: target.id, requested: items.length };
  });

  app.post('/files/:id/ai/translations', async (request) => {
    const user = await requireAuth(request);
    const { id } = parseOrThrow(fileParam, request.params);
    const body = parseOrThrow(
      z.object({
        targetId: z.string().uuid('目标语言 ID 不合法'),
        items: z.array(z.object({ sourceId: z.string().uuid(), translated: z.string().max(4000) })).min(1).max(500),
      }),
      request.body,
    );
    const { file, access } = await loadAccessibleFile(id, user, 'tra.add');
    const target = await loadTarget(access.project.id, body.targetId);

    const result = await applyTranslations({
      fileId: id,
      targetId: target.id,
      items: body.items,
      actorId: user.id,
    });
    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'ai.translations.apply',
      targetType: 'file',
      targetId: id,
      targetName: file.name,
      detail: { ...result, skipped: result.skipped.length },
      ip: clientIp(request),
    });
    return result;
  });
}

/** 目标语言必须属于这个作品：拿别的作品的 targetId 来写，等于把译文写到别人那里去。 */
async function loadTarget(projectId: string, targetId: string) {
  const rows = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, targetId), eq(targets.projectId, projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw badRequest('目标语言不属于这个作品', 'TARGET_PROJECT_MISMATCH');
  return row;
}


/** 一份配置只能是自己名下的 —— 拿别人的 id 来问，一律当作不存在。 */
async function ownProvider(userId: string, id: string) {
  const rows = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw badRequest('这份模型配置不存在', 'AI_PROVIDER_MISSING');
  return row;
}

/** 默认配置只能有一份：设了新的就把旧的摘掉，免得「到底在用哪个」靠猜。 */
async function clearOtherDefaults(userId: string, keepId: string): Promise<void> {
  await db
    .update(aiProviders)
    .set({ isDefault: false })
    .where(and(eq(aiProviders.userId, userId), eq(aiProviders.isDefault, true), ne(aiProviders.id, keepId)));
}

/**
 * 模型层的错误 → 业务错误。**分类要如实映射**：
 * key 不对是 401、被限流是 429、上游挂了是 502 —— 全塞进 500 的话，
 * 界面上只会看到「服务器内部错误」，而真正的原因（key 配错了）根本读不出来。
 */
function asAppError(err: unknown): never {
  if (err instanceof AiError) {
    const status = err.code === 'CONFIG' ? 400 : err.code === 'AUTH' ? 401 : err.code === 'RATE_LIMITED' ? 429 : 502;
    throw new AppError(`AI_${err.code}`, err.message, status, err.detail);
  }
  throw err;
}

/** 送给模型的那张图：优先用预览变体（2000px），模型自己也会缩图，传原图只是白花流量。 */
async function loadVisionImage(file: { storageKey: string }): Promise<{ dataUrl: string; width: number; height: number }> {
  const buffer =
    (await storage.getBuffer(variantKey(file.storageKey, 'preview'))) ??
    (await storage.getBuffer(file.storageKey));
  if (!buffer) throw badRequest('这张图还没有可用的图片字节', 'FILE_BYTES_MISSING');
  const meta = await probeImage(buffer);
  const mime = meta.format === 'jpg' ? 'jpeg' : meta.format;
  return {
    dataUrl: `data:image/${mime};base64,${buffer.toString('base64')}`,
    width: meta.width,
    height: meta.height,
  };
}

/** 术语库里的词（按语言过滤），供机翻命中。 */
async function loadGlossary(teamId: string, language: string, bankIds?: readonly string[]): Promise<GlossaryEntry[]> {
  const banks = await db.select({ id: termBanks.id }).from(termBanks).where(eq(termBanks.teamId, teamId));
  const allowed = new Set(banks.map((b) => b.id));
  const wanted = (bankIds?.length ? bankIds : [...allowed]).filter((id) => allowed.has(id));
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ source: terms.source, target: terms.target })
    .from(terms)
    .where(and(inArray(terms.bankId, wanted), eq(terms.language, language)));
  return rows;
}
