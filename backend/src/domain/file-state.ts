import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type DbLike } from '../db/client.js';
import { fileStates, files, projects, sources, targets, translations } from '../db/schema.js';
import type { ProjectAccess } from './authorize.js';
import { requireProjectPermission } from './authorize.js';
import { recordCredit } from './credits.js';
import { notifyStageEntered } from './notify.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import {
  FILE_STATES,
  STATE_LABELS,
  canTransition,
  checkPrerequisites,
  isFileState,
  rankOf,
  type FileState,
} from './workflow.js';

/**
 * 文件状态流转。
 *
 * 一条贯穿始终的规则：**事实自动前进，完成必须确认**。
 *  - 「开始翻译了」是事实 —— 有人往标号里写译文，文件就自动进 `translating`；
 *  - 「翻译完成了」是判断 —— 必须有人按下按钮，并附上「确实做完了」的校验。
 * 把两者分开，是因为自动推断永远猜不准「够了没有」，而让人每次都手动按
 * 「开始翻译」又纯属浪费。
 *
 * 另一条：**状态是给下面的人看的**。所以推进时除了写流水，还要把
 * 「该你了」送到下一环节的人手上（见 domain/notify.ts）。
 */

/** 进入各状态所需的**作品权限**。 */
const PERMISSION_BY_STATE: Readonly<Record<FileState, string>> = {
  sourced: 'tra.add',
  translating: 'tra.add',
  translated: 'tra.add',
  proofreading: 'tra.proofread',
  proofread: 'tra.proofread',
  typesetting: 'file.typeset',
  typeset: 'file.typeset',
  publishable: 'publish.approve',
  published: 'publish.approve',
};

/** 进入各状态时，自动记在操作者名下的署名角色。 */
const CREDIT_ROLE_BY_STATE: Partial<Record<FileState, 'translator' | 'proofreader' | 'typesetter'>> = {
  translated: 'translator',
  proofread: 'proofreader',
  typeset: 'typesetter',
};

export type TranslationCompleteness = {
  /** 需要翻译的标号数（原文为空的标号不计入 —— 那多半只是标个位置） */
  sourceCount: number;
  targets: Array<{
    targetId: string;
    language: string;
    label: string;
    /** 有选中译文的标号数 */
    translated: number;
    /** 选中译文已校对的标号数 */
    proofread: number;
  }>;
  /** 每个目标语言都翻完了 */
  allTranslated: boolean;
  /** 每个目标语言都校对完了 */
  allProofread: boolean;
};

/**
 * 统计一张图的翻译完整度。
 *
 * ⚠️ 一处刻意的简化：**状态是「文件级」的，不是「文件×语言级」的**。
 * 一个作品挂了两种目标语言时，只有两种语言都翻完，这张图才算「已翻译」。
 * 这么做与 moeflow 一致，也符合「彩翻的作品绝大多数只有一个目标语言」的现状；
 * 真要做成按语言分别推进，`file_states` 就得加 `target_id`，
 * 那是另一个量级的改动 —— 等真有团队需要时再谈。
 */
