/**
 * 迁移的**纯映射规则**（不碰数据库）。migrate 与 verify 共用同一份 ——
 * 否则两边各写一遍，「迁移怎么映射」和「验证按什么对账」会慢慢分叉。
 */
import { PERMISSIONS, SYSTEM_TEAM_ROLES, type PermissionScope } from '../domain/permissions.js';
import { PROJECT_ROLE_TEMPLATES } from '../domain/project-roles.js';
import type { FileState } from '../domain/workflow.js';
import { validateUsername } from '../lib/validate.js';

// ── 权限 ────────────────────────────────────────────────────

/** 旧码在两个域里**重号**（团队 1020 = 建术语库，项目 1020 = 上传文件），必须按 (域, 码) 查。 */
const BY_LEGACY = new Map<string, string>();
for (const p of PERMISSIONS) {
  if (p.legacyCode !== undefined) BY_LEGACY.set(`${p.scope}:${p.legacyCode}`, p.code);
}

/** 团队域 1010「自动成为项目管理员」在新站不是权限码，而是角色上的开关。 */
const TEAM_AUTO_PROJECT_ADMIN = 1010;

/**
 * 旧站的**共用基类** `PermissionMixin` 里的一批权限码：两个域用的是同一串数字
 * （1 访问 / 5 删除 / 10 修改 / 15 建角色 / 20 删角色 / 101 审核加入 / 105 邀请 /
 * 110 移除 / 115 调角色 / 120 改备注），含义按域各自解释。
 *
 * 团队域那边一条 legacyCode 对一条，已经写在 `PERMISSIONS` 里；作品域这边是
 * **多条旧码落到同一条本站码**（成员管理），一条 `legacyCode` 表达不了，所以补在这里。
 */
const PROJECT_BASE: Record<number, string> = {
  15: 'project.member.manage',
  20: 'project.member.manage',
  101: 'project.member.manage',
  110: 'project.member.manage',
  115: 'project.member.manage',
};

/**
 * 旧站有、但**本站连对应能力都没有**的权限码：丢了不影响任何人（不是「少给了权限」，
 * 而是那件事在本站不存在）。所以它们走**另一类**记录、不要求人工确认 ——
 * 否则真正的「权限丢掉」会淹没在噪声里。
 */
const IGNORED_BASE: Record<PermissionScope, readonly number[]> = {
  team: [101, 120], // 审核加入申请、修改成员备注
  project: [1, 120], // 「访问作品」在本站由团队成员身份决定；成员备注本站没有
};

export type MappedPermissions = {
  codes: string[];
  /** 旧站有、本站没有对应能力的权限码 */
  unmapped: number[];
  /** 旧站有、本站连这件事都不存在的权限码（不算损失） */
  ignored: number[];
  autoProjectAdmin: boolean;
};

export function mapLegacyPermissions(scope: PermissionScope, legacy: unknown): MappedPermissions {
  const codes = new Set<string>();
  const unmapped: number[] = [];
  const ignored: number[] = [];
  let autoProjectAdmin = false;
  for (const raw of Array.isArray(legacy) ? legacy : []) {
    const n = Number(raw);
    if (scope === 'team' && n === TEAM_AUTO_PROJECT_ADMIN) {
      autoProjectAdmin = true;
      continue;
    }
    const code = BY_LEGACY.get(`${scope}:${n}`) ?? (scope === 'project' ? PROJECT_BASE[n] : undefined);
    if (code) codes.add(code);
    else if (IGNORED_BASE[scope].includes(n)) ignored.push(n);
    else unmapped.push(n);
  }
  return { codes: [...codes].sort(), unmapped, ignored, autoProjectAdmin };
}

/**
 * 系统角色的「只增」补齐：只补**旧站没有对应码**的新权限（如 file.typeset、publish.*）。
 * 有旧码对应、但旧角色上没勾的，是**有人刻意去掉的** —— 不补，尊重原配置。
 */
export function topUpSystemPermissions(scope: PermissionScope, systemCode: string | null, have: readonly string[]): string[] {
  if (!systemCode) return [];
  const defaults =
    scope === 'team'
      ? SYSTEM_TEAM_ROLES.find((r) => r.systemCode === systemCode)?.permissions
      : PROJECT_ROLE_TEMPLATES.find((t) => t.systemCode === systemCode)?.permissions;
  if (!defaults) return [];
  const haveSet = new Set(have);
  return defaults.filter((code) => !haveSet.has(code) && PERMISSIONS.find((p) => p.code === code)?.legacyCode === undefined);
}

