import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbLike } from '../db/client.js';
import { fileCredits, users } from '../db/schema.js';

/**
 * 署名台账。
 *
 * 参考实现把「谁翻译了这张图」存成文件上的**自由文本串**（多人用 `、` 连接），
 * 由此带来一串问题：没有历史、覆盖即抹除、改个昵称要全库替换、
 * 统计得靠解析字符串、同名的人无法区分。这里改成台账：
 * 一行一条记录，显示串**派生**出来。
 *
 * 显示顺序 = `created_at` 顺序。这一条同时约束了迁移：
 * 从 moeflow 的自由文本串拆出来的名字，必须**按原 token 顺序插入**，
 * 否则署名会静默变序 —— 而署名顺序在组内是有讲究的。
 */

export const CREDIT_ROLES = ['translator', 'proofreader', 'typesetter', 'supervisor'] as const;
export type CreditRole = (typeof CREDIT_ROLES)[number];

export const CREDIT_ROLE_LABELS: Readonly<Record<CreditRole, string>> = {
  translator: '翻译',
  proofreader: '校对',
  typesetter: '嵌字',
  supervisor: '监理',
};

export function isCreditRole(value: string): value is CreditRole {
  return (CREDIT_ROLES as readonly string[]).includes(value);
}

export type CreditInput = {
  fileId: string;
  teamId: string;
  role: CreditRole;
  /** 站内用户。为空时用 displayName 记外部署名（迁移来的自由文本） */
  userId?: string | null;
  displayName?: string;
  /** auto = 系统按动作记的，manual = 人手工加的 */
  source?: 'auto' | 'manual';
  createdBy?: string | null;
};

/**
 * 记一笔署名。**幂等**：同一个人在同一文件同一角色上只会有一行
 * （靠 `(file_id, role, user_id)` 唯一键 + `ON CONFLICT DO NOTHING`）。
 *
 * 幂等这一点很要紧：翻译保存、状态推进、批量操作都可能触发记账，
 * 如果每次都插一行，署名串里就会出现「甲、甲、甲」。
 */