export async function translationCompleteness(
  fileId: string,
  tx: DbLike = db,
): Promise<TranslationCompleteness> {
  const sourceRows = await tx
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.fileId, fileId), sql`trim(${sources.content}) <> ''`));

  const sourceIds = sourceRows.map((r) => r.id);

  const fileRows = await tx
    .select({ projectId: files.projectId })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  const projectId = fileRows[0]?.projectId;

  const targetRows = projectId
    ? await tx.select().from(targets).where(eq(targets.projectId, projectId))
    : [];

  const result: TranslationCompleteness = {
    sourceCount: sourceIds.length,
    targets: [],
    allTranslated: true,
    allProofread: true,
  };

  // 作品没设目标语言 → 译文无处安放，谈不上「翻完了」。必须返回 false，
  // 否则一个空作品能一路点到「已校对」，状态就全是假的。
  if (targetRows.length === 0) {
    result.allTranslated = false;
    result.allProofread = false;
    return result;
  }

  // 这张图没有任何需要翻译的文字（纯大图页）→ 无事可做即已完成。
  if (sourceIds.length === 0) {
    for (const target of targetRows) {
      result.targets.push({
        targetId: target.id,
        language: target.language,
        label: target.label,
        translated: 0,
        proofread: 0,
      });
    }
    return result;
  }

  const rows = await tx
    .select({
      targetId: translations.targetId,
      selected: count(),
      proofread: sql<number>`COUNT(*) FILTER (WHERE trim(${translations.proofreadContent}) <> '')`,
    })
    .from(translations)
    .where(and(eq(translations.isSelected, true), inArray(translations.sourceId, sourceIds)))
    .groupBy(translations.targetId);

  const byTarget = new Map(rows.map((r) => [r.targetId, r]));

  for (const target of targetRows) {
    const row = byTarget.get(target.id);
    const translated = Number(row?.selected ?? 0);
    const proofread = Number(row?.proofread ?? 0);
    if (translated < sourceIds.length) result.allTranslated = false;
    if (proofread < sourceIds.length) result.allProofread = false;

    result.targets.push({
      targetId: target.id,
      language: target.language,
      label: target.label,
      translated,
      proofread,
    });
  }

  return result;
}

/**
 * 成品数量。
 *
 * M3 还没有 `outputs` 表（成品回传是 M5 的嵌字环节），所以这里恒为 0 ——
 * 于是「标记为已嵌字」会被前置条件挡住。这是**有意的**：
 * 与其让状态机假装走得通，不如在正确的时机说清楚「这一环还没开放」。
 * M5 建表后，这个函数改成一次 count 即可，其余代码不用动。
 */
async function outputCountFor(_fileId: string, _tx: DbLike = db): Promise<number> {
  return 0;
}

export type TransitionInput = {
  fileId: string;
  to: FileState;
  note?: string;
  access: ProjectAccess;
  actorId: string;
  /** 操作者的昵称 —— 通知文案里要写「谁把它推进到了哪一步」 */
  actorName: string;
};

export type TransitionResult = {
  from: FileState;
  to: FileState;
  backward: boolean;
  completeness: TranslationCompleteness;
  notified: number;
};

export async function transitionFile(
  input: TransitionInput,
  tx: DbLike = db,
): Promise<TransitionResult> {
  const { access, actorId, to } = input;

  if (!isFileState(to)) throw badRequest(`未知的状态：${to}`, 'INVALID_STATE');

  const fileRows = await tx
    .select()
    .from(files)
    .where(and(eq(files.id, input.fileId), eq(files.projectId, access.project.id), isNull(files.deletedAt)))
    .limit(1);

  const file = fileRows[0];
  if (!file) throw notFound('图片不存在或不属于该作品', 'FILE_NOT_FOUND');

  // 库里存的是 text，这里是唯一的收口点：`canTransition` 对未知状态直接拒绝，
  // 所以能走到下一行就说明 `file.state` 一定是合法状态。
  const verdict = canTransition(file.state, to);
  if (!verdict.ok) throw conflict(verdict.reason, 'ILLEGAL_TRANSITION');
  const from = file.state as FileState;

  // 回退是「打回重做」，本质上是对上一个环节成果的否定 —— 需要审核权，
  // 不能让译者自己把状态按回去把问题盖住。
  if (verdict.backward) {
    requireProjectPermission(access, 'tra.check');
  } else {
    requireProjectPermission(access, PERMISSION_BY_STATE[to]);
  }

  const [outputCount, completeness, projectStates] = await Promise.all([
    outputCountFor(input.fileId, tx),
    translationCompleteness(input.fileId, tx),
    tx
      .select({ state: files.state })
      .from(files)
      .where(and(eq(files.projectId, access.project.id), isNull(files.deletedAt)))
      .then((rows) => rows.map((r) => r.state)),
  ]);

  const facts = {
    outputCount,
    projectStates: projectStates.length > 0 ? projectStates : [from],
    allTranslated: completeness.allTranslated,
    allProofread: completeness.allProofread,
  };

  /*
   * 校验**沿途每一站**，而不只是终点。
   *
   * 只校验终点会留下一个真实的洞：`sourced → published` 是一次「前进」，
   * 于是所有前置条件都被跳过，一个持有发布权的人可以把没翻译过的图
   * 直接标成已发布。逐站校验之后，跳跃仍然允许（短篇一次做完很常见），
   * 但每一站该满足的条件都得满足。
   */
  const fromRank = rankOf(from);
  const toRank = rankOf(to);
  if (toRank > fromRank) {
    for (const stage of FILE_STATES.slice(fromRank + 1, toRank + 1)) {
      const stageCheck = checkPrerequisites(stage, facts);
      if (!stageCheck.ok) {
        throw conflict(describeBlocker(stage, stageCheck.reason, completeness, to), 'PREREQUISITE_NOT_MET');
      }
    }
  }

  const now = new Date();

  await tx.insert(fileStates).values({
    fileId: input.fileId,
    fromState: from,
    toState: to,
    actorId,
    note: input.note ?? '',
  });

  await tx
    .update(files)
    .set({ state: to, updatedAt: now })
    .where(eq(files.id, input.fileId));

  // 作品的「最近更新」跟着动，工作台按更新时间排序才有意义。
  await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, access.project.id));

  // 署名：完成了哪一环，就把这一环记在操作者名下。
  const creditRole = CREDIT_ROLE_BY_STATE[to];
  if (creditRole && !verdict.backward) {
    await recordCredit(
      {
        fileId: input.fileId,
        teamId: access.project.teamId,
        role: creditRole,
        userId: actorId,
        createdBy: actorId,
      },
      tx,
    );
  }

  const notified = await notifyStageEntered(
    {
      fileId: input.fileId,
      projectId: access.project.id,
      teamId: access.project.teamId,
      projectName: access.project.name,
      to,
      actorId,
      actorName: input.actorName,
    },
    tx,
  );

  return { from, to, backward: verdict.backward, completeness, notified };
}