/** 旧站项目系统角色 → 新站模板码（旧站叫法不同的三个要换名，其余同名）。 */
const PROJECT_SYSTEM_CODE: Record<string, string> = {
  creator: 'creator',
  admin: 'admin',
  coordinator: 'supervisor',
  proofreader: 'proofreader',
  translator: 'translator',
  picture_editor: 'typesetter',
  supporter: 'beginner',
};

export function mapProjectSystemCode(legacy: string | null): string | null {
  return legacy ? (PROJECT_SYSTEM_CODE[legacy] ?? null) : null;
}

export function mapTeamSystemCode(legacy: string | null): string | null {
  return legacy && SYSTEM_TEAM_ROLES.some((r) => r.systemCode === legacy) ? legacy : null;
}

// ── 作品状态 ────────────────────────────────────────────────

/** 旧站 0 进行中 / 1 已完结 / 2 计划完结 / 3 计划删除 / 4 已删除 → 新站只有 active / archived。 */
export function mapProjectStatus(st: unknown): 'active' | 'archived' {
  const n = Number(st ?? 0);
  return n === 0 || n === 2 ? 'active' : 'archived';
}

// ── 署名 ────────────────────────────────────────────────────

/** 旧站三个自由文本串的拆法：`、` `，` `,` 都是分隔符。顺序即署名顺序，不能动。 */
export function splitCredits(raw: string): string[] {
  return raw
    .split(/[、，,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 规范形式 = 台账回拼出来的样子（summarizeCredits 用 `、` 连接）。 */
export const canonicalCredits = (raw: string): string => splitCredits(raw).join('、');

// ── 标号 ────────────────────────────────────────────────────

export const mapPosition = (p: unknown): 'in' | 'out' => (Number(p) === 2 ? 'out' : 'in');

/**
 * 旧站标号只有中心点 + 可选多边形（「外框位置百分比」），**没有宽高**。
 * 有多边形 → 取包围盒；没有 → 0。认不出的格式返回 null（由调用方记有损）。
 */
export function bboxOf(vertices: unknown): { w: number; h: number } | null {
  if (!Array.isArray(vertices) || vertices.length === 0) return { w: 0, h: 0 };
  const pts: Array<[number, number]> = [];
  for (const v of vertices) {
    if (Array.isArray(v) && v.length >= 2) pts.push([Number(v[0]), Number(v[1])]);
    else if (v && typeof v === 'object' && 'x' in v && 'y' in v) pts.push([Number((v as { x: unknown }).x), Number((v as { y: unknown }).y)]);
    else return null;
  }
  if (pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  const max = Math.max(...pts.flat());
  const scale = max <= 1 ? 1 : max <= 100 ? 100 : 0;
  if (scale === 0) return null;
  const xs = pts.map((p) => p[0] / scale);
  const ys = pts.map((p) => p[1] / scale);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// ── 文件状态 ────────────────────────────────────────────────

export type TargetProgress = { translated: number; proofread: number };

/**
 * 旧站没有状态机，按**实际进度**推一个状态。口径比 checkPrerequisites 更严
 * （分母是全部标号，而不只是有原文的），所以推出来的状态一定满足新站的前提。
 */
export function deriveFileState(sourceCount: number, targets: readonly TargetProgress[]): FileState {
  if (sourceCount === 0 || targets.length === 0) return 'sourced';
  const allTranslated = targets.every((t) => t.translated >= sourceCount);
  const allProofread = targets.every((t) => t.proofread >= sourceCount);
  if (allTranslated && allProofread) return 'proofread';
  if (allTranslated) return targets.some((t) => t.proofread > 0) ? 'proofreading' : 'translated';
  return targets.some((t) => t.translated > 0) ? 'translating' : 'sourced';
}

// ── 用户名 ──────────────────────────────────────────────────

/** 旧名合规且没被占 → 原样；否则规整/加后缀，保证合规且唯一。显示名始终保留原名。 */
export function pickUsername(legacyName: string, oid: string, taken: ReadonlySet<string>): string {
  const name = legacyName.trim();
  const tail = oid.slice(-6);
  const cleaned = name.replace(/[^\w.\-一-龥]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 24);
  const candidates = [name, cleaned, `${cleaned}_${tail}`, `mf_${tail}`, `mf_${oid}`];
  for (const c of candidates) if (c && !validateUsername(c) && !taken.has(c)) return c;
  throw new Error(`无法为用户 ${oid} 生成可用的用户名`);
}

export const displayNameOf = (legacyName: unknown, oid: string): string => {
  const name = typeof legacyName === 'string' ? legacyName.trim() : '';
  return name || `mf_${oid.slice(-6)}`;
};
