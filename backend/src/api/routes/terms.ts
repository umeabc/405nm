/**
 * 术语库。**归属团队**：术语是团队资产（同一部作品谁翻都该用同一套译名）。
 *
 * 权限用的是旧站就有的那批码（`term_bank.*` / `term.*`），迁移时它们已经挂在角色上了 ——
 * 也就是说这个功能上线时，各团队的既有角色**不用重新配权限**就能用。
 *
 * 批量导入刻意做得很朴素：一行一条，用制表符 / `=>` / `→` / 逗号分隔原文与译文。
 * 术语多半是从聊天记录或表格里贴过来的，要求人先改成 CSV 再上传只会让人不用它。
 */
import { and, asc, eq, inArray, ilike, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { termBanks, terms } from '../../db/schema.js';
import { requirePermission, requireTeamAccess } from '../../domain/authorize.js';
import { conflict, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { clientIp, requireAuth } from '../guards.js';
import { parseOrThrow } from '../file-access.js';

const teamParam = z.object({ id: z.string().uuid('团队 ID 不合法') });
const bankParam = z.object({ bankId: z.string().uuid('术语库 ID 不合法') });
const termParam = z.object({ termId: z.string().uuid('术语 ID 不合法') });

/**
 * 一行一条。分隔符认这几种：制表符、`=>`、`→`、全角/半角逗号。
 * `#` 开头当注释；没有分隔符的行算无效（整行当原文而译文空，导进去只会制造查不到的条目）。
 */
export function parseTermLines(text: string): { entries: Array<{ source: string; target: string }>; skipped: number } {
  const entries: Array<{ source: string; target: string }> = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(.*?)(?:\t|=>|→|,|，)\s*(.*)$/);
    const source = match?.[1]?.trim() ?? '';
    const target = match?.[2]?.trim() ?? '';
    if (!source || !target) {
      skipped += 1;
      continue;
    }
    entries.push({ source, target });
  }
  return { entries, skipped };
}

