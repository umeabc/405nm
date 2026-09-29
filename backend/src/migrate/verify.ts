/**
 * 核验：**拿同一份计划重算一遍期望值，再与库里的实际行逐字段比**。
 *
 * 为什么不是「迁移时记下写了什么，之后自己跟自己比」：那样只能证明「写进去的等于它想写的」，
 * 证明不了「想写的等于旧库里的」。这里两边用的是同一套纯函数 —— 差异只可能来自
 * 「写漏了、写重了、写错了、被别的进程改了」，正是要抓的东西。
 *
 * 比对口径：
 *  - 期望行只列出「该有哪些列」，实际行按期望的列投影后再比 —— 多出来的列（如 bigserial 的 seq）不参与；
 *  - 值先过 `canonical`（Date → ISO、对象键排序、undefined 与 null 归一），
 *    否则会淹在 `'0' vs 0`、`null vs undefined` 这类噪声里；
 *  - 图片**重新读一遍字节**算摘要，与行上的 md5/sha256/size 对 —— 这是唯一能证明「图真的在」的办法。
 */
import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  fileCredits,
  fileStates,
  files,
  inviteCodes,
  noticeReads,
  notices,
  projectMembers,
  projectRolePermissions,
  projectRoles,
  projectSets,
  projects,
  rolePermissions,
  roles,
  sources,
  targets,
  teamMembers,
  teams,
  translations,
  users,
} from '../db/schema.js';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { digest } from '../lib/image.js';
import { variantKey } from '../storage/keys.js';
import { storage } from '../storage/index.js';
import { sourceBatches, translationBatches } from './plan-content.js';
import type { Ctx } from './plan.js';
import { canonical, chunk } from './util.js';
import {
  creditRows,
  fileRow,
  inviteConflicts,
  inviteRows,
  noticeReadRows,
  noticeRows,
  projectMemberRows,
  projectRoleRows,
  projectSetRows,
  projectRows,
  projectTemplateRows,
  targetRows,
  teamMemberRows,
  teamRoleRows,
  teamRow,
  type Derived,
  userRow,
} from './rows.js';
import { lid, oidTime, str, type Doc } from './source.js';

type Rows = Array<Record<string, unknown>>;

async function* asBatches(input: Rows | AsyncIterable<Rows>): AsyncGenerator<Rows> {
  if (Symbol.asyncIterator in input) {
    for await (const batch of input as AsyncIterable<Rows>) yield batch;
    return;
  }
  yield input as Rows;
}

/** 逐行逐字段比。期望行里出现了哪些列，就比哪些列。 */
async function compareRows(
  report: Ctx['report'],
  name: string,
  table: PgTable & { id: PgColumn },
  input: Rows | AsyncIterable<Rows>,
): Promise<void> {
  let checked = 0;
  let missing = 0;
  let mismatched = 0;
  const samples: string[] = [];
  for await (const batch of asBatches(input)) {
    if (!batch.length) continue;
    const ids = batch.map((row) => String(row.id));
    const actual = (await db.select().from(table).where(inArray(table.id, ids))) as Rows;
    const byId = new Map(actual.map((row) => [String(row.id), row]));
    for (const wanted of batch) {
      checked += 1;
      const got = byId.get(String(wanted.id));
      if (!got) {
        missing += 1;
        if (samples.length < 8) samples.push(`缺行 ${String(wanted.id)}`);
        continue;
      }
      const projected: Record<string, unknown> = {};
      for (const key of Object.keys(wanted)) projected[key] = got[key];
      const a = canonical(wanted);
      const b = canonical(projected);
      if (a !== b) {
        mismatched += 1;
        if (samples.length < 8) samples.push(`字段不符 ${String(wanted.id)}：期望 ${clip(a)} / 实得 ${clip(b)}`);
      }
    }
  }
  report.check(
    name,
    missing || mismatched ? 'fail' : 'ok',
    `逐字段核对 ${checked} 行：缺 ${missing}，不符 ${mismatched}`,
    { samples },
  );
}

const clip = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

/** 关联表（复合主键）：比「键的集合」。这些表的行数少，直接全量比集合大小与内容。 */
async function compareKeys(
  report: Ctx['report'],
  name: string,
  expected: string[],
  actual: string[],
): Promise<void> {
  const want = new Set(expected);
  const got = new Set(actual);
  const missing = [...want].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !want.has(k));
  report.check(
    name,
    missing.length || extra.length ? 'fail' : 'ok',
    `核对 ${want.size} 条关联：缺 ${missing.length}，多 ${extra.length}`,
    { missing: missing.slice(0, 8), extra: extra.slice(0, 8) },
  );
}

