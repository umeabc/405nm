/**
 * 计划：标号、译文、由译校进度推定的文件状态。
 *
 * 这是全案唯一**必须流式处理**的一块：生产库上百万条标号与译文，
 * 谁都读不进 320MB 的内存。做法是两边都按主键升序流式读，**归并**着走：
 *   `source.json` 按 `_id` 升序、`translation.json` 按 `{o:1,t:1}` 升序，
 * 于是译文天然按「所属标号」成组，且组的顺序与标号顺序一致 —— 一次归并即可配对上，
 * 内存里只留一个组。导出脚本必须带这两个 `--sort`，否则这里会**明确报错**而不是悄悄错配。
 *
 * 计划阶段跑一遍归并，只留下聚合量（每个文件的标号数、每个目标语言的译校进度）；
 * 真正写库时再由同一套纯函数逐批生成行。**判定逻辑只有一份**（sourceRowOf / planGroup），
 * 计划用它来统计与记有损点，写库与核验用它来生成行，不会出现「迁移跳过的、核验却以为该有」。
 *
 * 有损点**只在计划阶段记**：写库与核验复用同一批生成器，但不传报告 —— 否则同一条会被记三遍。
 */
import type { FileState } from '../domain/workflow.js';
import type { Plan } from './plan.js';
import type { Report } from './report.js';
import { bboxOf, deriveFileState, mapPosition, type TargetProgress } from './rules.js';
import { dateOr, legacyRef, lid, num, oidTime, ref, str, type Doc, type MoeflowExport } from './source.js';

