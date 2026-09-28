/**
 * 给导入的图片起名。
 *
 * 用**序号**而不是上游的文件名：上游给的名字五花八门（有的带 hash、有的没扩展名、
 * 有的几张图重名），而排序键是从名字推出来的 —— 名字乱了，导入进来的页序就是乱的，
 * 而这种乱序要等到有人翻到第 3 页才会发现。
 *
 * 左补零到 3 位，与 `@405nm/shared` 的自然排序配合：`001` 到 `999` 之间
 * 字典序就是数值序，文件名在文件管理器里也是对的。
 */
export function importFileName(index: number, extension: string): string {
  const safeExt = extension.startsWith('.') ? extension : `.${extension}`;
  return `${String(index + 1).padStart(3, '0')}${safeExt}`;
}
