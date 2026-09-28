import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type DbLike } from '../db/client.js';
import {
  files,
  projectMembers,
  projectRoles,
  projectSets,
  projects,
  teams,
  users,
  type Project,
} from '../db/schema.js';
import { aggregateStage, rankOf, STATE_RANK, type ProjectStage } from './workflow.js';

/**
 * 作品进度。**全部由文件状态聚合而来，不存计数器。**
 *
 * 参考实现在作品上存了一堆计数器（sc/tsc/csc…），结果是需要一整套
 * `recompute_stats()` 去修正漂移，而每次批量操作都可能忘记调用它。
 * 这里改成每次查询时现算：一个作品最多几百张图，一次 GROUP BY 就够，
 * 换来的是**计数永远与文件真实状态一致**，不需要任何「重算」入口。
 */

export type ProjectProgress = {
  fileCount: number;
  /** 状态序 ≥ translated 的张数（翻译已完成） */
  translatedCount: number;
  proofreadCount: number;
  typesetCount: number;
  publishedCount: number;
  /** 对外五档，取全部文件里最落后的一档 */
  stage: ProjectStage;
};

const EMPTY_PROGRESS: ProjectProgress = {
  fileCount: 0,
  translatedCount: 0,
  proofreadCount: 0,
  typesetCount: 0,
  publishedCount: 0,
  stage: 'translating',
};

export function emptyProgress(): ProjectProgress {
  return { ...EMPTY_PROGRESS };
}

export function progressFromStates(states: readonly string[]): ProjectProgress {
  let translated = 0;
  let proofread = 0;
  let typeset = 0;
  let published = 0;

  for (const state of states) {
    const rank = rankOf(state);
    if (rank >= STATE_RANK.translated) translated += 1;
    if (rank >= STATE_RANK.proofread) proofread += 1;
    if (rank >= STATE_RANK.typeset) typeset += 1;
    if (rank >= STATE_RANK.published) published += 1;
  }

  return {
    fileCount: states.length,
    translatedCount: translated,
    proofreadCount: proofread,
    typesetCount: typeset,
    publishedCount: published,
    stage: aggregateStage(states),
  };
}

/**
 * 一次把多个作品的进度算完。**不要在这个函数外面循环调用** ——
 * 那会把「一个作品一条查询」放大成 N 条，工作台上十张卡就是十次往返。
 */
export async function progressOfProjects(
  projectIds: readonly string[],
  tx: DbLike = db,
): Promise<Map<string, ProjectProgress>> {
  const result = new Map<string, ProjectProgress>();
  if (projectIds.length === 0) return result;

  const rows = await tx
    .select({
      projectId: files.projectId,
      state: files.state,
      total: count(),
    })
    .from(files)
    .where(
      and(
        inArray(files.projectId, [...projectIds]),
        // 软删除的图不算进度：删掉的页面不该拖住作品的状态。
        isNull(files.deletedAt),
        // 非当前修订版也不算 —— 它们只是历史。
        eq(files.activated, true),
      ),
    )
    .groupBy(files.projectId, files.state);

  const statesByProject = new Map<string, string[]>();
  for (const row of rows) {
    const list = statesByProject.get(row.projectId) ?? [];
    for (let i = 0; i < Number(row.total); i += 1) list.push(row.state);
    statesByProject.set(row.projectId, list);
  }

  for (const id of projectIds) {
    result.set(id, progressFromStates(statesByProject.get(id) ?? []));
  }
  return result;
}

/**
 * 作品的**第一页**。
 *
 * 两处用途，一次查询都给了：作品卡的默认封面，以及「继续翻译」这类主操作
 * 要跳到的目标文件。没有它，卡片上的主操作只能落到作品页，用户还得再点一次。
 *
 * 作品卡上那块图是整张卡片的信息重心，空着的话工作台看起来像一堆占位框。
 * 但也不该在**上传时**写进 `cover_file_id` —— 那样每传第一张就要写一次库，
 * 而且用户删掉第一页之后封面会变成指向已删除文件的悬空引用。
 * 所以改成读取时兜底：`cover_file_id` 只在**人主动指定**时才用。
 *
 * `DISTINCT ON` 一次查询拿到所有作品的第一页，避免了 N 次往返。
 */
export async function firstFilesOfProjects(
  projectIds: readonly string[],
  tx: DbLike = db,
): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();

  const rows = await tx
    .selectDistinctOn([files.projectId], { projectId: files.projectId, id: files.id })
    .from(files)
    .where(
      and(
        inArray(files.projectId, [...projectIds]),
        isNull(files.deletedAt),
        eq(files.activated, true),
      ),
    )
    .orderBy(files.projectId, asc(files.sortName));

  return new Map(rows.map((r) => [r.projectId, r.id]));
}

export type ProjectMemberChip = {
  userId: string;
  displayName: string;
  avatarKey: string | null;
  roleName: string;
  roleLevel: number;
};

