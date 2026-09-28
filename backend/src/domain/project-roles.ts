import { and, eq, inArray } from 'drizzle-orm';
import { db, type DbLike } from '../db/client.js';
import {
  permissions,
  projectRolePermissions,
  projectRoles,
  rolePermissions,
  roles,
  type ProjectRole,
} from '../db/schema.js';
import { permissionCodesOf } from './permissions.js';

/**
 * 作品内的默认角色。
 *
 * 等级沿用 moeflow：创建人 500 / 管理员 400 / 监理 300 / 校对·翻译·嵌字 200 / 见习翻译 100。
 * 保留等级不是留恋旧设计 —— 它承担一个真实职责：**谁能管谁**。
 * 「只能调整等级严格低于自己的成员」这条规则，靠的就是它。
 *
 * 与 moeflow 的差异只在权限集合的定义方式：那边是代码里写死的一串数字枚举，
 * 这里是点分权限码，并且**作品创建后即可逐个作品修改**（复制成作品自己的角色），
 * 所以下面这些只是「新建作品时的初始值」，不是不可变的真理。
 */

export type ProjectRoleTemplate = {
  systemCode: string;
  name: string;
  level: number;
  intro: string;
  permissions: readonly string[];
};

const ALL_PROJECT_PERMISSIONS = permissionCodesOf('project');

const projectAllExcept = (...excluded: string[]): string[] =>
  ALL_PROJECT_PERMISSIONS.filter((code) => !excluded.includes(code));

export const PROJECT_ROLE_TEMPLATES: readonly ProjectRoleTemplate[] = [
  {
    systemCode: 'creator',
    name: '创建人',
    level: 500,
    intro: '作品的建立者，拥有全部权限',
    permissions: [...ALL_PROJECT_PERMISSIONS],
  },
  {
    systemCode: 'admin',
    name: '管理员',
    level: 400,
    // 「结项」是不可逆的收尾动作，留给创建人自己按。
    intro: '管理作品成员与全部日常事务',
    permissions: projectAllExcept('project.finish', 'project.delete'),
  },
  {
    systemCode: 'supervisor',
    name: '监理',
    level: 300,
    intro: '统筹进度、审核质量，但不能结项、删除作品或删除目标语言',
    permissions: projectAllExcept('project.finish', 'project.delete', 'target.delete'),
  },
  {
    systemCode: 'proofreader',
    name: '校对',
    level: 200,
    // 「打回重做」需要 tra.check —— 校对本来就负责判断译文对错，
    // 发现问题却只能等别人来按回退，等于把校对的手绑起来。
    intro: '校对译文、打回有问题的标号',
    permissions: [
      'file.add',
      'file.rename',
      'tra.output',
      'label.add',
      'label.move',
      'tra.add',
      'tra.proofread',
      'tra.check',
    ],
  },
  {
    systemCode: 'translator',
    name: '翻译',
    level: 200,
    intro: '录入译文与标号',
    permissions: ['file.add', 'tra.output', 'label.add', 'label.move', 'tra.add'],
  },
  {
    systemCode: 'typesetter',
    name: '嵌字',
    level: 200,
    // 嵌字不碰译文内容，但要能导出「原图 + 标号 + 译文」的整包，并回传成品。
    intro: '导出嵌字包、回传成品图',
    permissions: ['file.add', 'file.rename', 'file.typeset', 'tra.output', 'label.add'],
  },
  {
    systemCode: 'beginner',
    name: '见习翻译',
    level: 100,
    // 刻意不给 file.add：见习期的误上传比少上传更难收拾。
    intro: '新加入的翻译，可录入译文但不能上传图片',
    permissions: ['tra.add', 'tra.output'],
  },
];

export const DEFAULT_PROJECT_ROLE_SYSTEM_CODE = 'translator';

export function projectTemplateByCode(code: string): ProjectRoleTemplate | undefined {
  return PROJECT_ROLE_TEMPLATES.find((t) => t.systemCode === code);
}

/**
 * 补齐某团队的「项目角色模板」。
 *
 * 幂等，且**不必写数据迁移**：M1 建的团队没有这些模板行，
 * 这里在「建作品时」顺手补齐即可 —— 老团队一建作品就自动补上，
 * 没建过作品的团队也不需要这些行。比写一段一次性回填脚本更不容易出错。
 */
