/** 第二步：作品集 → 作品（含编号游标）→ 作品角色 → 作品成员 → 目标语言。 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  projectMembers,
  projectRolePermissions,
  projectRoles,
  projectSets,
  projects,
  targets,
} from '../db/schema.js';
import type { Ctx } from './plan.js';
import {
  projectMemberRows,
  projectRoleRows,
  projectRows,
  projectSetRows,
  targetRows,
  type Derived,
} from './rows.js';
import { insertById, insertRows } from './util.js';

export async function stepProjects(ctx: Ctx, d: Derived): Promise<void> {
  const { plan, report } = ctx;

  await insertById(db, projectSets as never, projectSetRows(plan), report, 'project_sets');

  const rows = projectRows(plan, d.serials);
  await insertById(db, projects as never, rows, report, 'projects');

  // 编号游标要越过迁进来的作品。写成 UPDATE 而不是只靠插入时的初值 ——
  // 重跑时团队行已存在，初值不会再写第二遍，游标就会落后于实际最大编号，
  // 本站新建作品于是撞 (team_id, serial) 唯一键。
  const maxByTeam = new Map<string, number>();
  for (const row of rows) {
    const teamId = String(row.teamId);
    maxByTeam.set(teamId, Math.max(maxByTeam.get(teamId) ?? 0, Number(row.serial)));
  }
  for (const [teamId, serial] of maxByTeam) {
    await db.execute(sql`UPDATE teams SET project_seq = GREATEST(project_seq, ${serial}) WHERE id = ${teamId}`);
  }

  const roleRows = projectRoleRows(plan);
  await insertById(db, projectRoles as never, roleRows.roles, report, 'project_roles');
  await insertRows(
    db,
    projectRolePermissions,
    roleRows.permissions,
    report,
    'project_role_permissions',
    [projectRolePermissions.projectRoleId, projectRolePermissions.permissionCode],
  );

  await insertRows(
    db,
    projectMembers,
    projectMemberRows(plan),
    report,
    'project_members',
    [projectMembers.projectId, projectMembers.userId],
  );

  await insertById(db, targets as never, targetRows(plan), report, 'targets');
  report.note('作品域完成');
}