/**
 * 把「拦在哪一站」说清楚。
 *
 * 用户按的是「标记为已校对」，被拦下来时如果只说「还有标号没有译文」，
 * 他会以为是在说校对那一站。所以要指明**是哪一站的什么没满足**，
 * 并带上进度数字（`简体中文 3/12`）—— 数字比形容词有用得多。
 */
function describeBlocker(
  stage: FileState,
  reason: string,
  completeness: TranslationCompleteness,
  requested: FileState,
): string {
  const progress =
    stage === 'translated'
      ? completeness.targets.map((t) => `${t.label} ${t.translated}/${completeness.sourceCount}`).join('，')
      : stage === 'proofread'
        ? completeness.targets.map((t) => `${t.label} ${t.proofread}/${completeness.sourceCount}`).join('，')
        : '';

  const withProgress = progress ? `${reason}（${progress}）` : reason;

  // 被拦下的是「中途某一站」而不是用户按的那一站时，必须说清楚是哪一站，
  // 否则他会盯着自己按的按钮想不通。
  const prefix = stage === requested ? '' : `要推进到「${STATE_LABELS[requested]}」需要先过「${STATE_LABELS[stage]}」这一关：`;

  // 嵌字这一环依赖 M5 的成品回传，说清楚是版本没到位而不是他做错了。
  const hint = stage === 'typeset' ? '（成品回传是 M5 的嵌字环节，当前版本尚未开放）' : '';

  return `${prefix}${withProgress}${hint}`;
}

/** 文件的状态流水（含谁在什么时候推的），按时间倒序。 */
export async function stateHistory(fileId: string, limit = 50, tx: DbLike = db) {
  return tx
    .select({
      id: fileStates.id,
      from: fileStates.fromState,
      to: fileStates.toState,
      note: fileStates.note,
      actorId: fileStates.actorId,
      createdAt: fileStates.createdAt,
    })
    .from(fileStates)
    .where(eq(fileStates.fileId, fileId))
    // 按 bigserial 的 id 倒序：`created_at` 用 now()，同一事务里插的多行
    // 时间戳相同，用它排会得到不稳定的顺序。id 由序列分配，永远准。
    .orderBy(sql`${fileStates.id} DESC`)
    .limit(limit);
}
