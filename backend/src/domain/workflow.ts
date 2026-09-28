/**
 * 工作流状态机 —— 文件级是真相源，作品级是**派生**出来的。
 *
 * 参考实现（彩翻）用「七级进度」隐式表达这一切：几个布尔位与一个数字，
 * 谁是当前阶段要靠比较数字推。这里改成显式命名状态，好处有三：
 *  1. 状态名可以直接出现在日志、通知与审计里，不必翻译数字；
 *  2. 非法流转可以显式拒绝（见 `canTransition`），而不是「数字只能变大」；
 *  3. 作品级进度是聚合出来的，不存在「作品表和文件表各记一份、两边不一致」。
 *
 * 状态只能沿 `FILE_STATES` 的顺序前进；回退必须显式列出（回退是业务动作，
 * 不是「减数字」，要带原因与权限）。
 */

export const FILE_STATES = [
  'sourced', // 已入库
  'translating', // 翻译中
  'translated', // 已翻译
  'proofreading', // 校对中
  'proofread', // 已校对
  'typesetting', // 嵌字中
  'typeset', // 已嵌字（成品已回传）
  'publishable', // 可发布
  'published', // 已发布
] as const;

export type FileState = (typeof FILE_STATES)[number];

/** 状态序号。比较大小即可判断「谁更靠后」。 */
export const STATE_RANK: Readonly<Record<FileState, number>> = Object.freeze(
  Object.fromEntries(FILE_STATES.map((s, i) => [s, i])) as Record<FileState, number>,
);

export function isFileState(value: string): value is FileState {
  return (FILE_STATES as readonly string[]).includes(value);
}

export function rankOf(state: string): number {
  return isFileState(state) ? STATE_RANK[state] : 0;
}

// ── 对外五档 ────────────────────────────────────────────────
//
// 界面上只露五档（与 Comiku 设计稿的状态 chip 一致）。内部的九个状态
// 归并成这五档展示 —— **内部状态更细，是为了驱动权限与通知；
// 对外更粗，是为了让人一眼看懂作品卡在哪一步。**

export const PROJECT_STAGES = [
  'translating',
  'proofreading',
  'typesetting',
  'publishable',
  'published',
] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const STAGE_LABELS: Readonly<Record<ProjectStage, string>> = {
  translating: '翻译中',
  proofreading: '校对中',
  typesetting: '嵌字中',
  publishable: '待发布',
  published: '已发布',
};

/** 内部状态的中文名。错误提示里要指名「卡在哪一站」，用得到。 */
export const STATE_LABELS: Readonly<Record<FileState, string>> = {
  sourced: '已入库',
  translating: '翻译中',
  translated: '已翻译',
  proofreading: '校对中',
  proofread: '已校对',
  typesetting: '嵌字中',
  typeset: '已嵌字',
  publishable: '可发布',
  published: '已发布',
};

/**
 * 单个文件落在哪一档。注意边界取**已完成**的那一侧：
 * `translated` 表示翻译已经做完，所以它属于「校对中」而不是「翻译中」——
 * 一部作品的翻译全做完了，就不该再显示成「翻译中」。
 */
export function stageOfFile(state: string): ProjectStage {
  const rank = rankOf(state);
  if (rank >= STATE_RANK.published) return 'published';
  if (rank >= STATE_RANK.typeset) return 'publishable';
  if (rank >= STATE_RANK.proofread) return 'typesetting';
  if (rank >= STATE_RANK.translated) return 'proofreading';
  return 'translating';
}

/**
 * 作品档位 = 全部文件里**最落后**的那一档。
 *
 * 取最落后而不是平均：一部 36 页的作品有 1 页还没翻译，它就是「翻译中」。
 * 报「校对中」会让人以为翻译已经齐了 —— 这是团队协作里最招骂的一种谎。
 * 没有文件时返回翻译中（界面据 fileCount=0 显示空态）。
 */
export function aggregateStage(states: readonly string[]): ProjectStage {
  let worst: ProjectStage = 'published';
  if (states.length === 0) return 'translating';

  for (const state of states) {
    const stage = stageOfFile(state);
    if (PROJECT_STAGES.indexOf(stage) < PROJECT_STAGES.indexOf(worst)) {
      worst = stage;
    }
  }
  return worst;
}