/** 一次取回多个作品的参与成员（作品卡上的头像堆叠）。 */
export async function membersOfProjects(
  projectIds: readonly string[],
  tx: DbLike = db,
): Promise<Map<string, ProjectMemberChip[]>> {
  const result = new Map<string, ProjectMemberChip[]>();
  if (projectIds.length === 0) return result;

  const rows = await tx
    .select({
      projectId: projectMembers.projectId,
      userId: users.id,
      displayName: users.displayName,
      avatarKey: users.avatarKey,
      roleName: projectRoles.name,
      roleLevel: projectRoles.level,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(projectRoles, eq(projectRoles.id, projectMembers.projectRoleId))
    .where(inArray(projectMembers.projectId, [...projectIds]));

  for (const row of rows) {
    const list = result.get(row.projectId) ?? [];
    list.push({
      userId: row.userId,
      displayName: row.displayName,
      avatarKey: row.avatarKey,
      roleName: row.roleName,
      roleLevel: row.roleLevel,
    });
    result.set(row.projectId, list);
  }

  // 等级高的排前面 —— 作品卡上只露几个头像，先露「管事的人」更有信息量。
  for (const list of result.values()) {
    list.sort((a, b) => b.roleLevel - a.roleLevel || a.displayName.localeCompare(b.displayName));
  }
  return result;
}

/** 我在某个作品里的角色（作品卡据此决定「主操作」是哪一个）。 */
export type MyProjectRole = {
  id: string;
  name: string;
  level: number;
  systemCode: string | null;
};

async function myRolesInProjects(
  projectIds: readonly string[],
  viewerId: string,
  tx: DbLike,
): Promise<Map<string, MyProjectRole>> {
  const result = new Map<string, MyProjectRole>();
  if (projectIds.length === 0) return result;

  const rows = await tx
    .select({
      projectId: projectMembers.projectId,
      id: projectRoles.id,
      name: projectRoles.name,
      level: projectRoles.level,
      systemCode: projectRoles.systemCode,
    })
    .from(projectMembers)
    .innerJoin(projectRoles, eq(projectRoles.id, projectMembers.projectRoleId))
    .where(and(inArray(projectMembers.projectId, [...projectIds]), eq(projectMembers.userId, viewerId)));

  for (const row of rows) {
    result.set(row.projectId, {
      id: row.id,
      name: row.name,
      level: row.level,
      systemCode: row.systemCode,
    });
  }
  return result;
}

export type ProjectCard = {
  id: string;
  teamId: string;
  teamName: string;
  setId: string | null;
  setName: string | null;
  serial: number;
  name: string;
  intro: string;
  author: string;
  sourceLanguage: string;
  status: string;
  coverFileId: string | null;
  stage: ProjectStage;
  progress: ProjectProgress;
  members: ProjectMemberChip[];
  /** 观察者在此作品中的角色；未参与则为 null */
  myRole: MyProjectRole | null;
  /** 第一张图的 id。作品卡的主操作据此直达翻校页；没有图片时为 null。 */
  firstFileId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 作品集的名称映射，作品卡要显示「属于哪个作品集」。 */
export async function setNamesById(
  ids: readonly (string | null)[],
  tx: DbLike = db,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();

  const rows = await tx
    .select({ id: projectSets.id, name: projectSets.name })
    .from(projectSets)
    .where(inArray(projectSets.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** 把一批作品行装配成作品卡（含进度与成员），供工作台与团队页共用。 */
export async function buildProjectCards(
  rows: Array<{ project: Project; teamName: string }>,
  viewerId: string | null = null,
  tx: DbLike = db,
): Promise<ProjectCard[]> {
  const ids = rows.map((r) => r.project.id);
  const [progress, members, setNames, myRoles, covers] = await Promise.all([
    progressOfProjects(ids, tx),
    membersOfProjects(ids, tx),
    setNamesById(rows.map((r) => r.project.setId), tx),
    viewerId ? myRolesInProjects(ids, viewerId, tx) : Promise.resolve(new Map<string, MyProjectRole>()),
    firstFilesOfProjects(ids, tx),
  ]);

  return rows.map(({ project, teamName }) => {
    const p = progress.get(project.id) ?? emptyProgress();
    return {
      id: project.id,
      teamId: project.teamId,
      teamName,
      setId: project.setId,
      setName: project.setId ? (setNames.get(project.setId) ?? null) : null,
      serial: project.serial,
      name: project.name,
      intro: project.intro,
      author: project.author,
      sourceLanguage: project.sourceLanguage,
      status: project.status,
      // 显式指定的封面优先；没指定就用第一页（见 firstFilesOfProjects 的说明）。
      coverFileId: project.coverFileId ?? covers.get(project.id) ?? null,
      firstFileId: covers.get(project.id) ?? null,
      stage: p.stage,
      progress: p,
      members: members.get(project.id) ?? [],
      myRole: myRoles.get(project.id) ?? null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  });
}

/**
 * 作品列表的通用查询。
 *
 * 刻意**不支持按进度档位过滤**：档位是从文件状态聚合出来的，
 * 在 SQL 里表达要 join 一堆条件，而作品数量级（几百）允许
 * 「取出来 → 算进度 → 在内存里筛」。少一条 SQL，少一处「筛出来的结果
 * 与卡片上显示的档位不一致」的机会。
 */
export async function queryProjects(options: {
  teamId?: string;
  teamIds?: readonly string[];
  setId?: string | null;
  status?: string;
  keyword?: string;
  limit?: number;
}) {
  const conditions = [];
  if (options.teamId) conditions.push(eq(projects.teamId, options.teamId));
  if (options.teamIds) {
    conditions.push(
      inArray(
        projects.teamId,
        options.teamIds.length > 0 ? [...options.teamIds] : [ZERO_UUID],
      ),
    );
  }
  if (options.status) conditions.push(eq(projects.status, options.status));
  if (options.setId === null) conditions.push(isNull(projects.setId));
  else if (options.setId) conditions.push(eq(projects.setId, options.setId));

  if (options.keyword) {
    const like = `%${options.keyword.toLowerCase()}%`;
    conditions.push(sql`(lower(${projects.name}) LIKE ${like} OR lower(${projects.author}) LIKE ${like})`);
  }

  return db
    .select({ project: projects, teamName: teams.name })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${projects.updatedAt} DESC`)
    .limit(options.limit ?? 200);
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
