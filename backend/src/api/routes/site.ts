import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  MASCOT_SETTING_KEY,
  SITE_SETTING_KEYS,
  readBranding,
  readSetting,
  readSettings,
} from '../../domain/site-settings.js';
import { notFound } from '../../lib/errors.js';
import { extOf, mimeForExt } from '../../lib/mime.js';
import { storage } from '../../storage/index.js';

/**
 * 站点公开信息：品牌与立绘。
 *
 * 这些接口**刻意不做鉴权** —— 登录页本身就在未登录状态下渲染，它要显示站名、
 * 标语和立绘。做成「需要登录才能读」，等于要求先登录才能看到登录页长什么样。
 * 公开出去的只有运营层面的文案与一张装饰图，没有任何业务数据。
 */
export async function registerSiteRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 键值表的**原样导出**（缺的键补 null），给后台与其他页面读原始配置。
   *
   * 与下面 `/site/branding` 的分工：这个是「原样」，那个是**已解析**的视图 ——
   * 缺省值补齐、立绘地址拼好、直接可渲染。两个都留着是因为后者不该知道
   * 「站点名存在哪个键里」，而前者不该替调用方决定缺省值。
   */
  app.get('/site/settings', async () => ({ settings: await readSettings(SITE_SETTING_KEYS) }));

  app.get('/site/branding', async () => ({ branding: await readBranding() }));

  app.get('/site/branding/mascot', async (request, reply) => {
    const key = await readSetting(MASCOT_SETTING_KEY);
    if (typeof key !== 'string' || key === '') {
      throw notFound('站点未配置立绘', 'MASCOT_MISSING');
    }

    const object = await storage.openRead(key);
    if (!object) {
      // 配置指向了不存在的对象（手工清理磁盘、换存储驱动都可能造成）。
      // 如实报 404 让前端回落到字标，而不是假装成功。
      throw notFound('立绘文件不存在或已被清理', 'MASCOT_MISSING');
    }

    // 存储键每次上传都是新的 uuid，所以键本身就是内容版本。
    // 前端拿到的 URL 带 `?v=<由键推出的短哈希>`，键一变 URL 就变 ——
    // 于是这里可以放心用 immutable，不会出现「换了图网页上还是旧的」。
    const etag = `"mascot-${createHash('sha1').update(key).digest('hex').slice(0, 24)}"`;
    if (request.headers['if-none-match'] === etag) {
      reply.code(304);
      return reply.send();
    }

    reply
      .header('Content-Type', mimeForExt(extOf(key, '.png')))
      .header('Content-Length', String(object.size))
      // 与作品图片不同，立绘是公开资源，可以用 public + CDN 缓存。
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('ETag', etag)
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(object.stream);
  });
}
