/**
 * 权限码目录（受控词表，落 `permissions` 表供外键引用）。
 *
 * 命名的来由：moeflow 的权限是 `List[int]` 枚举码（团队域 1010–1150、项目域 1010–1170），
 * 可读性差且无法审计。这里改成点分字符串，**并保留对应关系**，方便迁移时逐一映射而不是猜。
 *
 * 项目域的权限码在 M1 只入目录、不授予任何角色；等 M2 建了项目和项目角色再用起来。
 */

export const PERMISSION_SCOPES = ['team', 'project'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export type PermissionDef = {
  code: string;
  scope: PermissionScope;
  label: string;
  intro?: string;
  /** 对应 moeflow 的枚举码，仅作迁移线索 */
  legacyCode?: number;
};

export const PERMISSIONS: readonly PermissionDef[] = [
  // ── 团队域 ────────────────────────────────────────────────
  { code: 'team.access', scope: 'team', label: '访问团队', legacyCode: 1 },
  { code: 'team.edit', scope: 'team', label: '修改团队资料', legacyCode: 10 },
  { code: 'team.delete', scope: 'team', label: '解散团队', legacyCode: 5 },
  { code: 'team.role.create', scope: 'team', label: '创建角色', legacyCode: 15 },
  { code: 'team.role.edit', scope: 'team', label: '修改角色' },
  { code: 'team.role.delete', scope: 'team', label: '删除角色', legacyCode: 20 },
  { code: 'team.member.invite', scope: 'team', label: '邀请成员', legacyCode: 105 },
  { code: 'team.member.remove', scope: 'team', label: '移除成员', legacyCode: 110 },
  { code: 'team.member.change_role', scope: 'team', label: '调整成员角色', legacyCode: 115 },
  { code: 'team.invite.manage', scope: 'team', label: '管理团队邀请码' },
  { code: 'team.setting.edit', scope: 'team', label: '修改团队设置' },

  { code: 'project.create', scope: 'team', label: '创建作品', legacyCode: 1090 },
  { code: 'project_set.create', scope: 'team', label: '创建作品集', legacyCode: 1100 },
  { code: 'project_set.edit', scope: 'team', label: '修改作品集', legacyCode: 1110 },
  { code: 'project_set.delete', scope: 'team', label: '删除作品集', legacyCode: 1120 },

  { code: 'term_bank.access', scope: 'team', label: '查看术语库', legacyCode: 1030 },
  { code: 'term_bank.create', scope: 'team', label: '创建术语库', legacyCode: 1020 },
  { code: 'term_bank.edit', scope: 'team', label: '修改术语库', legacyCode: 1040 },
  { code: 'term_bank.delete', scope: 'team', label: '删除术语库', legacyCode: 1050 },
  { code: 'term.create', scope: 'team', label: '新增术语', legacyCode: 1060 },
  { code: 'term.edit', scope: 'team', label: '修改术语', legacyCode: 1070 },
  { code: 'term.delete', scope: 'team', label: '删除术语', legacyCode: 1080 },

  { code: 'quota.ocr', scope: 'team', label: '使用 OCR 配额', legacyCode: 1130 },
  { code: 'quota.mt', scope: 'team', label: '使用机翻配额', legacyCode: 1140 },
  { code: 'team.insight', scope: 'team', label: '查看团队统计', legacyCode: 1150 },

  // 发布相关（405nm 新增）：团队可持有多个发布号，但**仅管理员可安排日程**
  { code: 'publish.account.manage', scope: 'team', label: '管理发布账号' },
  { code: 'publish.schedule', scope: 'team', label: '安排发布日程' },

  // ── 项目域 ─────────────────────────────────────────────────
  { code: 'project.finish', scope: 'project', label: '结项', legacyCode: 1010 },
  // 405nm 新增：moeflow 里「改作品资料」没有独立权限码，靠「是不是管理员」判断。
  // 拆成独立码是为了让「谁能改作品名」这件事可授权、可审计，而不是绑死在等级上。
  { code: 'project.edit', scope: 'project', label: '修改作品资料' },
  { code: 'project.delete', scope: 'project', label: '删除作品' },
  { code: 'project.member.manage', scope: 'project', label: '管理作品成员与角色' },
  { code: 'file.add', scope: 'project', label: '上传图片', legacyCode: 1020 },
  { code: 'file.move', scope: 'project', label: '移动图片', legacyCode: 1030 },
  { code: 'file.rename', scope: 'project', label: '重命名图片', legacyCode: 1040 },
  { code: 'file.delete', scope: 'project', label: '删除图片', legacyCode: 1050 },
  { code: 'tra.output', scope: 'project', label: '导出译文与图片', legacyCode: 1060 },
  { code: 'label.add', scope: 'project', label: '新增标号', legacyCode: 1080 },
  { code: 'label.move', scope: 'project', label: '移动标号', legacyCode: 1090 },
  { code: 'label.delete', scope: 'project', label: '删除标号', legacyCode: 1100 },
  { code: 'tra.add', scope: 'project', label: '录入翻译', legacyCode: 1110 },
  { code: 'tra.delete', scope: 'project', label: '删除翻译', legacyCode: 1120 },
  { code: 'tra.proofread', scope: 'project', label: '校对', legacyCode: 1130 },
  { code: 'tra.check', scope: 'project', label: '审核（可越过校对）', legacyCode: 1140 },
  { code: 'target.add', scope: 'project', label: '新增目标语言', legacyCode: 1150 },
  { code: 'target.change', scope: 'project', label: '修改目标语言', legacyCode: 1160 },
  { code: 'target.delete', scope: 'project', label: '删除目标语言', legacyCode: 1170 },
  // 405nm 新增
  { code: 'file.typeset', scope: 'project', label: '回传嵌字成品' },
  { code: 'file.block', scope: 'project', label: '挂起/恢复图片' },
  { code: 'publish.create', scope: 'project', label: '生成发布草稿' },
  { code: 'publish.approve', scope: 'project', label: '审核发布' },
];

export type PermissionCode = string;

export const ALL_PERMISSION_CODES: readonly string[] = PERMISSIONS.map((p) => p.code);

const TEAM_CODES = PERMISSIONS.filter((p) => p.scope === 'team').map((p) => p.code);
const PROJECT_CODES = PERMISSIONS.filter((p) => p.scope === 'project').map((p) => p.code);

export const PERMISSION_BY_CODE = new Map(PERMISSIONS.map((p) => [p.code, p]));

/** 供种子与校验用：某个 scope 下的全部权限码。 */
export function permissionCodesOf(scope: PermissionScope): readonly string[] {
  return scope === 'team' ? TEAM_CODES : PROJECT_CODES;
}

// ── 系统内置团队角色 ────────────────────────────────────────
//
// 等级与名称对齐 moeflow：创建人 500 / 管理员 400 / 资深成员 300 / 成员 200 / 见习成员 100。
// 之所以保留这些等级，是因为守卫规则依赖它：只能调整等级严格低于自己的成员。

export type SystemRoleDef = {
  systemCode: string;
  name: string;
  level: number;
  autoProjectAdmin: boolean;
  permissions: readonly string[];
  intro: string;
};

const teamAll = (): string[] => [...TEAM_CODES];

export const SYSTEM_TEAM_ROLES: readonly SystemRoleDef[] = [
  {
    systemCode: 'creator',
    name: '创建人',
    level: 500,
    autoProjectAdmin: true,
    permissions: teamAll(),
    intro: '团队的所有者，拥有全部权限，不可被移除',
  },
  {
    systemCode: 'admin',
    name: '管理员',
    level: 400,
    autoProjectAdmin: true,
    // 管理员拿不到「解散团队」—— 那是创建人的保留动作
    permissions: teamAll().filter((c) => c !== 'team.delete'),
    intro: '管理团队成员、角色与全部日常事务',
  },
  {
    systemCode: 'senior',
    name: '资深成员',
    level: 300,
    autoProjectAdmin: false,
    permissions: [
      'team.access',
      'team.member.invite',
      'project.create',
      'project_set.create',
      'project_set.edit',
      'term_bank.access',
      'term_bank.create',
      'term_bank.edit',
      'term.create',
      'term.edit',
      'quota.ocr',
      'quota.mt',
      'team.insight',
      'publish.account.manage',
    ],
    intro: '可以开新作品、邀请成员、维护术语',
  },
  {
    systemCode: 'member',
    name: '成员',
    level: 200,
    autoProjectAdmin: false,
    permissions: [
      'team.access',
      'project.create',
      'term_bank.access',
      'term.create',
      'quota.ocr',
      'quota.mt',
    ],
    intro: '参与作品的翻译、校对与嵌字',
  },
  {
    systemCode: 'beginner',
    name: '见习成员',
    level: 100,
    autoProjectAdmin: false,
    permissions: ['team.access'],
    intro: '新加入的成员，仅可查看团队内容',
  },
];

export const DEFAULT_TEAM_ROLE_SYSTEM_CODE = 'beginner';

export function systemTeamRoleByCode(code: string): SystemRoleDef | undefined {
  return SYSTEM_TEAM_ROLES.find((r) => r.systemCode === code);
}