export async function ensureProjectRoleTemplates(teamId: string, tx: DbLike = db): Promise<Map<string, string>> {
  const existing = await tx
    .select({ id: roles.id, systemCode: roles.systemCode })
    .from(roles)
    .where(and(eq(roles.scope, 'project'), eq(roles.teamId, teamId)));

  const byCode = new Map<string, string>();
  for (const row of existing) {
    if (row.systemCode) byCode.set(row.systemCode, row.id);
  }

  for (const tpl of PROJECT_ROLE_TEMPLATES) {
    if (byCode.has(tpl.systemCode)) continue;

    const inserted = await tx
      .insert(roles)
      .values({
        scope: 'project',
        teamId,
        name: tpl.name,
        level: tpl.level,
        intro: tpl.intro,
        isSystem: true,
        systemCode: tpl.systemCode,
        // 模板本身不参与「自动成为项目管理员」的判定
        autoProjectAdmin: false,
      })
      .onConflictDoNothing()
      .returning({ id: roles.id });

    let roleId = inserted[0]?.id;
    if (!roleId) {
      // 撞上 (scope, teamId, name) 唯一键：说明同名行已存在（可能是手工建的），
      // 查回来复用，避免整段失败。
      const found = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.scope, 'project'), eq(roles.teamId, teamId), eq(roles.name, tpl.name)))
        .limit(1);
      roleId = found[0]?.id;
      if (!roleId) throw new Error(`补齐项目角色模板失败：${tpl.systemCode}`);
    }

    if (tpl.permissions.length > 0) {
      await tx
        .insert(rolePermissions)
        .values(tpl.permissions.map((code) => ({ roleId: roleId!, permissionCode: code })))
        .onConflictDoNothing();
    }

    byCode.set(tpl.systemCode, roleId);
  }

  return byCode;
}

/**
 * 为一个新作品实例化角色（从团队模板复制）。返回 `systemCode → projectRoleId`。
 *
 * 复制而非引用：某个作品想临时加一个岗位、或调高「校对」的权限，
 * 都不该影响同一团队下的其他作品。
 */
