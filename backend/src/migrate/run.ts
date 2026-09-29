/**
 * 迁移的入口：校验导出 → 算计划 → 写库 → 就地核验 → 落报告。
 *
 * 三步都写进**同一份报告**：这样「跑完给出的那个 JSON」既是执行记录也是验收证据，
 * 而不是「跑完说成功、核验另开一次、两次之间库还被谁动过」。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/client.js';
import type { ImageSource } from './images.js';
import type { Ctx, Plan } from './plan.js';
import { buildPlan } from './plan.js';
import { planContent, type ContentPlan } from './plan-content.js';
import { DISPOSITIONS, type Report } from './report.js';
import { derive } from './rows.js';
import { Report as ReportClass } from './report.js';
import { stepContent } from './steps-content.js';
import { stepFiles } from './steps-files.js';
import { stepOrg } from './steps-org.js';
import { stepProjects } from './steps-projects.js';
import { MoeflowExport } from './source.js';
import { verify } from './verify.js';

export type MigrateOptions = {
  exportDir: string;
  reportPath: string;
  /** 图片字节的来源；不给就只迁元数据（图片全是空记录，报告里会标出来） */
  images: ImageSource | null;
  /** inventory = 只算不写；migrate = 写库 + 核验；verify = 只核验（不写任何东西） */
  mode: 'inventory' | 'migrate' | 'verify';
};

/**
 * 导出快照自检。**必须先过这一关**：少导一截的 `source.json` 看起来也是一份合法输入，
 * 直接迁进去就是静默丢数据 —— 而这正是「无损迁移」最怕的那种失败。
 */
export async function checkExport(exp: MoeflowExport, report: Report): Promise<void> {
  const manifest = await exp.manifest();
  const present = new Set(await exp.collectionFiles());
  const unknown: string[] = [];
  let allCountsMatch = true;

  for (const [name, count] of Object.entries(manifest.collections)) {
    const disposition = DISPOSITIONS[name];
    if (!disposition) {
      unknown.push(name);
      continue;
    }
    const lines = present.has(name) ? (await exp.lineCount(name)) ?? 0 : 0;
    if (lines !== count) {
      allCountsMatch = false;
      report.check(
        `export-count:${name}`,
        'fail',
        `${name}：文件里 ${lines} 行，manifest 记 ${count} 行 —— 导出被截断或写了一半`,
      );
    }
    // 去向表按「导出那一刻 Mongo 里的文档数」记，所以展示也用 manifest 的数
    report.dispositions.push({ collection: name, action: disposition.action, count, reason: disposition.reason });
    if (disposition.confirmIfAny && count > 0) {
      report.check(`disposition:${name}`, 'confirm', `${name} 有 ${count} 条数据不迁：${disposition.reason}`);
    }
  }
  for (const name of present) if (!(name in DISPOSITIONS)) unknown.push(name);

  report.check(
    'export-collections',
    unknown.length ? 'fail' : 'ok',
    unknown.length
      ? `导出里有没登记去向的集合：${[...new Set(unknown)].join('、')} —— 先确认它是新功能还是漏登记`
      : `导出的 ${present.size} 个集合都有登记的去向`,
  );
  report.check('export-counts', allCountsMatch ? 'ok' : 'fail', allCountsMatch ? 'manifest 计数与文件行数逐一对上' : '有集合的行数与 manifest 不符');
}

export async function runMigration(options: MigrateOptions): Promise<Report> {
  const report = new ReportClass();
  const exp = new MoeflowExport(options.exportDir);
  report.note(`导出目录：${options.exportDir}`);
  report.note(`图片字节来源：${options.images ? options.images.describe() : '（未提供，只迁元数据）'}`);

  await checkExport(exp, report);
  if (report.failed) {
    report.note('导出快照自检未通过：后面的步骤不再执行');
    return finish(report, options.reportPath);
  }

  const plan: Plan = await buildPlan(exp, report);
  report.note(
    `计划：用户 ${plan.users.length}、团队 ${plan.teams.length}、作品集 ${plan.projectSets.length}、作品 ${plan.projects.length}、` +
      `目标语言 ${plan.targets.length}、文件 ${plan.files.length}、公告 ${plan.notices.length}、邀请码 ${plan.invites.length}`,
  );
  const content: ContentPlan = await planContent(exp, plan, report);
  report.note(`内容：标号 ${content.sourceCount}、译文 ${content.translationCount}`);

  const ctx: Ctx = { exp, plan, content, report, images: options.images };
  const derived = await derive(db, plan, report);

  if (options.mode === 'inventory') {
    report.note('盘点模式：只算不写。确认清单与有损点后再跑 migrate。');
    return finish(report, options.reportPath);
  }

  if (options.mode === 'migrate') {
    await stepOrg(ctx, derived);
    await stepProjects(ctx, derived);
    await stepFiles(ctx, derived);
    await stepContent(ctx, derived);
  }
  await verify(ctx, derived);
  return finish(report, options.reportPath);
}

async function finish(report: Report, reportPath: string): Promise<Report> {
  report.finishedAt = new Date().toISOString();
  const payload = JSON.stringify(report.toJSON(), null, 2);
  let target = reportPath;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, payload, 'utf8');
  } catch (err) {
    // 快照目录**通常是以只读方式挂进来的**（那是我们自己的建议），默认报告路径就落在它里面。
    // 写不进去不该让整趟迁移白跑 —— 退到当前目录再试一次，并说明写到了哪儿。
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EROFS' && code !== 'EACCES' && code !== 'EPERM') throw err;
    target = path.resolve('migrate-report.json');
    await fs.writeFile(target, payload, 'utf8');
    console.warn(`[migrate] 报告目录只读，改写到 ${target}`);
  }
  reportPath = target;
  const result = report.toJSON().result;
  console.log(`\n[migrate] 结论：${result}`);
  console.log(`[migrate] 报告已写入 ${reportPath}`);
  if (report.failed) {
    console.error('[migrate] 有硬性对账未通过 —— 不要把这批数据当成迁移完成的。');
  } else if (report.needsConfirmation.length) {
    console.warn(`[migrate] 有 ${report.needsConfirmation.length} 项需要人工确认（有损点或取舍）。`);
  }
  return report;
}