export async function registerTermRoutes(app: FastifyInstance): Promise<void> {
  app.get('/teams/:id/term-banks', async (request) => {
    const user = await requireAuth(request);
    const { id } = parseOrThrow(teamParam, request.params);
    const access = await requireTeamAccess(id, user);
    requirePermission(access, 'term_bank.access');

    const banks = await db.select().from(termBanks).where(eq(termBanks.teamId, id)).orderBy(asc(termBanks.name));
    const counts = banks.length
      ? await db
          .select({ bankId: terms.bankId, n: sql<number>`count(*)::int` })
          .from(terms)
          .where(inArray(terms.bankId, banks.map((b) => b.id)))
          .groupBy(terms.bankId)
      : [];
    const byBank = new Map(counts.map((c) => [c.bankId, Number(c.n)]));
    return { banks: banks.map((b) => ({ ...b, termCount: byBank.get(b.id) ?? 0 })) };
  });

  app.post('/teams/:id/term-banks', async (request, reply) => {
    const user = await requireAuth(request);
    const { id } = parseOrThrow(teamParam, request.params);
    const access = await requireTeamAccess(id, user);
    requirePermission(access, 'term_bank.create');

    const body = parseOrThrow(
      z.object({ name: z.string().trim().min(1, '给术语库起个名字').max(60), intro: z.string().trim().max(500).default('') }),
      request.body,
    );
    const rows = await db
      .insert(termBanks)
      .values({ teamId: id, name: body.name, intro: body.intro, createdBy: user.id })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (!row) throw conflict('这个团队已经有同名术语库了', 'TERM_BANK_EXISTS');
    await logOp({
      actorId: user.id,
      teamId: id,
      action: 'term_bank.create',
      targetType: 'term_bank',
      targetId: row.id,
      targetName: row.name,
      ip: clientIp(request),
    });
    reply.code(201);
    return { bank: { ...row, termCount: 0 } };
  });

  app.patch('/term-banks/:bankId', async (request) => {
    const user = await requireAuth(request);
    const { bankId } = parseOrThrow(bankParam, request.params);
    const bank = await loadBank(bankId);
    const access = await requireTeamAccess(bank.teamId, user);
    requirePermission(access, 'term_bank.edit');

    const body = parseOrThrow(
      z.object({ name: z.string().trim().min(1).max(60).optional(), intro: z.string().trim().max(500).optional() }),
      request.body,
    );
    const rows = await db
      .update(termBanks)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(termBanks.id, bankId))
      .returning();
    return { bank: rows[0] };
  });

  app.delete('/term-banks/:bankId', async (request) => {
    const user = await requireAuth(request);
    const { bankId } = parseOrThrow(bankParam, request.params);
    const bank = await loadBank(bankId);
    const access = await requireTeamAccess(bank.teamId, user);
    requirePermission(access, 'term_bank.delete');
    await db.delete(termBanks).where(eq(termBanks.id, bankId));
    await logOp({
      actorId: user.id,
      teamId: bank.teamId,
      action: 'term_bank.delete',
      targetType: 'term_bank',
      targetId: bankId,
      targetName: bank.name,
      ip: clientIp(request),
    });
    return { ok: true };
  });

  /** 列表：按语言过滤 + 关键词搜索。术语库会长到几百条，界面上必须能搜。 */
  app.get('/term-banks/:bankId/terms', async (request) => {
    const user = await requireAuth(request);
    const { bankId } = parseOrThrow(bankParam, request.params);
    const bank = await loadBank(bankId);
    const access = await requireTeamAccess(bank.teamId, user);
    requirePermission(access, 'term_bank.access');

    const query = parseOrThrow(
      z.object({
        language: z.string().trim().max(20).optional(),
        q: z.string().trim().max(100).optional(),
      }),
      request.query ?? {},
    );
    const filters = [eq(terms.bankId, bankId)];
    if (query.language) filters.push(eq(terms.language, query.language));
    if (query.q) filters.push(ilike(terms.source, `%${query.q}%`));
    const rows = await db
      .select()
      .from(terms)
      .where(and(...filters))
      .orderBy(asc(terms.source))
      .limit(1000);
    return { bank, terms: rows };
  });

  /**
   * 新增。两种形态：
   *  - `{ language, source, target }`：单条；
   *  - `{ language, text }`：批量粘贴，一行一条。
   * 撞到已有的同源词时**覆盖译文**（术语改个译法是常态，报错只会让人一条条删）。
   */
  app.post('/term-banks/:bankId/terms', async (request, reply) => {
    const user = await requireAuth(request);
    const { bankId } = parseOrThrow(bankParam, request.params);
    const bank = await loadBank(bankId);
    const access = await requireTeamAccess(bank.teamId, user);
    requirePermission(access, 'term.create');

    const body = parseOrThrow(
      z.object({
        language: z.string().trim().min(2, '请选择目标语言').max(20),
        source: z.string().trim().max(500).optional(),
        target: z.string().trim().max(500).optional(),
        text: z.string().max(200000).optional(),
      }),
      request.body,
    );

    const entries = body.text
      ? parseTermLines(body.text).entries
      : body.source && body.target
        ? [{ source: body.source, target: body.target }]
        : [];
    if (entries.length === 0) throw conflict('没有解析出任何术语（一行一条，用制表符或逗号分隔原文与译文）', 'TERM_EMPTY');

    const inserted = await db
      .insert(terms)
      .values(
        entries.map((e) => ({
          bankId,
          language: body.language,
          source: e.source,
          target: e.target,
          createdBy: user.id,
        })),
      )
      .onConflictDoUpdate({
        target: [terms.bankId, terms.language, terms.source],
        set: { target: sql`excluded.target`, updatedAt: new Date() },
      })
      .returning({ id: terms.id });

    await db.update(termBanks).set({ updatedAt: new Date() }).where(eq(termBanks.id, bankId));
    await logOp({
      actorId: user.id,
      teamId: bank.teamId,
      action: 'term.import',
      targetType: 'term_bank',
      targetId: bankId,
      targetName: bank.name,
      detail: { language: body.language, count: inserted.length },
      ip: clientIp(request),
    });
    reply.code(201);
    return { count: inserted.length };
  });

  app.patch('/terms/:termId', async (request) => {
    const user = await requireAuth(request);
    const { termId } = parseOrThrow(termParam, request.params);
    const term = await loadTerm(termId);
    const bank = await loadBank(term.bankId);
    const access = await requireTeamAccess(bank.teamId, user);
    requirePermission(access, 'term.edit');

    const body = parseOrThrow(
      z.object({
        source: z.string().trim().min(1).max(500).optional(),
        target: z.string().trim().min(1).max(500).optional(),
        language: z.string().trim().min(2).max(20).optional(),
        note: z.string().trim().max(500).optional(),
      }),
      request.body,
    );
    const rows = await db
      .update(terms)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(terms.id, termId))
      .returning();
    return { term: rows[0] };
  });

  app.delete('/terms/:termId', async (request) => {
    const user = await requireAuth(request);
    const { termId } = parseOrThrow(termParam, request.params);
    const term = await loadTerm(termId);
    const bank = await loadBank(term.bankId);
    const access = await requireTeamAccess(bank.teamId, user);
    requirePermission(access, 'term.delete');
    await db.delete(terms).where(eq(terms.id, termId));
    return { ok: true };
  });
}

async function loadBank(bankId: string) {
  const rows = await db.select().from(termBanks).where(eq(termBanks.id, bankId)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('术语库不存在', 'TERM_BANK_NOT_FOUND');
  return row;
}

async function loadTerm(termId: string) {
  const rows = await db.select().from(terms).where(eq(terms.id, termId)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('这条术语不存在', 'TERM_NOT_FOUND');
  return row;
}
