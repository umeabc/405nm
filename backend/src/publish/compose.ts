import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  creditDirectory,
  fileCredits,
  files,
  outputs,
  projects,
  publishJobs,
  targets,
  type PublishJob,
} from '../db/schema.js';
import {
  dedupeMentions,
  mentionsFromSlots,
  mergeLibraryMentions,
  renderTemplate,
  slotSegment,
  type Slots,
} from './render.js';

/**
 * 把一条发布任务组装成「真正发出去的那段文本」，以及生成草稿时要用的素材。
 *
 * 正文的计算会发生**两次**（保存草稿时一次、发布时再兜底一次），
 * 而**只有发布时那次是权威的**：它覆盖历史数据、重新入队、以及
 * 「账号库后来被人改过」的任务。旧实现只在保存时算一次，后果是重新入队的
 * 任务 @ 全部退化成不可点击的纯文本。
 */

export function asSlots(value: unknown): Slots {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Slots;
}

export function asMentions(value: unknown): Array<{ name: string; uid: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
    .map((v) => ({ name: String(v.name ?? ''), uid: String(v.uid ?? '') }))
    .filter((v) => v.name !== '' && v.uid !== '');
}

/**
 * 拼出最终正文 = 正文 + 署名片段，并算出该带哪些提及，落回 pins。
 *
 * 署名片段与正文之间空一行：署名是「尾注」，紧贴正文会让最后一句读起来
 * 像署名的一部分。
 */
export async function renderFinalText(job: PublishJob): Promise<string> {
  const slots = asSlots(job.slots);
  const segment = slotSegment(job.kind, slots);
  const base = String(job.text ?? '').trim();
  const text = segment ? `${base}\n\n${segment}` : base;

  const directory = await loadDirectory(job.teamId);
  // 先按正文里出现的 @ 补，再补槽位里带 uid 的（署名片段本身就是正文的一部分，
  // 两条路会重叠，所以最后统一去重）
  const merged = mergeLibraryMentions(text, directory, asMentions(job.mentions));
  const withSlots = dedupeMentions([...merged, ...mentionsFromSlots(slots)]);

  // 落回库：界面上的「提及」要与实际发出去的一致，否则排查时会对不上
  await db
    .update(publishJobs)
    .set({ mentions: withSlots, updatedAt: new Date() })
    .where(eq(publishJobs.id, job.id));

  return text;
}

/** 团队的账号库。**含离岗的** —— 历史任务里的 @ 仍然需要能点。 */
export async function loadDirectory(teamId: string) {
  return db
    .select({ handle: creditDirectory.handle, platformUid: creditDirectory.platformUid })
    .from(creditDirectory)
    .where(eq(creditDirectory.teamId, teamId));
}

/**
 * 从**署名台账**聚合出这个作品的当前工作人员，再对到账号库上。
 *
 * 与旧实现的关键差异：旧站把「谁翻译了这张图」存成文件上的自由文本串，
 * 发动态时要去**解析字符串**猜人。这里查的是结构化台账
 * `(file_id, role, user_id, display_name)`。
 *
 * ⚠️ 但「站内的人」到「平台账号」这一步必须**经过账号库**：同一个人在站内
 * 叫一个名字、在 B 站叫另一个，两者没有必然联系。匹配不上时只留名字、
 * **不给 uid** —— 那样 @ 不可点击，但署名是对的，也绝不会去 @ 一个无关的人。
 */
