/**
 * 迁移**计划**：只看导出快照、不碰数据库，算出「哪些文档要迁、迁成什么、引用怎么接」。
 *
 * migrate 与 verify 用的是**同一份计划** —— 两边各算一遍资格，迟早会出现
 * 「迁移跳过了、验证却以为该有」或反过来的分叉，对账就失去了意义。
 * 计划阶段记下的有损点只取决于快照本身，所以重跑时结论完全一致。
 */
import type { ImageSource } from './images.js';
import type { ContentPlan } from './plan-content.js';
import { planFiles } from './plan-files.js';
import { planOrg } from './plan-org.js';
import { planProjects } from './plan-projects.js';
import type { RolePlan } from './plan-roles.js';
import type { Report } from './report.js';
import type { Doc, MoeflowExport } from './source.js';

export type Member = { doc: Doc; group: string; user: string; roleId: string; createdAt: Date };

export type CreditRole = 'translator' | 'proofreader' | 'typesetter';
export type CreditPlan = Array<{ id: string; role: CreditRole; userOid: string | null; name: string }>;

export type Plan = {
  users: Doc[];
  userIds: Set<string>;
  /** 旧站用户名（trim 后）→ oid。署名串按名字对账号用 */
  userByName: Map<string, string>;
  /** 用户 oid → 小写邮箱（旧站内部忽略大小写重复的，除第一个外为 null） */
  userEmail: Map<string, string | null>;

  teams: Doc[];
  teamIds: Set<string>;
  teamRoles: RolePlan;
  teamMembers: Member[];

  projectSets: Doc[];
  projectSetIds: Set<string>;
  projectSetName: Map<string, string>;
  projectSetOrder: Map<string, number>;
  /** 作品集 oid → 所属团队 oid */
  projectSetTeam: Map<string, string>;

  projects: Doc[];
  projectIds: Set<string>;
  projectTeam: Map<string, string>;
  /** 作品 → 作品集 oid（null = 未归类） */
  projectSet: Map<string, string | null>;
  projectLanguage: Map<string, string>;
  /** 作品 → 创建人用户 oid */
  projectCreator: Map<string, string>;
  projectRoles: RolePlan;
  projectMembers: Member[];

  /** 只含**落库**的 target（同作品同语言的重复 target 已合并掉） */
  targets: Doc[];
  /** 任意 target oid → 实际落库的 target oid */
  targetAlias: Map<string, string>;
  targetProject: Map<string, string>;
  targetLanguage: Map<string, string>;
  targetLabel: Map<string, string>;
  targetOrder: Map<string, number>;
  /** 作品 oid → 落库 target oid 列表（按 targetOrder） */
  projectTargets: Map<string, string[]>;

  files: Doc[];
  fileIds: Set<string>;
  fileProject: Map<string, string>;
  /** 修订链根的 oid（首版 = 自身） */
  fileRoot: Map<string, string>;
  /** 直接上一版的 oid（null = 首版，或上一版不迁移） */
  fileOldRevision: Map<string, string | null>;
  credits: Map<string, CreditPlan>;

  notices: Doc[];
  noticeIds: Set<string>;
  noticeReads: Array<{ notice: string; user: string; readAt: Date }>;
  /** team 为旧团队 oid；roleId 为新站角色 id，null = 用团队默认角色（与旧站「空 = 团队默认」同义） */
  invites: Array<{ doc: Doc; code: string; team: string | null; roleId: string | null }>;
};

export type Ctx = {
  exp: MoeflowExport;
  plan: Plan;
  content: ContentPlan;
  report: Report;
  images: ImageSource | null;
};

export async function buildPlan(exp: MoeflowExport, report: Report): Promise<Plan> {
  const plan = {} as Plan;
  await planOrg(exp, plan, report);
  await planProjects(exp, plan, report);
  await planFiles(exp, plan, report);
  return plan;
}
