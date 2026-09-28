/**
 * 语言目录。
 *
 * 只做「登记 + 校验」两件事，不做翻译能力判断 —— 这一层不该关心
 * 有没有对应的模型或译员。语言码沿用 BCP-47 的常用子集（zh-CN / zh-TW 而非 zh-Hans），
 * 因为下游要对接的 B 站、以及站点文案里出现的都是这套写法。
 *
 * 与 moeflow 的差异：它的目标语言是自由字符串，导致同一个语种出现过
 * `zh-CN` / `zh_CN` / `zh-Hans` 三种写法，统计与筛选全部失真。
 * 这里改成受控词表 + 落库前归一化。
 */

export type LanguageDef = {
  code: string;
  label: string;
  /** 该语言在界面上的自称，署名行与成品包命名用得上 */
  nativeLabel: string;
};

export const LANGUAGES: readonly LanguageDef[] = [
  { code: 'zh-CN', label: '简体中文', nativeLabel: '简体中文' },
  { code: 'zh-TW', label: '繁体中文', nativeLabel: '繁體中文' },
  { code: 'ja', label: '日语', nativeLabel: '日本語' },
  { code: 'en', label: '英语', nativeLabel: 'English' },
  { code: 'ko', label: '韩语', nativeLabel: '한국어' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/** 常见别名 → 规范码。迁移时旧数据里的各种写法靠它归一。 */
const ALIASES: Readonly<Record<string, string>> = {
  zh: 'zh-CN',
  zh_cn: 'zh-CN',
  'zh-hans': 'zh-CN',
  cn: 'zh-CN',
  'zh-tw': 'zh-TW',
  'zh_hk': 'zh-TW',
  'zh-hant': 'zh-TW',
  tw: 'zh-TW',
  jp: 'ja',
  jpn: 'ja',
  'ja-jp': 'ja',
  eng: 'en',
  'en-us': 'en',
  kr: 'ko',
  kor: 'ko',
  'ko-kr': 'ko',
};

/** 归一化：大小写、`_`/`-` 混用、常见别名一律收敛到规范码。识别不了就原样返回。 */
export function normalizeLanguage(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();

  const direct = BY_CODE.get(lower);
  if (direct) return direct.code;

  const alias = ALIASES[lower] ?? ALIASES[lower.replace(/-/g, '_')];
  if (alias) return alias;

  return raw;
}

export function languageLabel(code: string): string {
  return BY_CODE.get(code.toLowerCase())?.label ?? code;
}

export function isKnownLanguage(code: string): boolean {
  return BY_CODE.has(code.toLowerCase());
}