export async function recordCredit(input: CreditInput, tx: DbLike = db): Promise<void> {
  // 既没有站内用户又没有外部署名，就没有可记录的主体 —— 静默跳过，
  // 不要往台账里塞空行（那会让显示串出现空档）。
  if (!input.userId && !input.displayName?.trim()) return;

  await tx
    .insert(fileCredits)
    .values({
      fileId: input.fileId,
      teamId: input.teamId,
      role: input.role,
      userId: input.userId ?? null,
      displayName: input.displayName?.trim() ?? '',
      source: input.source ?? 'auto',
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing();
}

/** 批量记账（一次操作影响到多张图，如批量移动）。 */
export async function recordCredits(inputs: readonly CreditInput[], tx: DbLike = db): Promise<void> {
  for (const input of inputs) await recordCredit(input, tx);
}

export type CreditLine = {
  id: string;
  role: CreditRole | string;
  userId: string | null;
  displayName: string;
  source: string;
  createdAt: string;
};

type CreditRow = typeof fileCredits.$inferSelect & { accountName: string | null };

/**
 * 取一批文件的署名，按文件分组。
 *
 * 名字优先用**账号当前的昵称**，账号不在了才退回台账里的快照 ——
 * 这样改昵称能全局生效（moeflow 的自由文本做不到），
 * 而人注销之后署名仍然留得住。
 */
export async function creditsForFiles(
  fileIds: readonly string[],
  tx: DbLike = db,
): Promise<Map<string, CreditLine[]>> {
  const result = new Map<string, CreditLine[]>();
  if (fileIds.length === 0) return result;

  const rows: CreditRow[] = await tx
    .select({
      id: fileCredits.id,
      fileId: fileCredits.fileId,
      teamId: fileCredits.teamId,
      role: fileCredits.role,
      userId: fileCredits.userId,
      displayName: fileCredits.displayName,
      source: fileCredits.source,
      createdBy: fileCredits.createdBy,
      createdAt: fileCredits.createdAt,
      seq: fileCredits.seq,
      accountName: users.displayName,
    })
    .from(fileCredits)
    .leftJoin(users, eq(users.id, fileCredits.userId))
    .where(inArray(fileCredits.fileId, [...fileIds]))
    // 顺序即显示顺序。按 `seq` 而不是 `created_at` —— 后者在同一事务里完全相同，
    // 排序会退化成随机。迁移时按原 token 顺序插入，这里就还原出原顺序。
    .orderBy(asc(fileCredits.seq));

  for (const row of rows) {
    const list = result.get(row.fileId) ?? [];
    list.push({
      id: row.id,
      role: row.role,
      userId: row.userId,
      displayName: row.accountName ?? row.displayName ?? '',
      source: row.source,
      createdAt: row.createdAt.toISOString(),
    });
    result.set(row.fileId, list);
  }

  return result;
}

export type CreditSummary = Record<string, { names: string[]; text: string }>;

/**
 * 派生显示串：`['甲','乙']` → `甲、乙`。
 *
 * 也顺手去重：同一个人以两种方式被记过（先手工加、后被系统自动记），
 * 显示串里只该出现一次。
 */
export function summarizeCredits(lines: readonly CreditLine[]): CreditSummary {
  const summary: CreditSummary = {};

  for (const role of CREDIT_ROLES) {
    const names: string[] = [];
    for (const line of lines) {
      if (line.role !== role) continue;
      const name = line.displayName.trim();
      if (name && !names.includes(name)) names.push(name);
    }
    summary[role] = { names, text: names.join('、') };
  }

  return summary;
}

/**
 * 整体替换某个文件某个角色的署名（界面上的「改署名」）。
 *
 * 语义是**替换**而不是追加：界面上那一栏就是「翻译：____」，
 * 改完保存的结果就是它显示的样子。追加语义会让用户删不掉人。
 * 传入的 `userId` 能对上账号的就关联账号，否则记成外部署名。
 */
export async function replaceCredits(
  fileId: string,
  teamId: string,
  role: CreditRole,
  entries: ReadonlyArray<{ userId?: string | null; displayName?: string }>,
  actorId: string,
  tx: DbLike = db,
): Promise<void> {
  await tx
    .delete(fileCredits)
    .where(and(eq(fileCredits.fileId, fileId), eq(fileCredits.role, role)));

  for (const entry of entries) {
    if (!entry.userId && !entry.displayName?.trim()) continue;
    await tx.insert(fileCredits).values({
      fileId,
      teamId,
      role,
      userId: entry.userId ?? null,
      displayName: entry.displayName?.trim() ?? '',
      source: 'manual',
      createdBy: actorId,
    });
  }
}

/** 某人在某文件上的署名角色（用于「这是不是我负责的图」判定与待办角标）。 */
export async function myCreditRoles(
  userId: string,
  fileIds: readonly string[],
  tx: DbLike = db,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (fileIds.length === 0) return result;

  const rows = await tx
    .select({ fileId: fileCredits.fileId, role: fileCredits.role })
    .from(fileCredits)
    .where(and(eq(fileCredits.userId, userId), inArray(fileCredits.fileId, [...fileIds])));

  for (const row of rows) {
    const list = result.get(row.fileId) ?? [];
    list.push(row.role);
    result.set(row.fileId, list);
  }
  return result;
}

/** 团队维度的署名统计（「本月谁翻得最多」这类看板用）。 */
export async function creditLeaderboard(teamId: string, limit = 20, tx: DbLike = db) {
  return tx
    .select({
      userId: fileCredits.userId,
      displayName: sql<string>`COALESCE(${users.displayName}, ${fileCredits.displayName})`,
      role: fileCredits.role,
      files: sql<number>`COUNT(DISTINCT ${fileCredits.fileId})`,
    })
    .from(fileCredits)
    .leftJoin(users, eq(users.id, fileCredits.userId))
    .where(eq(fileCredits.teamId, teamId))
    .groupBy(fileCredits.userId, fileCredits.role, sql`COALESCE(${users.displayName}, ${fileCredits.displayName})`)
    .orderBy(sql`COUNT(DISTINCT ${fileCredits.fileId}) DESC`)
    .limit(limit);
}