// ── 流转规则 ────────────────────────────────────────────────

/**
 * 进入某状态的**前置条件**（除「顺序必须往前走」之外）。
 *
 * 这里只描述条件本身，判定所需的数据由调用方查好传进来 ——
 * 状态机不该自己去查库，否则它就没法在事务里被复用了。
 *
 * ⚠️ **每一个状态都要有条目**，包括那些「看起来不会有人直接跳过去」的。
 * 早先只给 `typeset` 与 `publishable` 写了规则，结果
 * `sourced → published` 一次跳跃能绕开全部校验：一个持有发布权的人
 * 可以把一张没翻译过的图直接标成「已发布」。现在改成
 * **沿途每一站都校验**（见 file-state.ts），所以这里的覆盖必须完整。
 */
export type TransitionFacts = {
  /** 该文件已有的成品数量 */
  outputCount: number;
  /** 同一作品下文件的当前状态 */
  projectStates: readonly string[];
  /** 该文件在所有目标语言下都已有选中译文 */
  allTranslated: boolean;
  /** 该文件在所有目标语言下都已校对 */
  allProofread: boolean;
};

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function checkPrerequisites(to: FileState, facts: TransitionFacts): TransitionCheck {
  switch (to) {
    case 'translated':
      return facts.allTranslated
        ? { ok: true }
        : { ok: false, reason: '还有标号没有译文，不能标记为已翻译' };

    case 'proofread':
      return facts.allProofread
        ? { ok: true }
        : { ok: false, reason: '还有译文未经校对，不能标记为已校对' };

    case 'typeset':
      return facts.outputCount >= 1
        ? { ok: true }
        : { ok: false, reason: '该图片还没有回传成品，无法标记为已嵌字' };

    case 'publishable': {
      const unfinished = facts.projectStates.filter((s) => rankOf(s) < STATE_RANK.typeset).length;
      return unfinished === 0
        ? { ok: true }
        : { ok: false, reason: `作品内还有 ${unfinished} 张图未完成嵌字，无法标记为可发布` };
    }

    case 'published': {
      const unfinished = facts.projectStates.filter((s) => rankOf(s) < STATE_RANK.publishable).length;
      return unfinished === 0
        ? { ok: true }
        : { ok: false, reason: `作品内还有 ${unfinished} 张图未到可发布，无法标记为已发布` };
    }

    // 其余状态（入库、翻译中、校对中、嵌字中…）是「进行中」的标记，
    // 没有额外前提 —— 它们只表示「有人开始干了」。
    default:
      return { ok: true };
  }
}

/**
 * 允许的回退。
 *
 * 表按**目标状态**索引，列出「可以从哪些状态退到这里」。
 * 语义是「退回上一环节的**完成点**」：
 *   校对打回 → 回到 `translated`（译者改完再交一次）
 *   嵌字打回 → 回到 `proofread`
 *   发布打回 → 回到 `typeset`
 *
 * `published` 刻意**不可回退**：发布动作的后果在站外（B 站动态已经发出去了），
 * 把内部状态改回 `publishable` 只会让数据与实际不符，撤销要去站上撤。
 */
export const BACKWARD_TRANSITIONS: Readonly<Record<FileState, readonly FileState[]>> = {
  sourced: ['translating'],
  translating: ['sourced', 'translated'],
  translated: ['proofreading', 'proofread'],
  proofreading: ['proofread'],
  proofread: ['typesetting', 'typeset'],
  typesetting: ['typeset'],
  typeset: ['publishable', 'published'],
  publishable: ['published'],
  published: [],
};

export type TransitionVerdict =
  | { ok: true; backward: boolean }
  | { ok: false; reason: string };

export function canTransition(from: string, to: FileState): TransitionVerdict {
  if (!isFileState(from)) return { ok: false, reason: `未知的当前状态：${from}` };
  if (from === to) return { ok: false, reason: '状态没有变化' };

  if (STATE_RANK[to] > STATE_RANK[from]) return { ok: true, backward: false };
  if (BACKWARD_TRANSITIONS[to].includes(from)) return { ok: true, backward: true };

  return {
    ok: false,
    reason: `不允许从「${from}」回退到「${to}」`,
  };
}