export type SourceRow = {
  id: string;
  fileId: string;
  positionType: 'in' | 'out';
  x: number;
  y: number;
  w: number;
  h: number;
  /** 旧站的多边形（外框位置百分比），没有就 null —— 保留是为了将来能还原成框 */
  vertices: unknown;
  groupId: null;
  orderIndex: number;
  content: string;
  note: string;
  style: Record<string, unknown>;
  createdBy: null;
  legacyId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TranslationRow = {
  id: string;
  sourceId: string;
  targetId: string;
  userId: string | null;
  content: string;
  proofreadContent: string;
  proofreaderId: string | null;
  proofreadAt: Date | null;
  isSelected: boolean;
  machineTranslated: boolean;
  legacyId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ContentPlan = {
  /** 文件 oid → 该文件的标号数（含没有原文的，作为进度的分母） */
  fileSourceCount: Map<string, number>;
  /** 文件 oid → 落库 target id → 译校进度 */
  fileProgress: Map<string, Map<string, TargetProgress>>;
  /** 文件 oid → 由进度推定的状态（旧站没有状态机，只能推） */
  fileState: Map<string, FileState>;
  /** 待写入行数（计划口径，报告用） */
  sourceCount: number;
  translationCount: number;
};

/** 标号所属的文件；文件不迁移就是 null。**判定只写这一处**。 */
export function sourceEligible(doc: Doc, plan: Plan): string | null {
  const file = ref(doc.f);
  return file && plan.fileIds.has(file) ? file : null;
}

/**
 * 标号行。几个刻意的地方：
 *  - `w/h` 由多边形包围盒合成（旧站只有中心点 + 多边形，**没有宽高**），
 *    认不出多边形就给 0 —— 在本站是「没有框」，不是「框在左上角」；
 *  - `vertices` 原样保留：本站的写入 API 不接受它，但迁移是数据搬运，不是编辑；
 *  - `orderIndex` 取旧站的 `rank`。旧站的 rank 允许重复、也允许为负
 *    （移动图片时会整段重排），本站只要求是整数，排序再靠 createdAt 兜底；
 *  - `line_feed` 与 `possible_terms` 不迁：本站用「空译文行」表达分段，没有术语库。
 */
export function sourceRowOf(doc: Doc, fileOid: string): { row: SourceRow; issues: SourceIssues } {
  const rawX = num(doc.x, 0);
  const rawY = num(doc.y, 0);
  const finite = Number.isFinite(doc.x === undefined ? 0 : Number(doc.x)) && Number.isFinite(doc.y === undefined ? 0 : Number(doc.y));
  const vertices = Array.isArray(doc.v) && doc.v.length ? doc.v : null;
  const bbox = bboxOf(vertices);
  const created = dateOr(doc.ct, doc._id);
  const row: SourceRow = {
    id: lid('source', doc._id),
    fileId: lid('file', fileOid),
    positionType: mapPosition(doc.p),
    x: finite ? rawX : 0,
    y: finite ? rawY : 0,
    w: bbox?.w ?? 0,
    h: bbox?.h ?? 0,
    vertices,
    groupId: null,
    orderIndex: Math.trunc(num(doc.r, 0)),
    content: str(doc.c),
    note: '',
    style: {},
    createdBy: null,
    legacyId: legacyRef('source', doc._id),
    createdAt: created,
    updatedAt: dateOr(doc.e, doc._id),
  };
  return {
    row,
    issues: {
      nonFiniteXY: !finite,
      outOfRangeXY: finite && (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1),
      unreadableVertices: vertices !== null && bbox === null,
      softLineFeed: doc.lf === false,
      possibleTerms: Array.isArray(doc.pt) && doc.pt.length > 0,
    },
  };
}

export type SourceIssues = {
  nonFiniteXY: boolean;
  outOfRangeXY: boolean;
  unreadableVertices: boolean;
  softLineFeed: boolean;
  possibleTerms: boolean;
};

// ── 归并读取 ────────────────────────────────────────────────

/** 译文按所属标号成组。**要求文件按 `o` 升序** —— 顺序不对宁可当场炸掉，也不要错配。 */
async function* rawGroups(exp: MoeflowExport): AsyncGenerator<{ source: string; docs: Doc[] }> {
  let cur: { source: string; docs: Doc[] } | null = null;
  for await (const doc of exp.stream('translation')) {
    const o = ref(doc.o);
    if (!o) continue; // 没有所属标号的译文无从归属（旧站的外键是必填，这条只是兜底）
    if (cur && cur.source === o) {
      cur.docs.push(doc);
      continue;
    }
    if (cur && o < cur.source) {
      throw new Error(`translation.json 的 o 不是升序（${cur.source} → ${o}）：导出请带 --sort '{o:1,t:1}'`);
    }
    if (cur) yield cur;
    cur = { source: o, docs: [doc] };
  }
  if (cur) yield cur;
}

/**
 * 标号 × 其译文组的归并流。`onOrphan` 收到的是「标号已不存在的译文组」——
 * 旧站的译文引用会被级联删除，正常不该有；有的话必须记下来，不能静默丢。
 */
export async function* mergedGroups(
  exp: MoeflowExport,
  onOrphan?: (source: string, count: number) => void,
): AsyncGenerator<{ doc: Doc; docs: Doc[] }> {
  const groups = rawGroups(exp);
  let next = await groups.next();
  let last = '';
  for await (const doc of exp.stream('source')) {
    if (last && doc._id < last) {
      throw new Error(`source.json 不是按 _id 升序（${last} → ${doc._id}）：导出请带 --sort '{_id:1}'`);
    }
    last = doc._id;
    let docs: Doc[] = [];
    while (!next.done && next.value.source <= doc._id) {
      if (next.value.source === doc._id) docs = next.value.docs;
      else onOrphan?.(next.value.source, next.value.docs.length);
      next = await groups.next();
    }
    yield { doc, docs };
  }
  while (!next.done) {
    onOrphan?.(next.value.source, next.value.docs.length);
    next = await groups.next();
  }
}

// ── 候选译文 → 落库行 ───────────────────────────────────────

export type GroupFlags = {
  /** 旧站有不止一份「选定」译文（正常只该有一份） */
  multiSelected: boolean;
  /** 旧站一份都没选定 —— 本站必须选一份，否则译文不参与导出与统计 */
  autoSelected: boolean;
  /** 被自动选中的那份带校对稿，但从来没人在旧站把它标成已校对 */
  uncheckedProofread: boolean;
  /** 旧站把「原文」当译文选定（译文与原文逐字相同），校对稿因此取原文 */
  checkedAsIs: boolean;
  /** 校对稿只有空白：旧站会原样导出空白，本站导出时按「没校对」处理 */
  blankProofread: boolean;
  /** 译文作者不在迁移范围内：译文照迁，但作者留空 */
  unlinkedUser: number;
  /** 合并后同一 (标号, 目标, 作者) 撞唯一键：后来者只留内容不留作者 */
  mergedUnlinked: number;
};

const timeOf = (v: unknown): number => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.getTime() : -1);

/**
 * 旧站挑「最佳译文」的顺序：选定 → 校对稿非空 → 编辑时间，最后我们补一个 _id 升序。
 * 校对稿按 **UTF-8 字节** 比（Mongo 的字符串序），用 `Buffer.compare` 而不是 `<`，
 * 免得在补充平面字符上跟旧站选出不同的那一份。
 */
export function compareCandidates(a: Doc, b: Doc): number {
  const sa = a.s === true ? 1 : 0;
  const sb = b.s === true ? 1 : 0;
  if (sa !== sb) return sb - sa;
  const byProofread = Buffer.compare(Buffer.from(str(b.p), 'utf8'), Buffer.from(str(a.p), 'utf8'));
  if (byProofread !== 0) return byProofread;
  const ea = timeOf(a.e);
  const eb = timeOf(b.e);
  if (ea !== eb) return eb - ea;
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

/**
 * 一个 (标号, 目标语言) 组 → 落库行。**最佳的那份被标成选中**，
 * 本站的导出、进度统计、发布都只认「选中」的那一份，旧站却允许一份都不选
 * （导出会另按一套顺序兜底）。与其让两套语义并存，不如迁移时就把选择落定。
 */
export function planGroup(
  sourceOid: string,
  aliasOid: string,
  docs: readonly Doc[],
  plan: Plan,
): { rows: TranslationRow[]; flags: GroupFlags } {
  const ordered = [...docs].sort(compareCandidates);
  const best = ordered[0]!;
  const flags: GroupFlags = {
    multiSelected: ordered.filter((d) => d.s === true).length > 1,
    autoSelected: best.s !== true,
    uncheckedProofread: false,
    checkedAsIs: false,
    blankProofread: false,
    unlinkedUser: 0,
    mergedUnlinked: 0,
  };

  const userOf = (value: unknown): string | null => {
    const oid = ref(value);
    return oid && plan.userIds.has(oid) ? lid('user', oid) : null;
  };

  const rows: TranslationRow[] = ordered.map((d) => {
    const isBest = d === best;
    const raw = str(d.p);
    const blank = raw !== '' && raw.trim() === '';
    if (blank) flags.blankProofread = true;
    // 旧站把「原文」当译文选定过：校对稿取原文 —— 否则本站导出会退回原文，
    // 看起来一样，但「已校对」的统计会平白少一条。
    const checkedAsIs = raw === '' && isBest && d.s === true;
    if (checkedAsIs) flags.checkedAsIs = true;
    const proofread = raw !== '' ? raw : checkedAsIs ? str(d.c) : '';
    const user = userOf(d.u);
    if (!user) flags.unlinkedUser += 1;
    const created = dateOr(d.ct, d._id);
    const proofreader = userOf(d.pr) ?? (checkedAsIs ? userOf(d.sr) : null);
    if (isBest && raw.trim() !== '' && !proofreader) flags.uncheckedProofread = true;
    return {
      id: lid('translation', d._id),
      sourceId: lid('source', sourceOid),
      targetId: lid('target', aliasOid),
      userId: user,
      content: str(d.c),
      proofreadContent: proofread,
      proofreaderId: proofread.trim() !== '' ? proofreader : null,
      proofreadAt: proofread.trim() !== '' ? dateOr(d.e, d._id) : null,
      isSelected: isBest,
      machineTranslated: d.mt === true,
      legacyId: legacyRef('translation', d._id),
      createdAt: created,
      updatedAt: d.e ? dateOr(d.e, d._id) : created,
    };
  });

  // (标号, 目标, 作者) 唯一：最佳那份保留作者，其余同作者的行只留内容。
  // 旧站的唯一键是 (source, target, user)，这里的重复只可能来自「目标语言被合并」。
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.userId) continue;
    if (seen.has(row.userId)) {
      row.userId = null;
      flags.mergedUnlinked += 1;
    } else seen.add(row.userId);
  }

  return { rows, flags };
}