const R = <T>(rows: T[]): Rows => rows as unknown as Rows;

/** 组织域：用户 / 团队 / 角色 / 成员 / 公告 / 邀请码。 */
async function verifyOrg(ctx: Ctx, d: Derived): Promise<void> {
  const { plan, report } = ctx;

  await compareRows(
    report,
    'users',
    users as never,
    R(plan.users.map((u) => userRow(u, d.usernames.get(u._id)!, d.emails.get(u._id) ?? null))),
  );
  await compareRows(
    report,
    'teams',
    teams as never,
    R(plan.teams.map((t) => teamRow(t, d.teamNames.get(t._id)!, plan, d.inputs))),
  );

  const teamRoles = teamRoleRows(plan);
  const templates = projectTemplateRows(plan);
  await compareRows(report, 'roles（团队）', roles as never, R(teamRoles.roles));
  await compareRows(report, 'roles（项目模板）', roles as never, R(templates.roles));

  const roleIds = [...teamRoles.roles, ...templates.roles].map((r) => String(r.id));
  const wantPerms = [...teamRoles.permissions, ...templates.permissions].map((p) => `${String(p.roleId)}:${String(p.permissionCode)}`);
  const gotPerms = (
    await db
      .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds))
  ).map((p) => `${p.roleId}:${p.code}`);
  await compareKeys(report, 'role_permissions', wantPerms, gotPerms);

  const teamIds = plan.teams.map((t) => lid('team', t._id));
  const wantMembers = teamMemberRows(plan).map((m) => `${m.teamId}:${m.userId}`);
  const gotMembers = (await db.select().from(teamMembers).where(inArray(teamMembers.teamId, teamIds))).map(
    (m) => `${m.teamId}:${m.userId}`,
  );
  await compareKeys(report, 'team_members', wantMembers, gotMembers);

  await compareRows(report, 'notices', notices as never, R(noticeRows(plan)));
  const noticeIds = plan.notices.map((n) => lid('notice', n._id));
  const wantReads = noticeReadRows(plan).map((r) => `${r.noticeId}:${r.userId}`);
  const gotReads = noticeIds.length
    ? (await db.select().from(noticeReads).where(inArray(noticeReads.noticeId, noticeIds))).map((r) => `${r.noticeId}:${r.userId}`)
    : [];
  await compareKeys(report, 'notice_reads', wantReads, gotReads);

  await compareRows(report, 'invite_codes', inviteCodes as never, R(inviteRows(plan)));
  // 重新判一次撞码：迁移时判过，但两次之间可能有人手工加了同码的邀请码
  report.check(
    'invite-code-conflict',
    inviteConflicts(plan, d.inputs).length ? 'fail' : 'ok',
    '邀请码与站内已有码的冲突复查',
  );
}

/** 作品域：作品集 / 作品 / 作品角色 / 作品成员 / 目标语言。 */
async function verifyProjects(ctx: Ctx, d: Derived): Promise<void> {
  const { plan, report } = ctx;
  await compareRows(report, 'project_sets', projectSets as never, R(projectSetRows(plan)));
  await compareRows(report, 'projects', projects as never, R(projectRows(plan, d.serials)));

  const rows = projectRoleRows(plan);
  await compareRows(report, 'project_roles', projectRoles as never, R(rows.roles));

  const roleIds = rows.roles.map((r) => String(r.id));
  const wantPerms = rows.permissions.map((p) => `${String(p.projectRoleId)}:${String(p.permissionCode)}`);
  const gotPerms = roleIds.length
    ? (
        await db
          .select({ roleId: projectRolePermissions.projectRoleId, code: projectRolePermissions.permissionCode })
          .from(projectRolePermissions)
          .where(inArray(projectRolePermissions.projectRoleId, roleIds))
      ).map((p) => `${p.roleId}:${p.code}`)
    : [];
  await compareKeys(report, 'project_role_permissions', wantPerms, gotPerms);

  const projectIds = plan.projects.map((p) => lid('project', p._id));
  const wantMembers = projectMemberRows(plan).map((m) => `${m.projectId}:${m.userId}`);
  const gotMembers = projectIds.length
    ? (await db.select().from(projectMembers).where(inArray(projectMembers.projectId, projectIds))).map(
        (m) => `${m.projectId}:${m.userId}`,
      )
    : [];
  await compareKeys(report, 'project_members', wantMembers, gotMembers);

  await compareRows(report, 'targets', targets as never, R(targetRows(plan)));
}

