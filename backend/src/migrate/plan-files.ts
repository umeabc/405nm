/** 计划：图片文件 / 修订链 / 署名。 */
import type { CreditPlan, CreditRole, Plan } from './plan.js';
import type { Report } from './report.js';
import { splitCredits } from './rules.js';
import { ref, str, uuidv5, type Doc, type MoeflowExport } from './source.js';

const CREDIT_FIELDS: ReadonlyArray<readonly [CreditRole, string]> = [
  ['translator', 'tl'],
  ['proofreader', 'pr'],
  ['typesetter', 'tyu'],
];

export async function planFiles(exp: MoeflowExport, plan: Plan, report: Report): Promise<void> {
  plan.files = [];
  plan.fileIds = new Set();
  plan.fileProject = new Map();
  for (const f of await exp.all('file')) {
    const project = ref(f.p);
    if (!project || !plan.projectIds.has(project)) {
      report.lose('orphan-file', '所属作品不迁移的文件：不迁', f._id, false);
      continue;
    }
    const type = Number(f.t ?? 0);
    if (type === 1) {
      report.lose('folder', '文件夹：本站作品内没有目录层级，文件夹本身不迁（里面的图片平铺到作品下）', f._id);
      continue;
    }
    if (type !== 2) {
      report.lose('non-image-file', '非图片文件（纯文本/未知类型）：本站只处理图片，不迁（连同其标号与译文）', f._id);
      continue;
    }
    if (str(f.sb).trim()) {
      report.lose('file-other-bucket', '图片记在非默认存储桶（多桶 R2）：按同一图源地址取字节，取不到会在核验里记为缺图', f._id, false);
    }
    if (ref(f.f) || (Array.isArray(f.a) && f.a.length)) {
      report.lose('file-flattened', '文件夹里的图片：平铺到作品下（目录结构不保留，文件名不变）', f._id);
    }
    plan.files.push(f);
    plan.fileIds.add(f._id);
    plan.fileProject.set(f._id, project);
  }

  // ── 修订链：上一版必须同作品且也迁移，否则在这里断开 ──
  plan.fileOldRevision = new Map();
  for (const f of plan.files) {
    const ov = ref(f.ov);
    const ok = ov !== null && ov !== f._id && plan.fileIds.has(ov) && plan.fileProject.get(ov) === plan.fileProject.get(f._id);
    if (f.ov != null && !ok) report.lose('file-revision-unlinked', '上一版不迁移或引用失效：修订链在这里断开（本版视作首版）', f._id);
    plan.fileOldRevision.set(f._id, ok ? ov : null);
  }
  plan.fileRoot = new Map();
  for (const f of plan.files) {
    let cur = f._id;
    const seen = new Set([cur]);
    for (;;) {
      const prev = plan.fileOldRevision.get(cur);
      if (!prev) break;
      if (seen.has(prev)) {
        report.lose('file-revision-cycle', '修订链成环：从环上最后一个未访问的版本起算链根', f._id);
        break;
      }
      seen.add(prev);
      cur = prev;
    }
    plan.fileRoot.set(f._id, cur);
  }

  plan.credits = new Map();
  for (const f of plan.files) plan.credits.set(f._id, creditPlanOf(f, plan.userByName, report));
}

/**
 * 署名串 → 台账行。**顺序即 token 顺序**（写入时逐行插入，seq 严格递增）。
 * token 与某个旧用户的名字完全一致就关联账号；同一角色里同一账号出现第二次时不再关联
 * （台账对 (文件, 角色, 用户) 唯一），但名字照记 —— 存储层面逐字可还原。
 */
export function creditPlanOf(f: Doc, userByName: ReadonlyMap<string, string>, report: Report): CreditPlan {
  const out: CreditPlan = [];
  for (const [role, key] of CREDIT_FIELDS) {
    const raw = str(f[key]);
    const tokens = splitCredits(raw);
    if (tokens.length && tokens.join('、') !== raw) {
      report.lose('credit-normalized', '署名串的分隔符与空白规整为「、」', `${f._id}:${role}`, false);
    }
    const names = new Set<string>();
    const users = new Set<string>();
    tokens.forEach((name, idx) => {
      if (names.has(name)) report.lose('credit-duplicate-name', '同一角色里同一个名字写了两遍：台账照记，界面上只显示一次', `${f._id}:${role}`);
      names.add(name);
      let userOid = userByName.get(name) ?? null;
      if (userOid && users.has(userOid)) userOid = null;
      if (userOid) users.add(userOid);
      out.push({ id: uuidv5(`moeflow:file_credit:${f._id}:${role}:${idx}`), role, userOid, name });
    });
  }
  return out;
}