// ── 计划 ────────────────────────────────────────────────────

/** 跑一遍归并：数出每个文件的标号数、每个目标语言的译校进度，并把有损点记全。 */
export async function planContent(exp: MoeflowExport, plan: Plan, report: Report): Promise<ContentPlan> {
  const content: ContentPlan = {
    fileSourceCount: new Map(),
    fileProgress: new Map(),
    fileState: new Map(),
    sourceCount: 0,
    translationCount: 0,
  };
  for (const f of plan.files) {
    // 作品里的每个目标语言都要有个 0 起步的条目：进度是「全部目标都翻完」的合取，
    // 漏掉一个没动过的语言，会让一个根本没翻的文件被推成「已翻译」。
    const targets = new Map<string, TargetProgress>();
    for (const t of plan.projectTargets.get(plan.fileProject.get(f._id)!) ?? []) targets.set(t, { translated: 0, proofread: 0 });
    content.fileProgress.set(f._id, targets);
    content.fileSourceCount.set(f._id, 0);
  }

  for await (const g of mergedGroups(exp, (source, count) => {
    report.lose('translation-orphan', '所属标号已不存在的译文：不迁', `${source}:${count}`, false);
  })) {
    const fileOid = sourceEligible(g.doc, plan);
    if (!fileOid) {
      report.lose('source-on-skipped-file', '所属文件不迁移的标号：不迁（连同其译文）', g.doc._id, false);
      continue;
    }
    const { issues } = sourceRowOf(g.doc, fileOid);
    content.sourceCount += 1;
    content.fileSourceCount.set(fileOid, (content.fileSourceCount.get(fileOid) ?? 0) + 1);
    if (issues.nonFiniteXY) report.lose('source-xy-nonfinite', '标号坐标不是有限数字：落成 0,0', g.doc._id);
    if (issues.outOfRangeXY) report.lose('source-xy-out-of-range', '标号坐标超出 0~1：原样保留（本站坐标也允许落在画布外）', g.doc._id, false);
    if (issues.unreadableVertices) report.lose('source-vertices-unreadable', '外框多边形认不出格式：只保住中心点，框按 0 宽高落库', g.doc._id);
    if (issues.softLineFeed) report.lose('source-line-feed-false', '「人工分段」标记：本站用空译文行表达分段，这个标记不迁', g.doc._id, false);
    if (issues.possibleTerms) report.lose('source-possible-terms', '标号上的候选术语：新站暂无术语库，不迁', g.doc._id, false);
    if (!g.docs.length) continue;

    const project = plan.fileProject.get(fileOid)!;
    const byAlias = new Map<string, Doc[]>();
    for (const d of g.docs) {
      const target = ref(d.t);
      const alias = target ? plan.targetAlias.get(target) : undefined;
      if (!alias) {
        report.lose('translation-target-unmapped', '所属目标语言不迁移的译文：不迁', d._id, false);
        continue;
      }
      if (plan.targetProject.get(alias) !== project) {
        report.lose('translation-cross-project', '译文的目标语言与标号所在作品对不上：不迁（旧库引用串了）', d._id);
        continue;
      }
      const list = byAlias.get(alias) ?? [];
      list.push(d);
      byAlias.set(alias, list);
    }

    for (const [alias, docs] of byAlias) {
      const { rows, flags } = planGroup(g.doc._id, alias, docs, plan);
      content.translationCount += rows.length;
      if (flags.autoSelected) {
        report.lose('translation-auto-selected', '旧站这份译文没有任何「选定」：本站按旧站的挑法自动选定一份（不选的话它在导出与进度里等于不存在）', g.doc._id, false);
      }
      if (flags.multiSelected) report.lose('translation-multi-selected', '同一标号同一目标有多份「选定」译文：本站只留一份（旧站导出哪份并不确定）', g.doc._id);
      if (flags.uncheckedProofread) report.lose('translation-proofread-unchecked', '被自动选定的那份带校对稿、却没人标过已校对：本站仍按已校对计入进度', g.doc._id);
      if (flags.checkedAsIs) report.lose('translation-checked-as-is', '「译文即原文」的选定：旧站导出后 PS 嵌的就是原文，本站把原文记为校对稿以保住已校对口径', g.doc._id, false);
      if (flags.blankProofread) report.lose('translation-proofread-blank', '校对稿只有空白：原样保留，但本站导出与统计按「没校对」处理', g.doc._id, false);
      if (flags.unlinkedUser) report.lose('translation-user-unlinked', '译文作者不在迁移范围：译文照迁，作者留空', g.doc._id);
      if (flags.mergedUnlinked) report.lose('translation-user-unlinked-merge', '目标语言合并后同一作者在同一标号上有两份译文：作者只留在最佳的那份上', g.doc._id);

      const progress = content.fileProgress.get(fileOid)?.get(alias);
      const best = rows.find((r) => r.isSelected);
      if (progress && best) {
        if (best.content.trim() !== '') progress.translated += 1;
        if (best.proofreadContent.trim() !== '') progress.proofread += 1;
      }
    }
  }

  for (const f of plan.files) {
    const targets = content.fileProgress.get(f._id);
    content.fileState.set(f._id, deriveFileState(content.fileSourceCount.get(f._id) ?? 0, [...(targets?.values() ?? [])]));
  }
  return content;
}