/**
 * 图片域：**把字节重新读一遍**算摘要，与行上的 md5/sha256/size 对，并确认两个变体都在。
 * 顺带核对署名台账的顺序（`seq` 的先后就是显示顺序）与文件状态。
 */
async function verifyFiles(ctx: Ctx): Promise<void> {
  const { plan, report, content } = ctx;
  let checked = 0;
  let bad = 0;
  let empty = 0;
  let creditBad = 0;
  let stateBad = 0;
  const samples: string[] = [];
  const push = (text: string) => {
    if (samples.length < 10) samples.push(text);
  };

  for (const group of chunk(plan.files, 200)) {
    const ids = group.map((f) => lid('file', f._id));
    const [fileRows, creditRowsDb, stateRowsDb] = await Promise.all([
      db.select().from(files).where(inArray(files.id, ids)),
      db
        .select({ fileId: fileCredits.fileId, role: fileCredits.role, displayName: fileCredits.displayName, userId: fileCredits.userId })
        .from(fileCredits)
        .where(inArray(fileCredits.fileId, ids))
        .orderBy(fileCredits.seq),
      db
        .select({ id: fileStates.id, fileId: fileStates.fileId, toState: fileStates.toState })
        .from(fileStates)
        .where(inArray(fileStates.fileId, ids))
        .orderBy(fileStates.id),
    ]);
    const byId = new Map(fileRows.map((r) => [r.id, r]));

    const gotCredits = new Map<string, string[]>();
    for (const row of creditRowsDb) {
      const list = gotCredits.get(row.fileId) ?? [];
      list.push(`${row.role}:${row.displayName}:${row.userId ?? ''}`);
      gotCredits.set(row.fileId, list);
    }
    const firstState = new Map<string, string>();
    for (const row of stateRowsDb) if (!firstState.has(row.fileId)) firstState.set(row.fileId, row.toState);

    for (const doc of group) {
      const id = lid('file', doc._id);
      const row = byId.get(id);
      if (!row) {
        bad += 1;
        push(`缺文件行 ${id}`);
        continue;
      }
      if (row.size === 0) empty += 1;
      else {
        const buffer = await storage.getBuffer(row.storageKey);
        const info = buffer ? digest(buffer) : null;
        if (!info || info.md5 !== row.md5 || info.size !== row.size || info.sha256 !== row.sha256) {
          bad += 1;
          push(`字节与行上的摘要不符 ${id}`);
        } else {
          const legacyMd = str(doc.md).trim().toLowerCase();
          if (legacyMd && legacyMd !== info.md5) {
            bad += 1;
            push(`字节与旧库记的 md5 不符 ${id}`);
          }
          const thumb = await storage.stat(variantKey(row.storageKey, 'thumb'));
          const preview = await storage.stat(variantKey(row.storageKey, 'preview'));
          if (!thumb || !preview) {
            bad += 1;
            push(`缺缩略图或预览图 ${id}`);
          }
        }
        checked += 1;
      }

      // 署名：顺序必须与旧站的 token 顺序一致
      const want = creditRows(doc, plan, oidTime(doc._id)).map((c) => `${c.role}:${c.displayName}:${c.userId ?? ''}`);
      const got = gotCredits.get(id) ?? [];
      if (want.join('|') !== got.join('|')) {
        creditBad += 1;
        push(`署名台账不符 ${id}`);
      }

      const wantState = content.fileState.get(doc._id) ?? 'sourced';
      if (firstState.get(id) !== wantState) {
        stateBad += 1;
        push(`文件状态不符 ${id}`);
      }
    }
  }

  report.check(
    'image-bytes',
    bad ? 'fail' : 'ok',
    `复算 ${checked} 张图的字节摘要与两个变体：异常 ${bad}；空记录（旧站本来就没有字节）${empty} 张`,
    { samples },
  );
  report.check('file-credits', creditBad ? 'fail' : 'ok', `署名台账顺序不符 ${creditBad} 个文件`);
  report.check('file-states', stateBad ? 'fail' : 'ok', `文件状态与推定值不符 ${stateBad} 个文件`);
}

