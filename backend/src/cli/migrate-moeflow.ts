/**
 * moeflow（彩翻）→ 405nm 迁移 CLI。
 *
 *   node backend/dist/cli/migrate-moeflow.js inventory --export <导出目录> [--images-dir <旧存储目录>]
 *   node backend/dist/cli/migrate-moeflow.js migrate   --export <导出目录> (--images-dir <目录> | --images-base-url <网址前缀>)
 *   node backend/dist/cli/migrate-moeflow.js verify    --export <导出目录> [--images-dir <目录>]
 *
 * 通用参数：`--report <文件>` 指定报告路径（默认 <导出目录>/migrate-report.json）。
 *
 * 三点约定：
 *  - **不开新库、不碰旧库**：只读导出快照与旧存储，只写本站的库与本站的存储目录；
 *  - `inventory` 不写任何东西，先跑它看清单与有损点，确认后再 `migrate`；
 *  - 报告里**不会出现**图片源地址（可能含内网 IP 或旧站域名），只写来源类型。
 */
import { closeDb } from '../db/client.js';
import { dirSource, httpSource, type ImageSource } from '../migrate/images.js';
import { runMigration } from '../migrate/run.js';

const USAGE = `用法：
  migrate-moeflow inventory --export <目录> [--images-dir <目录>] [--report <文件>]
  migrate-moeflow migrate   --export <目录> (--images-dir <目录> | --images-base-url <前缀>) [--report <文件>]
  migrate-moeflow verify    --export <目录> [--images-dir <目录>] [--report <文件>]

  inventory  只算不写：清点要迁多少、有哪些有损点
  migrate    写库并就地核验（可中断重跑，重复执行不会写重复行）
  verify     只做核验（与 migrate 用同一份计划与同一批纯函数）
`;

type Flags = Record<string, string | true>;

function parse(argv: string[]): { command: string; flags: Flags } {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'inventory';
  const flags: Flags = {};
  const rest = command === argv[0] ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('--')) throw new Error(`不认识的位置参数：${token}`);
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else flags[key] = true;
  }
  return { command, flags };
}

const str = (flags: Flags, key: string): string | null => {
  const value = flags[key];
  return typeof value === 'string' ? value : null;
};

async function main(): Promise<void> {
  const { command, flags } = parse(process.argv.slice(2));
  const exportDir = str(flags, 'export');
  if (!exportDir) {
    console.error('[错误] 缺少 --export <导出目录>');
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const reportPath = str(flags, 'report') ?? `${exportDir.replace(/[\\/]+$/, '')}/migrate-report.json`;

  const imagesDir = str(flags, 'images-dir');
  const imagesBase = str(flags, 'images-base-url');
  if (imagesDir && imagesBase) {
    console.error('[错误] --images-dir 与 --images-base-url 只能给一个');
    process.exitCode = 1;
    return;
  }
  const images: ImageSource | null = imagesDir ? dirSource(imagesDir) : imagesBase ? httpSource(imagesBase) : null;

  if (command !== 'inventory' && command !== 'migrate' && command !== 'verify') {
    console.error(`[错误] 未知命令「${command}」`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const report = await runMigration({
    exportDir,
    reportPath,
    images,
    // verify 不带 --images 也要能跑：核验读的是**新库的**字节，与旧图源无关
    mode: command,
  });

  if (report.failed) {
    process.exitCode = 1;
    return;
  }
  if (command === 'verify') {
    console.log(`[migrate] 核验完成：${report.toJSON().result}`);
  }
}

try {
  await main();
} catch (err) {
  console.error('[错误] 迁移失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  // postgres.js 会一直开着 socket，不显式关就一直挂着（曾经把验证脚本挂住 26 分钟）
  await closeDb();
}