/** 按批次产出标号行（写库与核验共用）。 */
export async function* sourceBatches(
  exp: MoeflowExport,
  plan: Plan,
  batchSize = 500,
): AsyncGenerator<SourceRow[]> {
  let batch: SourceRow[] = [];
  for await (const g of mergedGroups(exp)) {
    const fileOid = sourceEligible(g.doc, plan);
    if (!fileOid) continue;
    batch.push(sourceRowOf(g.doc, fileOid).row);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

/** 按批次产出译文行（每组内部顺序稳定，便于核验时按 id 对齐）。 */
export async function* translationBatches(
  exp: MoeflowExport,
  plan: Plan,
  batchSize = 500,
): AsyncGenerator<TranslationRow[]> {
  let batch: TranslationRow[] = [];
  for await (const g of mergedGroups(exp)) {
    const fileOid = sourceEligible(g.doc, plan);
    if (!fileOid) continue;
    const project = plan.fileProject.get(fileOid)!;
    const byAlias = new Map<string, Doc[]>();
    for (const d of g.docs) {
      const target = ref(d.t);
      const alias = target ? plan.targetAlias.get(target) : undefined;
      if (!alias || plan.targetProject.get(alias) !== project) continue;
      const list = byAlias.get(alias) ?? [];
      list.push(d);
      byAlias.set(alias, list);
    }
    for (const [alias, docs] of byAlias) {
      for (const row of planGroup(g.doc._id, alias, docs, plan).rows) {
        batch.push(row);
        if (batch.length >= batchSize) {
          yield batch;
          batch = [];
        }
      }
    }
  }
  if (batch.length) yield batch;
}
