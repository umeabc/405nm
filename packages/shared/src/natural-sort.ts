/**
 * 自然排序。
 *
 * 漫画面页的文件名几乎一定是 `1.jpg`、`2.jpg`、…`10.jpg` 这种形态，
 * 用字典序排会得到 `1, 10, 11, 2, …` —— 页码全乱，而「页码顺序」
 * 正是翻校时唯一不能错的东西。所以：
 *
 *  - `naturalSortKey()` 生成一个**可直接用于数据库 ORDER BY 的文本键**：
 *    把数字段左补零到定宽，于是普通文本比较就等于自然比较。
 *    用键排序而不是取出全量再在内存里排，是为了让分页稳定 ——
 *    内存排序 + 分页会在翻页时出现重复或漏项。
 *  - `naturalCompare()` 是同一套规则的内存版本，供前端本地排序（如拖拽预览）。
 *
 * 两份实现必须给出**一致的顺序**，所以共用同一个补零宽度常量。
 */

/** 数字段补零宽度。12 位足够容纳任何现实的页码/章节号，且不会把键撑得过长。 */
const DIGIT_WIDTH = 12;

/**
 * 生成排序键：`p2.jpg` → `p000000000002.jpg`。
 *
 * 同时把大写统一成小写（`Cover.JPG` 与 `cover.jpg` 相邻，而不是被 ASCII 码点分开），
 * 但**不改动用于显示的原始文件名** —— 排序键只活在数据库里。
 */
export function naturalSortKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\d+/g, (digits) => digits.padStart(DIGIT_WIDTH, '0'));
}

/** 内存版比较器。返回负数/0/正数，可直接喂给 `Array.prototype.sort`。 */
export function naturalCompare(a: string, b: string): number {
  const keyA = naturalSortKey(a);
  const keyB = naturalSortKey(b);
  if (keyA < keyB) return -1;
  if (keyA > keyB) return 1;
  // 键相同（例如 `1.jpg` 与 `01.jpg`）时退回原名比较，保证顺序**稳定且可预期**，
  // 否则同一个作品两次打开可能显示成不同的顺序。
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 就地排序的语法糖，避免调用方每次手写 `(a, b) => naturalCompare(a.name, b.name)`。 */
export function sortByNatural<T>(items: readonly T[], pick: (item: T) => string): T[] {
  return [...items].sort((a, b) => naturalCompare(pick(a), pick(b)));
}
