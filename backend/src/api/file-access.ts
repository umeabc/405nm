import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { files, type User } from '../db/schema.js';
import { requireProjectAccess, requireProjectPermission, type ProjectAccess } from '../domain/authorize.js';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * 「按文件 id 取文件并校验访问权」——标号、译文、状态、署名四条路由都要用。
 *
 * 抽出来不只是为了少写几行：这是**权限判定的收口点**。三条路由各写一遍
 * `requireProjectAccess` 时，只要有一条漏掉或写错参数，就是一个越权读写的洞；
 * 收成一处之后，审查看一个函数就够了。
 */

export type LoadedFile = {
  file: typeof files.$inferSelect;
  access: ProjectAccess;
};

export async function loadAccessibleFile(
  fileId: string,
  user: User,
  permission?: string,
): Promise<LoadedFile> {
  const rows = await db
    .select()
    .from(files)
    // 软删除的图在业务上已经不存在了 —— 不能拿它当跳板访问作品。
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)))
    .limit(1);

  const file = rows[0];
  if (!file) throw notFound('图片不存在', 'FILE_NOT_FOUND');

  const access = await requireProjectAccess(file.projectId, user);
  if (permission) requireProjectPermission(access, permission);

  return { file, access };
}

/** 统一的 zod 解析：失败直接抛业务错误（中文文案取自 schema 的第一条 issue）。 */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
  return parsed.data;
}
