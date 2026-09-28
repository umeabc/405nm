import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { siteSettings } from '../db/schema.js';

/**
 * 站点设置。
 *
 * 存储形态是一张朴素的 key/value 表（`site_settings`），不建列 ——
 * 站点文案会随运营需要不断增减，每加一句就写一次迁移不划算。
 * 代价是**必须有一份键白名单**：没有它，`PUT /admin/settings` 就成了
 * 「往任意键写任意值」的口子。
 *
 * 与图译空间的一处**刻意分歧**：它的 `PUT /api/settings` 只要登录就能改全站配置
 * （那是扁平权限模型下的取舍）。405nm 是真实分权的系统，站点设置仅站点管理员可写。
 */
export const SITE_SETTING_KEYS = [
  'site.name',
  'site.slogan',
  'site.englishName',
  'site.description',
  'site.footer',
] as const;

export type SiteSettingKey = (typeof SITE_SETTING_KEYS)[number];

/** 立绘的存储键。 */
export const MASCOT_SETTING_KEY = 'site.mascotKey';

/**
 * **不参与通用写入白名单**的设置项：只能经立绘专用接口改。
 *
 * 立绘的值是服务端生成的对象名，不是让人手填的配置。放进通用白名单，
 * 一次误填就能让它指向任意存储键 —— 表现是站点立绘变成了别人的作品图，
 * 而这是纯粹靠猜才会发生的事故，所以从接口形状上就堵掉。
 */
export const READONLY_SETTING_KEYS = [MASCOT_SETTING_KEY] as const;

/** 管理员界面能看到的全部键。 */
export const ALL_SETTING_KEYS = [...SITE_SETTING_KEYS, ...READONLY_SETTING_KEYS] as const;

/** 批量读设置，**缺失的键补 null**（前端不必区分「没取到」和「值为空」）。 */
export async function readSettings(
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  const map: Record<string, unknown> = {};
  for (const key of keys) map[key] = null;
  if (keys.length === 0) return map;

  const rows = await db
    .select()
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...keys]));
  for (const row of rows) map[row.key] = row.value;
  return map;
}

/** 批量写设置（upsert）。 */
export async function writeSettings(
  entries: ReadonlyArray<readonly [string, unknown]>,
  updatedBy: string | null,
): Promise<void> {
  for (const [key, value] of entries) {
    await db
      .insert(siteSettings)
      .values({ key, value: value as never, updatedBy })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: value as never, updatedBy, updatedAt: new Date() },
      });
  }
}

export async function readSetting(key: string): Promise<unknown> {
  const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, key) });
  return row?.value ?? null;
}

/**
 * 站点品牌：**已解析**的公开视图（缺省值在这里补齐）。
 *
 * 与原始的 `GET /site/settings` 分开是有意的 —— 那个是「键值表原样导出」，
 * 给后台用；这个是给登录页这类公开页面用的。缺省值只在这里定义一份：
 * 前端各页各写一份默认站点名，改站名时必然漏掉一处。
 */
export type SiteBranding = {
  name: string;
  englishName: string;
  slogan: string;
  description: string;
  footer: string;
  /** 是否配了立绘。前端据此决定渲染立绘还是兜底字标。 */
  hasMascot: boolean;
  /**
   * 立绘地址，没配则为 null。
   *
   * 带 `?v=` 版本号：立绘换了之后路径不变，不带版本号浏览器会一直用缓存里的旧图，
   * 表现是「后台上传成功了但页面上没变」。版本号取自存储键，
   * 于是同一个键必然得到同一个 URL —— 对 CDN 与浏览器缓存都安全。
   */
  mascotUrl: string | null;
};

const BRANDING_DEFAULTS = {
  name: '405nm',
  englishName: '',
  slogan: '把喜欢的故事，分享给更多人',
  description: '',
  footer: '',
} as const;

function asText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

export async function readBranding(): Promise<SiteBranding> {
  const settings = await readSettings(ALL_SETTING_KEYS);
  const key = typeof settings[MASCOT_SETTING_KEY] === 'string' ? (settings[MASCOT_SETTING_KEY] as string) : '';

  return {
    name: asText(settings['site.name'], BRANDING_DEFAULTS.name),
    englishName: asText(settings['site.englishName'], BRANDING_DEFAULTS.englishName),
    slogan: asText(settings['site.slogan'], BRANDING_DEFAULTS.slogan),
    description: asText(settings['site.description'], BRANDING_DEFAULTS.description),
    footer: asText(settings['site.footer'], BRANDING_DEFAULTS.footer),
    hasMascot: key !== '',
    mascotUrl: key === '' ? null : `${MASCOT_PATH}?v=${mascotVersion(key)}`,
  };
}

/** 立绘的公开地址。前端不要自己拼这个路径。 */
export const MASCOT_PATH = '/api/site/branding/mascot';

/** 由存储键推出一个短版本号，供缓存失效用。 */
function mascotVersion(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
