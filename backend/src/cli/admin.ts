/**
 * 管理 CLI —— 忘记密码、没有可用管理员时的自救通道。
 *
 *   npm run cli -w backend -- list
 *   npm run cli -w backend -- set 用户名
 *   npm run cli -w backend -- unset 用户名
 *   npm run cli -w backend -- passwd 用户名 [新密码]
 *   npm run cli -w backend -- sync-roles          列出全部团队并补默认权限
 *   npm run cli -w backend -- sync-roles 团队名    只补这一个团队
 *
 * 容器里：
 *   docker compose -f deploy/docker-compose.yml run --rm backend node backend/dist/cli/admin.js list
 *
 * 子命令与输出文案对标图译空间的 scripts/admin.mjs。与它的一处差别：
 * 它直接开 SQLite 文件，这里走正常的数据库连接（Postgres 没有「一个文件」可开）。
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import { closeDb, db } from '../db/client.js';
import { projects, teams, users } from '../db/schema.js';
import { syncProjectRoleDefaults, syncProjectRoleTemplateDefaults } from '../domain/project-roles.js';

const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomPassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  return out;
}

function printUsage(): void {
  console.log(`用法：node backend/dist/cli/admin.js <命令> [参数]

命令：
  list                     列出全部用户与站点管理员状态
  set <用户名>             授予站点管理员
  unset <用户名>           收回站点管理员
  passwd <用户名> [新密码]  重置密码（不填新密码则随机生成并打印）
  sync-roles [团队名]      把代码里的项目角色默认权限**只增不减**地补齐
                           （不填团队名则全部团队）

说明：站点管理员也可以用网页后台完成上述操作，这个 CLI 是「进不去后台」时的兜底。
      sync-roles 是给「代码里加了新权限、老团队用不上」这种情况的运维入口 ——
      它同时补团队模板与团队下所有已有作品的角色。`);
}

function formatTime(value: Date | null): string {
  if (!value) return '-';
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

const STATUS_LABEL: Record<string, string> = {
  active: '正常',
  disabled: '已停用',
  deactivated: '已注销',
};

async function findUser(username: string) {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return rows[0];
}

async function commandList(): Promise<void> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isSiteAdmin: users.isSiteAdmin,
      status: users.status,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.username));

  if (rows.length === 0) {
    console.log('（数据库中还没有任何用户）');
    console.log('提示：可用 npm run seed -w backend 创建首个站点管理员。');
    return;
  }

  console.log(`共 ${rows.length} 个用户：\n`);
  const width = Math.max(...rows.map((r) => r.username.length), 8);
  console.log(
    `${'用户名'.padEnd(width)}  ${'管理员'.padEnd(6)}  ${'状态'.padEnd(6)}  昵称`,
  );
  console.log('-'.repeat(width + 30));
  for (const row of rows) {
    console.log(
      `${row.username.padEnd(width)}  ${(row.isSiteAdmin ? '✔ 是' : '否').padEnd(6)}  ` +
        `${(STATUS_LABEL[row.status] ?? row.status).padEnd(6)}  ${row.displayName}`,
    );
  }

  const admins = rows.filter((r) => r.isSiteAdmin && r.status === 'active');
  console.log(
    `\n当前管理员（${admins.length} 个）：${admins.length > 0 ? admins.map((a) => a.username).join('、') : '（无）'}`,
  );
}

async function commandSet(username: string, next: boolean): Promise<number> {
  const user = await findUser(username);
  if (!user) {
    console.error(`[错误] 用户「${username}」不存在。先用 list 查看全部用户名。`);
    return 1;
  }

  if (user.isSiteAdmin === next) {
    console.log(`[跳过] 「${username}」已经是${next ? '管理员' : '普通用户'}，无需变更。`);
    return 0;
  }

  await db
    .update(users)
    .set({ isSiteAdmin: next, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  console.log(`[完成] 「${username}」已${next ? '获得' : '收回'}管理员权限。`);
  return 0;
}

async function commandPasswd(username: string, newPassword?: string): Promise<number> {
  const user = await findUser(username);
  if (!user) {
    console.error(`[错误] 用户「${username}」不存在。先用 list 查看全部用户名。`);
    return 1;
  }

  const provided = newPassword?.trim();
  if (provided && provided.length < 8) {
    console.error('[错误] 新密码长度需至少 8 位。');
    return 1;
  }

  const next = provided || randomPassword();

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(next), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  console.log(`[完成] 「${username}」的密码已重置。`);
  if (!provided) {
    console.log(`随机新密码：${next}（请立即转告该用户，此消息不会再次显示）`);
  }
  return 0;
}

/**
 * 补齐项目角色的默认权限。
 *
 * 为什么需要这个入口：作品的系统角色是建作品时从团队模板**复制**的快照，
 * 而团队模板又只在第一次用到时按当时的代码建一次。「代码里加了新权限」
 * 之后，老团队会一直缺那个权限 —— 症状是功能上线了，用户一点就报
 * 「需要 xxx」，界面上却看不出哪里配错了。
 *
 * 两处都补，因为它们各自独立地会漂移：
 *   1. **团队模板** —— 不补的话，该团队**以后新建的作品**照样缺；
 *   2. **每个已有作品的角色** —— 不补的话，现有作品立刻就是坏的。
 *
 * 语义**只增不减**（与 `syncProjectRoleDefaults` 一致）：手工加过的保留，
 * 只补缺的。想真正减掉某个权限，请建自定义角色 —— 那条路径不在这里，
 * 永远不会被这个命令碰到。
 */