async function* castBatches(input: AsyncIterable<unknown[]>): AsyncGenerator<Rows> {
  for await (const batch of input) yield batch as unknown as Rows;
}

/** 内容域：标号与译文。这两张表太大，不落内存 —— 边生成期望行边比。 */
async function verifyContent(ctx: Ctx): Promise<void> {
  const { exp, plan, report } = ctx;
  await compareRows(report, 'sources', sources as never, castBatches(sourceBatches(exp, plan, 500)));
  await compareRows(report, 'translations', translations as never, castBatches(translationBatches(exp, plan, 500)));
}

export async function verify(ctx: Ctx, d: Derived): Promise<void> {
  const { plan, report, content } = ctx;
  report.note('核验：用同一份计划重算期望值，再与库里的行逐字段比对');

  await verifyOrg(ctx, d);
  await verifyProjects(ctx, d);
  await verifyContent(ctx);
  await verifyFiles(ctx);

  // 行数复查：逐行比对只看「期望的行在不在、对不对」，
  // 抓不到「库里多出一些谁都不认识的迁移行」—— 那个用 legacy_id 数一遍才发现得了。
  const teamRoles = teamRoleRows(plan);
  const templates = projectTemplateRows(plan);
  const projectRoleRowsAll = projectRoleRows(plan);
  await checkCount(report, 'users', users as never, plan.users.length);
  await checkCount(report, 'teams', teams as never, plan.teams.length);
  // 只数**团队角色**：项目角色模板的 legacy_id 是空的（它们是按本站默认补建的）
  await checkCount(report, 'roles（团队）', roles as never, teamRoles.roles.length, eq(roles.scope, 'team'));
  await checkCount(report, 'project_sets', projectSets as never, plan.projectSets.length);
  await checkCount(report, 'projects', projects as never, plan.projects.length);
  await checkCount(report, 'project_roles', projectRoles as never, projectRoleRowsAll.roles.length);
  await checkCount(report, 'targets', targets as never, plan.targets.length);
  await checkCount(report, 'files', files as never, plan.files.length);
  await checkCount(report, 'sources', sources as never, content.sourceCount);
  await checkCount(report, 'translations', translations as never, content.translationCount);
  await checkCount(report, 'invite_codes', inviteCodes as never, plan.invites.length);

  report.note('核验完成');
}

/**
 * 库里带 `legacy_id` 的行数 vs 本次快照该迁的行数。逐行比对只看「期望的行在不在、对不对」，
 * 抓不到「库里多出一些谁都不认识的迁移行」—— 那个只能这样数出来。
 *
 * 三种结果，**含义不同、处理方式也不同**：
 *  - 少了 → `fail`：该迁的没落地（多半是中断了）；
 *  - 正好 → ok；
 *  - 多了 → `confirm`：多出来的**不属于本次快照**（上一次迁移的残留，或另一套来源库的数据）。
 *    它不影响本次迁进来的行是否正确，但切库前必须有人确认这些残留该不该在。
 *    早先这里写成 `fail`，结果是「重跑一次测试套件就必然失败」—— 判据本身错了。
 *
 * ⚠️ `extraWhere` 不是可有可无的：`roles` 里**同时**放着迁移来的团队角色（有 legacy_id）
 * 和按本站默认补建的项目角色模板（legacy_id 为空），不限定范围就会拿两者之和去比。
 */
async function checkCount(
  report: Ctx['report'],
  name: string,
  table: PgTable & { legacyId: PgColumn },
  expected: number,
  extraWhere?: SQL,
): Promise<void> {
  const condition = extraWhere ? and(isNotNull(table.legacyId), extraWhere) : isNotNull(table.legacyId);
  const rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(condition)) as Array<{ n: number }>;
  const actual = Number(rows[0]?.n ?? 0);
  if (actual === expected) {
    report.check(`${name}-行数`, 'ok', `库里带 legacy_id 的行 ${actual} 行，与本次快照一致`);
    return;
  }
  if (actual < expected) {
    report.check(`${name}-行数`, 'fail', `库里带 legacy_id 的行 ${actual} 行，比本次快照少 ${expected - actual} 行`);
    return;
  }
  report.check(
    `${name}-行数`,
    'confirm',
    `库里带 legacy_id 的行比本次快照多 ${actual - expected} 行：它们不属于这次迁移（上一次的残留或另一套来源库），切库前要确认`,
  );
}