export async function instantiateProjectRoles(
  projectId: string,
  teamId: string,
  tx: DbLike = db,
): Promise<Map<string, string>> {
  const templateIds = await ensureProjectRoleTemplates(teamId, tx);

  const tplPerms = await tx
    .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
    .from(rolePermissions)
    .where(
      inArray(rolePermissions.roleId, templateIds.size > 0 ? [...templateIds.values()] : [ZERO_UUID]),
    );

  const permsByTemplate = new Map<string, string[]>();
  for (const row of tplPerms) {
    const list = permsByTemplate.get(row.roleId) ?? [];
    list.push(row.code);
    permsByTemplate.set(row.roleId, list);
  }

  const created = new Map<string, string>();

  for (const tpl of PROJECT_ROLE_TEMPLATES) {
    const templateId = templateIds.get(tpl.systemCode);
    if (!templateId) continue;

    const inserted = await tx
      .insert(projectRoles)
      .values({
        projectId,
        teamId,
        name: tpl.name,
        level: tpl.level,
        intro: tpl.intro,
        isSystem: true,
        systemCode: tpl.systemCode,
        sourceTemplateId: templateId,
      })
      .returning({ id: projectRoles.id });

    const roleId = inserted[0]?.id;
    if (!roleId) throw new Error(`实例化作品角色失败：${tpl.systemCode}`);
    created.set(tpl.systemCode, roleId);

    // 模板被人在界面上改过，就以模板当前的实际权限为准（而不是代码里的默认值）。
    const codes = permsByTemplate.get(templateId) ?? [...tpl.permissions];
    if (codes.length > 0) {
      await tx
        .insert(projectRolePermissions)
        .values(codes.map((code) => ({ projectRoleId: roleId, permissionCode: code })))
        .onConflictDoNothing();
    }
  }

  return created;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export type ProjectRoleWithPermissions = ProjectRole & { permissions: string[] };

export async function listProjectRolesWithPermissions(
  projectId: string,
  tx: DbLike = db,
): Promise<ProjectRoleWithPermissions[]> {
  const roleRows = await tx
    .select()
    .from(projectRoles)
    .where(eq(projectRoles.projectId, projectId))
    .orderBy(projectRoles.level);

  if (roleRows.length === 0) return [];

  const permRows = await tx
    .select({
      roleId: projectRolePermissions.projectRoleId,
      code: projectRolePermissions.permissionCode,
    })
    .from(projectRolePermissions)
    .where(
      inArray(
        projectRolePermissions.projectRoleId,
        roleRows.map((r) => r.id),
      ),
    );

  const byRole = new Map<string, string[]>();
  for (const row of permRows) {
    const list = byRole.get(row.roleId) ?? [];
    list.push(row.code);
    byRole.set(row.roleId, list);
  }

  return roleRows.map((role) => ({ ...role, permissions: (byRole.get(role.id) ?? []).sort() }));
}

/** 团队的项目角色模板列表（供「作品角色默认值」页编辑）。 */
export async function listProjectRoleTemplates(teamId: string) {
  const templateIds = await ensureProjectRoleTemplates(teamId);

  const roleRows = await db
    .select()
    .from(roles)
    .where(and(eq(roles.scope, 'project'), eq(roles.teamId, teamId)))
    .orderBy(roles.level);

  const permRows = await db
    .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
    .from(rolePermissions)
    .where(
      inArray(rolePermissions.roleId, templateIds.size > 0 ? [...templateIds.values()] : [ZERO_UUID]),
    );

  const byRole = new Map<string, string[]>();
  for (const row of permRows) {
    const list = byRole.get(row.roleId) ?? [];
    list.push(row.code);
    byRole.set(row.roleId, list);
  }

  return roleRows.map((role) => ({
    id: role.id,
    name: role.name,
    level: role.level,
    intro: role.intro,
    isSystem: role.isSystem,
    systemCode: role.systemCode,
    permissions: (byRole.get(role.id) ?? []).sort(),
  }));
}

/**
 * 把代码里的**默认权限**同步到某个作品的系统角色上。
 *
 * 为什么需要这个入口：作品的系统角色是建作品时从模板**复制**的一份快照，
 * 所以后来在代码里给某个默认角色加了权限（比如 M3 给「校对」加了打回权），
 * 已有的作品不会自动获得 —— 这在新权限引入时是必然发生的，
 * 而「悄悄不发」会让人以为是 bug（明明代码里加了、界面上还是灰的）。
 *
 * 语义刻意保守：
 *  - **只加不减**。管理员手工加过的权限保留，不做「恢复出厂设置」；
 *  - 只碰系统角色，自定义角色一律不动；
 *  - 返回实际新增了哪些，界面上可以据此提示「补了 3 项」。
 */
export async function syncProjectRoleDefaults(
  projectId: string,
  tx: DbLike = db,
): Promise<Array<{ role: string; added: string[] }>> {
  const roleRows = await tx
    .select()
    .from(projectRoles)
    .where(eq(projectRoles.projectId, projectId));

  const bySystemCode = new Map(roleRows.filter((r) => r.systemCode).map((r) => [r.systemCode!, r]));

  const existingPerms = await tx
    .select({
      roleId: projectRolePermissions.projectRoleId,
      code: projectRolePermissions.permissionCode,
    })
    .from(projectRolePermissions)
    .where(
      inArray(
        projectRolePermissions.projectRoleId,
        roleRows.length > 0 ? roleRows.map((r) => r.id) : [ZERO_UUID],
      ),
    );

  const haveByRole = new Map<string, Set<string>>();
  for (const row of existingPerms) {
    const set = haveByRole.get(row.roleId) ?? new Set<string>();
    set.add(row.code);
    haveByRole.set(row.roleId, set);
  }

  const report: Array<{ role: string; added: string[] }> = [];

  for (const tpl of PROJECT_ROLE_TEMPLATES) {
    const role = bySystemCode.get(tpl.systemCode);
    if (!role) continue;

    const have = haveByRole.get(role.id) ?? new Set<string>();
    const missing = tpl.permissions.filter((code) => !have.has(code));
    if (missing.length === 0) continue;

    await tx
      .insert(projectRolePermissions)
      .values(missing.map((code) => ({ projectRoleId: role.id, permissionCode: code })))
      .onConflictDoNothing();

    report.push({ role: role.name, added: missing });
  }

  return report;
}

/** 供权限解析用：一批作品角色的权限码。 */
export async function permissionsOfProjectRoles(
  roleIds: readonly string[],
  tx: DbLike = db,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (roleIds.length === 0) return result;

  const rows = await tx
    .select({
      roleId: projectRolePermissions.projectRoleId,
      code: projectRolePermissions.permissionCode,
    })
    .from(projectRolePermissions)
    .where(inArray(projectRolePermissions.projectRoleId, [...roleIds]));

  for (const row of rows) {
    const list = result.get(row.roleId) ?? [];
    list.push(row.code);
    result.set(row.roleId, list);
  }
  return result;
}

/** 权限码必须是项目域的 —— 防止把团队权限挂到作品角色上。 */
export async function assertProjectScopePermissions(codes: readonly string[]): Promise<void> {
  if (codes.length === 0) return;
  const rows = await db
    .select({ code: permissions.code, scope: permissions.scope })
    .from(permissions)
    .where(inArray(permissions.code, [...codes]));

  const known = new Map(rows.map((r) => [r.code, r.scope]));
  for (const code of codes) {
    const scope = known.get(code);
    if (!scope) throw new Error(`未知权限码：${code}`);
    if (scope !== 'project') throw new Error(`权限码 ${code} 不属于作品作用域`);
  }
}