async function commandSyncRoles(teamName?: string): Promise<number> {
  const teamRows = teamName
    ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.name, teamName))
    : await db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name));

  if (teamRows.length === 0) {
    console.error(`[错误] 没有找到团队${teamName ? `「${teamName}」` : ''}。`);
    return 1;
  }

  let totalAdded = 0;

  for (const team of teamRows) {
    console.log(`\n团队：${team.name}`);

    const templateReport = await syncProjectRoleTemplateDefaults(team.id);
    if (templateReport.length === 0) {
      console.log('  · 团队模板：已是最新');
    } else {
      for (const item of templateReport) {
        console.log(`  · 团队模板「${item.role}」补了 ${item.added.length} 项：${item.added.join('、')}`);
        totalAdded += item.added.length;
      }
    }

    const projectRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.teamId, team.id))
      .orderBy(asc(projects.serial));

    if (projectRows.length === 0) {
      console.log('  · 该团队还没有作品');
      continue;
    }

    let touchedProjects = 0;
    for (const project of projectRows) {
      const report = await syncProjectRoleDefaults(project.id);
      if (report.length === 0) continue;
      touchedProjects += 1;
      const detail = report.map((r) => `${r.role}+${r.added.length}`).join('、');
      console.log(`  · 作品「${project.name}」：${detail}`);
      totalAdded += report.reduce((sum, r) => sum + r.added.length, 0);
    }
    if (touchedProjects === 0) console.log(`  · ${projectRows.length} 个作品的角色都已是最新`);
  }

  console.log(`\n[完成] 共补 ${totalAdded} 项权限。`);
  return 0;
}

async function main(): Promise<void> {
  const [command, username, newPassword] = process.argv.slice(2);

  if (!command) {
    printUsage();
    return;
  }

  switch (command) {
    case 'list':
      await commandList();
      return;

    case 'set':
    case 'unset': {
      if (!username) {
        console.error('[错误] 缺少用户名参数。');
        printUsage();
        process.exitCode = 1;
        return;
      }
      process.exitCode = await commandSet(username, command === 'set');
      return;
    }

    case 'sync-roles': {
      process.exitCode = await commandSyncRoles(username);
      return;
    }

    case 'passwd': {
      if (!username) {
        console.error('[错误] 缺少用户名参数。');
        printUsage();
        process.exitCode = 1;
        return;
      }
      process.exitCode = await commandPasswd(username, newPassword);
      return;
    }

    default:
      console.error(`[错误] 未知命令「${command}」。`);
      printUsage();
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('[错误] 执行失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
