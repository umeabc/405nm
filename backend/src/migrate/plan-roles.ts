/**
 * 计划：角色与成员（团队、作品两个域同构，共用一份逻辑）。
 *
 * moeflow 与本站在角色归属上的结构差异，是这一块最容易迁错的地方：
 *  - moeflow 的**系统角色是全局的**：`team_role` / `project_role` 集合里各只有一份
 *    （`g` 为空、`m_s=true`），所有团队/作品共用；只有自定义角色才挂在某个组上（`g`）。
 *  - 本站角色**按组隔离**：每个团队有自己的一套团队角色，每个作品有自己的一套作品角色。
 * 所以迁移时给**每个组复制一份系统角色**，成员关系按「组 + 旧角色」重新指向本组的副本；
 * 自定义角色一对一迁。
 *
 * 系统角色副本的等级与权限**照旧站原样**：自定义角色的等级是相对系统角色定的，
 * 换成本站默认值会打乱「谁能管谁」；权限只做「只增」补齐（见 rules.topUpSystemPermissions）。
 */
import { SYSTEM_TEAM_ROLES, type PermissionScope } from '../domain/permissions.js';
import { PROJECT_ROLE_TEMPLATES } from '../domain/project-roles.js';
import type { Member } from './plan.js';
import type { Report } from './report.js';
import {
  mapLegacyPermissions,
  mapProjectSystemCode,
  mapTeamSystemCode,
  topUpSystemPermissions,
} from './rules.js';
import { dateOr, legacyRef, oidTime, ref, str, uuidv5, type Doc } from './source.js';

type RoleDef = { systemCode: string; name: string; level: number; intro: string; permissions: readonly string[]; autoProjectAdmin?: boolean };

export type RoleSpec = {
  scope: PermissionScope;
  collection: 'team_role' | 'project_role';
  label: string;
  mapCode: (legacy: string | null) => string | null;
  /** 组的默认角色引用失效时退到哪个系统码 */
  defaultCode: string;
  defs: readonly RoleDef[];
};

export const TEAM_ROLE_SPEC: RoleSpec = {
  scope: 'team',
  collection: 'team_role',
  label: '团队',
  mapCode: mapTeamSystemCode,
  defaultCode: 'beginner',
  defs: SYSTEM_TEAM_ROLES,
};

export const PROJECT_ROLE_SPEC: RoleSpec = {
  scope: 'project',
  collection: 'project_role',
  label: '作品',
  mapCode: mapProjectSystemCode,
  defaultCode: 'translator',
  defs: PROJECT_ROLE_TEMPLATES,
};

