/**
 * 扩展名 → MIME 类型。
 *
 * 单独成文件而不是散在路由里：作品图片、站点立绘两条字节流路由都要用它，
 * 各写一份必然漂移（新增一种允许的格式时漏改一处，症状是浏览器把 PNG 当成
 * octet-stream 下载下来）。
 *
 * **查询前一律先 `toLowerCase()`**，且查不到时返回 octet-stream 而不是抛错 ——
 * 类型头的价值是让浏览器正确渲染，不是做校验；真正的格式校验在 lib/image.ts。
 * 另配 `X-Content-Type-Options: nosniff`，浏览器不会去猜错类型执行。
 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** 从存储键或文件名里取扩展名（含点）。取不到返回空串。 */
export function extOf(nameOrKey: string, fallback = ''): string {
  const dot = nameOrKey.lastIndexOf('.');
  if (dot < 0) return fallback;
  return nameOrKey.slice(dot).toLowerCase();
}