export async function suggestSlots(projectId: string, kind: string): Promise<Slots> {
  const projectRows = await db
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const teamId = projectRows[0]?.teamId;
  if (!teamId) return {};

  const creditRows = await db
    .select({ role: fileCredits.role, displayName: fileCredits.displayName })
    .from(fileCredits)
    .innerJoin(files, eq(files.id, fileCredits.fileId))
    .where(and(eq(files.projectId, projectId), isNull(files.deletedAt)))
    // seq 是 bigserial，用它排才是**真实插入顺序**：created_at 是事务开始时间，
    // 同一批插入会拿到同一个值，排出来是随机的。
    .orderBy(asc(fileCredits.seq));

  const directory = await db
    .select({ name: creditDirectory.name, handle: creditDirectory.handle, platformUid: creditDirectory.platformUid })
    .from(creditDirectory)
    .where(and(eq(creditDirectory.teamId, teamId), eq(creditDirectory.status, 'active')));

  // 一个人可能在不同页上都做过翻译；台账里**最后一条**才是当前负责人 ——
  // 中途换人是常事，署名要写现在这个。
  const lastByRole = new Map<string, string>();
  for (const row of creditRows) {
    const name = row.displayName.trim();
    if (name) lastByRole.set(row.role, name);
  }

  const toSlot = (name: string | undefined) => {
    if (!name) return undefined;
    const hit = directory.find((d) => d.name === name || d.handle === name);
    return hit
      ? { name: hit.name, handle: hit.handle, uid: hit.platformUid }
      : { name, handle: name, uid: '' };
  };

  const wanted = kind === '原创' ? [] : kind === '转载' ? ['orig'] : ['trans', 'typo', 'orig'];
  const slots: Slots = {};
  if (wanted.includes('trans')) slots.trans = toSlot(lastByRole.get('translator'));
  if (wanted.includes('typo')) slots.typo = toSlot(lastByRole.get('typesetter'));
  // 原作者是站外的人，台账里没有他 —— 留空由运营填
  return slots;
}

/**
 * 把模板渲染成正文。署名槽位同时以 `{{translator}}` / `{{typesetter}}` /
 * `{{origAuthor}}` 的形式暴露给模板，这样「汉化更新」那类模板不用让运营
 * 手填一遍人员。
 */
export function applyTemplate(
  content: string,
  variables: Record<string, unknown>,
  slots: Slots,
): string {
  const handle = (slot: Slots[string]) => (slot?.handle ? `@${slot.handle}` : (slot?.name ?? ''));
  return renderTemplate(content, {
    translator: handle(slots.trans),
    typesetter: handle(slots.typo),
    origAuthor: handle(slots.orig),
    ...variables,
  });
}

/**
 * 定出这次操作用哪个语言。
 *
 * 规则：**明确指定 > 作品只有一种目标语言时取它 > 空串**。
 *
 * ⚠️ 中间那条不能省。曾经漏了它，后果是：不传 targetId 时语言成了空串，
 * 而回传的成品是按项目的语言码（`zh-CN`）存的，于是**一条都查不到** ——
 * 报出来的是「这个作品还没有可发布的成品图」，明明刚传完。函数名与规则
 * 在这里收成一份，就是为了不让成品路由和发布草稿各写一遍然后分叉。
 */
export async function resolveLanguage(projectId: string, requested?: string | null): Promise<string> {
  const rows = await db
    .select({ language: targets.language })
    .from(targets)
    .where(eq(targets.projectId, projectId));

  const codes = rows.map((r) => r.language);

  if (requested) {
    if (codes.length > 0 && !codes.includes(requested)) {
      throw new Error(`「${requested}」不是本作品的目标语言`);
    }
    return requested;
  }

  return codes.length === 1 ? codes[0]! : '';
}

/**
 * 这个作品有哪些语言已经有成品 —— 生成草稿时只能挑这些，
 * 否则会生成一个「图片一张都取不到」的空草稿。
 */
export async function languagesWithOutputs(projectId: string): Promise<Array<{ language: string; label: string; count: number }>> {
  const fileRows = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), eq(files.activated, true)));

  if (fileRows.length === 0) return [];

  const outputRows = await db
    .select({ fileId: outputs.fileId, language: outputs.language })
    .from(outputs)
    .where(
      inArray(
        outputs.fileId,
        fileRows.map((f) => f.id),
      ),
    )
    .orderBy(desc(outputs.version));

  const counted = new Map<string, Set<string>>();
  for (const row of outputRows) {
    const set = counted.get(row.language) ?? new Set<string>();
    set.add(row.fileId);
    counted.set(row.language, set);
  }

  const targetRows = await db
    .select({ language: targets.language, label: targets.label })
    .from(targets)
    .where(eq(targets.projectId, projectId))
    .orderBy(asc(targets.orderIndex));

  return [...counted.entries()].map(([language, set]) => ({
    language,
    label: targetRows.find((t) => t.language === language)?.label ?? language,
    count: set.size,
  }));
}