/** 落到本站的一个角色（某个组上的一行）。 */
export type RoleInst = {
  id: string;
  legacyId: string;
  group: string;
  /** 旧角色文档；null = 旧站缺这个系统角色、按本站默认补建的 */
  doc: Doc | null;
  /** 本站系统码；null = 自定义角色 */
  code: string | null;
  name: string;
  level: number;
  intro: string;
  permissions: string[];
  autoProjectAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type RolePlan = {
  roles: RoleInst[];
  /** `${组}:${旧角色 oid}` → 新角色 id（系统角色副本与自定义角色都在这里） */
  byLegacy: Map<string, string>;
  /** `${组}:${本站系统码}` → 新角色 id */
  byCode: Map<string, string>;
  /** 组 → 默认角色 id */
  defaultRole: Map<string, string>;
};

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}（${n}）`;
  taken.add(name);
  return name;
}

/**
 * `groups` 必须按 _id 排好序（导出读取时已排序），角色名去重的结果才稳定。
 * `groupDocs` 用来读组上的默认角色引用 `dr`。
 */
export function planRoles(spec: RoleSpec, docs: readonly Doc[], groupDocs: readonly Doc[], report: Report): RolePlan {
  const { scope, collection, label } = spec;
  const groupIds = new Set(groupDocs.map((g) => g._id));
  const defOf = (code: string | null) => (code ? spec.defs.find((d) => d.systemCode === code) : undefined);

  const permsOf = (doc: Doc, code: string | null) => {
    const mapped = mapLegacyPermissions(scope, doc.m_p);
    if (mapped.unmapped.length) {
      report.lose(`${scope}-permission-unmapped`, `${label}角色上有本站不存在的旧权限码：不迁（本站没有对应能力，这一项权限会少）`, `${doc._id}:${mapped.unmapped.join('/')}`);
    }
    if (mapped.ignored.length) {
      report.lose(`${scope}-permission-implied`, `${label}角色上有本站「事情本身就不存在」的旧权限码：不迁（访问权由团队成员身份决定；成员备注本站没有）`, `${doc._id}:${mapped.ignored.join('/')}`, false);
    }
    const topped = topUpSystemPermissions(scope, code, mapped.codes);
    if (topped.length) {
      report.lose(`${scope}-permission-topped-up`, `系统角色补上了旧站没有的新权限（只增不减）`, `${doc._id}:${topped.join('/')}`, false);
    }
    return { permissions: [...new Set([...mapped.codes, ...topped])].sort(), autoProjectAdmin: mapped.autoProjectAdmin };
  };

  // ── 分出全局系统角色与各组的自定义角色 ──
  type Template = { doc: Doc; code: string | null; permissions: string[]; autoProjectAdmin: boolean };
  const globals: Template[] = [];
  const claimed = new Set<string>();
  const customByGroup = new Map<string, Template[]>();
  for (const doc of docs) {
    const g = ref(doc.g);
    if (g === null && doc.g != null) {
      report.lose(`${collection}-bad-group-ref`, `${label}角色的所属组引用无法识别：不迁`, doc._id);
      continue;
    }
    if (g === null) {
      if (doc.m_s !== true) {
        report.lose(`unreachable-${collection}`, `既不是系统角色、也不属于任何${label}的角色（旧站也用不到）：不迁`, doc._id);
        continue;
      }
      let code = spec.mapCode(str(doc.m_o) || null);
      if (!code) report.lose(`${collection}-unknown-system`, `系统码不认识的系统角色：给每个${label}按自定义角色复制一份`, doc._id);
      else if (claimed.has(code)) {
        report.lose(`${collection}-duplicate-system`, `两个同系统码的系统角色：后一个按自定义角色复制`, doc._id);
        code = null;
      } else claimed.add(code);
      globals.push({ doc, code, ...permsOf(doc, code) });
      continue;
    }
    if (!groupIds.has(g)) {
      report.lose(`orphan-${collection}`, `所属${label}不迁移的自定义角色：不迁`, doc._id, false);
      continue;
    }
    const list = customByGroup.get(g) ?? [];
    list.push({ doc, code: null, ...permsOf(doc, null) });
    customByGroup.set(g, list);
  }

  // ── 逐组落角色：系统角色副本 → 自定义角色 → 补建缺失的系统角色 ──
  const plan: RolePlan = { roles: [], byLegacy: new Map(), byCode: new Map(), defaultRole: new Map() };
  const add = (inst: RoleInst, legacyOid: string | null) => {
    plan.roles.push(inst);
    if (legacyOid) plan.byLegacy.set(`${inst.group}:${legacyOid}`, inst.id);
    if (inst.code) plan.byCode.set(`${inst.group}:${inst.code}`, inst.id);
  };

  for (const group of groupDocs) {
    const g = group._id;
    const taken = new Set<string>();
    const named = (base: string, sample: string) => {
      const name = uniqueName(base, taken);
      if (name !== base) report.lose(`${scope}-role-renamed`, `同一${label}里角色重名：后一个加序号`, sample, false);
      return name;
    };

    for (const t of globals) {
      const def = defOf(t.code);
      add(
        {
          id: uuidv5(`moeflow:${collection}:${t.doc._id}@${g}`),
          legacyId: `${legacyRef(collection, t.doc._id)}@${g}`,
          group: g,
          doc: t.doc,
          code: t.code,
          name: named(str(t.doc.m_n).trim() || def?.name || `角色_${t.doc._id.slice(-6)}`, `${t.doc._id}@${g}`),
          level: Math.trunc(Number(t.doc.m_l ?? def?.level ?? 0)) || 0,
          intro: str(t.doc.m_i),
          permissions: t.permissions,
          autoProjectAdmin: t.autoProjectAdmin,
          createdAt: dateOr(t.doc.m_c, t.doc._id),
          updatedAt: dateOr(t.doc.m_c, t.doc._id),
        },
        t.doc._id,
      );
    }

    for (const t of customByGroup.get(g) ?? []) {
      add(
        {
          id: uuidv5(`moeflow:${collection}:${t.doc._id}`),
          legacyId: legacyRef(collection, t.doc._id),
          group: g,
          doc: t.doc,
          code: null,
          name: named(str(t.doc.m_n).trim() || `角色_${t.doc._id.slice(-6)}`, t.doc._id),
          level: Math.trunc(Number(t.doc.m_l ?? 0)) || 0,
          intro: str(t.doc.m_i),
          permissions: t.permissions,
          autoProjectAdmin: t.autoProjectAdmin,
          createdAt: dateOr(t.doc.m_c, t.doc._id),
          updatedAt: dateOr(t.doc.m_c, t.doc._id),
        },
        t.doc._id,
      );
    }

    for (const def of spec.defs) {
      if (plan.byCode.has(`${g}:${def.systemCode}`)) continue;
      report.lose(`${scope}-role-filled`, `旧站缺这个系统角色：按本站默认补建（本站每个${label}都要有全套系统角色）`, `${g}:${def.systemCode}`, false);
      add(
        {
          id: uuidv5(`moeflow:${collection}:fill:${def.systemCode}@${g}`),
          legacyId: `${legacyRef(collection, `fill:${def.systemCode}`)}@${g}`,
          group: g,
          doc: null,
          code: def.systemCode,
          name: named(def.name, `${g}:${def.systemCode}`),
          level: def.level,
          intro: def.intro,
          permissions: [...def.permissions].sort(),
          autoProjectAdmin: def.autoProjectAdmin ?? false,
          createdAt: oidTime(g),
          updatedAt: oidTime(g),
        },
        null,
      );
    }

    // 默认角色：组上的 dr 能对上本组可用的角色就用它，否则退到约定的系统角色
    const dr = ref(group.dr);
    const hit = dr ? plan.byLegacy.get(`${g}:${dr}`) : undefined;
    if (!hit && group.dr != null) report.lose(`${scope}-default-role-fallback`, `${label}默认角色引用失效：改用「${defOf(spec.defaultCode)?.name ?? spec.defaultCode}」`, g);
    plan.defaultRole.set(g, hit ?? plan.byCode.get(`${g}:${spec.defaultCode}`)!);
  }

  return plan;
}

/**
 * 成员关系：去孤儿、去重；角色引用对不上本组可用角色时退到组的默认角色。
 * 与旧站语义一致 —— 旧站删自定义角色时，也是把用它的人改成默认角色。
 */
export function planMembers(
  relations: readonly Doc[],
  groupIds: ReadonlySet<string>,
  userIds: ReadonlySet<string>,
  roles: RolePlan,
  report: Report,
  scope: 'team' | 'project',
): Member[] {
  const label = scope === 'team' ? '团队' : '作品';
  const out: Member[] = [];
  const seen = new Set<string>();
  for (const rel of relations) {
    const group = ref(rel.g);
    const user = ref(rel.u);
    if (!group || !groupIds.has(group) || !user || !userIds.has(user)) {
      report.lose(`orphan-${scope}-member`, `${label}或用户不迁移的成员关系：不迁`, rel._id, false);
      continue;
    }
    const key = `${group}:${user}`;
    if (seen.has(key)) {
      report.lose(`${scope}-member-duplicate`, `同一人在同一${label}里有两条成员关系：只保留第一条`, rel._id);
      continue;
    }
    seen.add(key);
    const legacyRole = ref(rel.r);
    let roleId = legacyRole ? roles.byLegacy.get(`${group}:${legacyRole}`) : undefined;
    if (!roleId) {
      roleId = roles.defaultRole.get(group)!;
      report.lose(`${scope}-member-role-fallback`, `成员的角色引用失效：改用${label}默认角色`, rel._id);
    }
    if (Array.isArray(rel.m_t) && rel.m_t.length) report.lose(`${scope}-member-tags`, '成员标签：本站没有这个字段，不迁', rel._id);
    out.push({ doc: rel, group, user, roleId, createdAt: dateOr(rel.m_c, rel._id) });
  }
  return out;
}
