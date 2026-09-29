/**
 * 正文渲染、署名片段、@ 提及 —— 全是纯函数，没有数据库也没有网络。
 *
 * 实现搬自 `umeabc/380nm` 的 `render.js` / `templates.js` / `mentions.js`
 * （自有仓库）。单独放一层是为了能在本机直接跑断言：这几个函数里的每一条规则
 * 都对应过一个真实的线上问题（见下面各处注释）。
 */

/** 内容类型。决定用哪几个署名槽位。 */
export const PUBLISH_KINDS = ['翻嵌', '翻译', '转载', '原创'] as const;
export type PublishKind = (typeof PUBLISH_KINDS)[number];

export const KIND_SLOTS: Readonly<Record<PublishKind, readonly string[]>> = {
  翻嵌: ['trans', 'typo', 'orig'],
  翻译: ['trans', 'orig'],
  转载: ['orig'],
  原创: [],
};

export const SLOT_LABELS: Readonly<Record<string, string>> = {
  trans: '翻译',
  typo: '嵌字',
  orig: '原作者',
};

export type SlotValue = { name?: string; handle?: string; uid?: string };
export type Slots = Record<string, SlotValue | undefined>;

/**
 * 把正文里的 `{{变量}}` 换掉。
 *
 * 正则要**含中文**：模板变量名经常直接写成 `{{原作者}}`。少了这一段，
 * 中文变量名不会被识别，用户会看到 `{{原作者}}` 原样发出去。
 */
export function renderTemplate(content: string, variables: Record<string, unknown> = {}): string {
  return String(content).replace(/\{\{\s*([\w$\-一-龥]+)\s*\}\}/g, (_m, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** 模板里声明了哪些变量，按首次出现顺序。界面据此渲染表单。 */
export function extractVariableKeys(content: string): string[] {
  const keys: string[] = [];
  String(content).replace(/\{\{\s*([\w$\-一-龥]+)\s*\}\}/g, (m, key: string) => {
    if (!keys.includes(key)) keys.push(key);
    return m;
  });
  return keys;
}

/**
 * 拼署名片段。
 *
 * 格式沿用旧的（组内已经看惯了）：`【翻&嵌 @a @b 原作X@c】`。
 * **槽位不全时返回空串**，而不是发一个残缺的署名 —— 少一个人的署名比没有署名
 * 更容易引起误会（看起来像漏了谁）。
 */
export function slotSegment(kind: string, slots: Slots = {}): string {
  const pick = (key: string): string | null => {
    const value = slots[key];
    return value?.handle ? `@${value.handle}` : null;
  };

  if (kind === '翻嵌') {
    const a = pick('trans');
    const b = pick('typo');
    const c = pick('orig');
    if (a && b && c) return `【翻&嵌 ${a} ${b} 原作X${c}】`;
  } else if (kind === '翻译') {
    const a = pick('trans');
    const c = pick('orig');
    if (a && c) return `【翻&译 ${a} 原作X${c}】`;
  } else if (kind === '转载') {
    const c = pick('orig');
    if (c) return `【原作X${c}】`;
  }
  return '';
}

/** 正文里 @某人 的写法。**必须含日文假名** —— 见 `mergeLibraryMentions` 的说明。 */
export const MENTION_TOKEN_RE = /@([A-Za-z0-9_぀-ヿ一-龥-]{1,30})/g;

/**
 * 正文里出现的 `@handle` 若命中账号库，补登记为提及。
 *
 * **为什么必须有这一步**：`{{translator}}` 这类模板变量与署名槽位会把
 * `@handle` 直接拼进正文，但它们**不会进 mentions 数组**。而 B 站那边
 * 只有 `type=2` 且带 `biz_id` 的节点才是可点击的 @ —— 不在数组里的 `@名字`
 * 就只是一段普通文字。所以「模板里配了 @」和「@ 能点」是两件事。
 *
 * 判据用**账号库**而不是全文扫描：作者署名里的 X handle（如 `@mirin78`）
 * 不在账号库里，因此不会被误判成 B 站用户、更不会去 @ 一个不存在的人。
 */
export function mergeLibraryMentions(
  text: string,
  directory: ReadonlyArray<{ handle?: string; platformUid?: string }>,
  existing: ReadonlyArray<{ name: string; uid: string }> = [],
): Array<{ name: string; uid: string }> {
  const list = existing.map((m) => ({ name: String(m.name), uid: String(m.uid) }));

  const known = directory
    .filter((a) => a.handle && a.platformUid)
    .map((a) => ({ handle: String(a.handle), uid: String(a.platformUid) }));
  if (known.length === 0) return list;

  // 每次调用都要重置 lastIndex —— 带 g 的正则在多次调用之间会记住位置，
  // 复用同一个正则对象会让第二次调用从中间开始匹配。用局部副本最省心。
  const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text ?? ''))) !== null) {
    const token = match[1] ?? '';
    const hit = known.find((h) => h.handle.toLowerCase() === token.toLowerCase());
    if (!hit) continue;
    if (list.some((x) => x.uid === hit.uid)) continue;
    // name 用**正文里的原样写法**：发布时要按 `@name` 去正文里定位它，
    // 用账号库里的写法会在大小写不一致时定位不到。
    list.push({ name: token, uid: hit.uid });
  }
  return list;
}

/** 槽位里带了平台 uid 的，也要进提及（署名片段里的 @ 同样是正文的一部分）。 */
export function mentionsFromSlots(slots: Slots): Array<{ name: string; uid: string }> {
  const out: Array<{ name: string; uid: string }> = [];
  for (const value of Object.values(slots)) {
    if (value?.handle && value?.uid) out.push({ name: String(value.handle), uid: String(value.uid) });
  }
  return out;
}

/** 把提及按 uid 去重，保留先出现的那条。 */
export function dedupeMentions(
  list: ReadonlyArray<{ name: string; uid: string }>,
): Array<{ name: string; uid: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; uid: string }> = [];
  for (const item of list) {
    const uid = String(item.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({ name: String(item.name), uid });
  }
  return out;
}

/** 新建团队时塞进去的正文模板。`kind` 与之一一对应，方便运营直接开用。 */
export function defaultTemplates(): Array<{
  name: string;
  content: string;
  maxImages: number;
  variables: Array<{ key: string; label: string; type: string; placeholder: string }>;
}> {
  return [
    {
      name: '汉化更新',
      content: '【翻&嵌 {{translator}} {{typesetter}} 原作X{{origAuthor}}】\n\n{{title}}\n\n{{desc}}',
      maxImages: 9,
      variables: [
        { key: 'translator', label: '翻译', type: 'text', placeholder: '会自动用署名槽位填充' },
        { key: 'typesetter', label: '嵌字', type: 'text', placeholder: '会自动用署名槽位填充' },
        { key: 'origAuthor', label: '原作者', type: 'text', placeholder: '原作作者名或 @handle' },
        { key: 'title', label: '作品标题', type: 'text', placeholder: '例：本周新刊短篇' },
        { key: 'desc', label: '更新说明', type: 'textarea', placeholder: '一句话说明本期更新内容' },
      ],
    },
    {
      name: '日常',
      content: '{{content}}',
      maxImages: 9,
      variables: [{ key: 'content', label: '正文内容', type: 'textarea', placeholder: '想说的话…' }],
    },
  ];
}
