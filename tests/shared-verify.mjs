#!/usr/bin/env node
/**
 * `@405nm/shared` 的算法验证 —— 断行、禁则、竖排、标点检查、命中判定。
 *
 *   npm run test:shared        # 会自动先构建 shared 包
 *
 * 这一层没有数据库也没有 HTTP，所以能在本机直接跑，不必上测试机 ——
 * 而它恰恰是最该有测试的一层：断行与禁则的规则很细，改一个字符的边界条件
 * 就可能让整部作品的换行全变，而这种错误在界面上「看起来只是有点怪」，
 * 只有断言能拦住。
 *
 * 断行算法最重要的是**不丢字**。所有断行用例都额外断言这条不变量。
 */

import {
  LABELPLUS_GROUPS,
  MARKER_ARROW_HEIGHT,
  MARKER_CENTER_DY,
  MARKER_RADIUS,
  annotationRect,
  checkText,
  dedupeLpFilenames,
  groupIdOfPosition,
  groupVerticalRuns,
  hitTestMarker,
  labelPlusDownloadName,
  layoutText,
  normalizeTextLayers,
  parseLabelPlus,
  positionTypeOfGroup,
  sanitizeLpFilename,
  serializeLabelPlus,
  wrapText,
  wrapVertical,
} from '../packages/shared/dist/index.js';

let passed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  record(name, a === b, `实际 ${a}，期望 ${b}`);
}

/**
 * 确定性度量：全角字符宽 1em，其余 0.5em。
 * 用它而不是真实字体度量，是因为断言要能写出确定的期望值；
 * 换行算法本身与度量无关，真实度量由画布/导出提供。
 */
const measure = (text, size) =>
  [...text].reduce((sum, ch) => sum + (/[　-鿿＀-￠]/.test(ch) ? 1 : 0.5) * size, 0);

/** 断行不丢字：把所有行的非空白字符连起来，应当等于原文的非空白字符。 */
const squeeze = (s) => s.replace(/[\s　]+/g, '');
function assertNoLoss(name, text, lines) {
  record(`${name}（不丢字）`, squeeze(lines.join('')) === squeeze(text), `得到 ${JSON.stringify(lines.join(''))}`);
}

console.log('\n405nm shared 算法验证\n');

// ── 一、断行 ────────────────────────────────────────────────
console.log('一、断行');

{
  const text = 'あいうえおかきくけこ';
  const lines = wrapText(text, 5 * 10, 10, measure);
  eq('全角 10 字按 5 字一行断开', lines, ['あいうえお', 'かきくけこ']);
  assertNoLoss('全角断行', text, lines);
}

{
  // 「 不能落在行尾 → 推到下一行
  const text = 'ああああ「い';
  const lines = wrapText(text, 5 * 10, 10, measure);
  eq('开引号不留在行尾', lines, ['ああああ', '「い']);
  assertNoLoss('开引号', text, lines);
}

{
  // 。 不能落在行首 → 吸进上一行（追い込み）
  const text = 'ああああい。';
  const lines = wrapText(text, 5 * 10, 10, measure);
  eq('句号吸进上一行而不是孤零零起头', lines, ['ああああい。']);
  assertNoLoss('句号追い込み', text, lines);
}

{
  const text = 'hello world';
  const lines = wrapText(text, 5 * 10, 10, measure);
  eq('拉丁文按词断开', lines, ['hello', 'world']);
  assertNoLoss('拉丁断行', text, lines);
}

{
  // 窄到放不下任何词：也不能把词从中间劈开
  const text = 'hello world';
  const lines = wrapText(text, 2 * 10, 10, measure);
  eq('放不下时整词独占一行（不在词内断开）', lines, ['hello', 'world']);
  assertNoLoss('整词独占', text, lines);
}

{
  const text = '第一行\n第二行';
  // 段落换行由调用方按 \n 拆分；wrapText 收到含 \n 的文本时按空格处理，
  // 所以这里只断言不丢字。
  const lines = wrapText(text, 10 * 10, 10, measure);
  assertNoLoss('含换行符不丢字', text, lines);
}

{
  record('空文本返回空数组', wrapText('', 100, 10, measure).length === 0);
}

{
  // 长文本在各种宽度下都不丢字 —— 找边界条件下的丢字问题
  const text = '这是一段比较长的中文测试文本，用来检查断行算法在宽度变化时是否稳定，包含标点。';
  let allOk = true;
  for (let width = 20; width <= 400; width += 7) {
    const lines = wrapText(text, width, 16, measure);
    if (squeeze(lines.join('')) !== squeeze(text)) {
      allOk = false;
      console.log(`      宽度 ${width} 丢字：${JSON.stringify(lines)}`);
      break;
    }
  }
  record('宽度从 20 到 400 逐步变化均不丢字', allOk);
}

// ── 二、字号收缩 ────────────────────────────────────────────
console.log('\n二、字号收缩');

{
  const rect = { x: 0, y: 0, w: 0.2, h: 0.2 }; // 40x40 px on 200x200
  const layout = layoutText({
    text: '一二三四五六七八九十一二三四五六七八九十',
    imageWidth: 200,
    imageHeight: 200,
    rect,
    style: { fontSizeRatio: 0.2 },
    measure,
  });
  record(
    '放不下时自动缩小字号',
    layout.fontSizePx < 0.2 * 200 && !layout.overflow,
    `字号 ${layout.fontSizePx.toFixed(1)}px 溢出=${layout.overflow}`,
  );
  record('缩字号后确实排进了框里', layout.usedHeightPx <= 40 + 0.5, `占用高 ${layout.usedHeightPx.toFixed(1)}px`);
}

{
  const rect = { x: 0, y: 0, w: 0.02, h: 0.02 }; // 4x4 px —— 无论如何塞不下
  const layout = layoutText({
    text: '再多字也塞不进四个像素',
    imageWidth: 200,
    imageHeight: 200,
    rect,
    style: { fontSizeRatio: 0.2 },
    measure,
  });
  record(
    '塞不下时如实标记 overflow 而不是无限缩',
    layout.overflow === true && layout.fontSizePx >= 6,
    `字号 ${layout.fontSizePx.toFixed(1)}px 溢出=${layout.overflow}`,
  );
}

// ── 三、竖排 ────────────────────────────────────────────────
console.log('\n三、竖排与纵中横');

{
  const runs = groupVerticalRuns('あab12い');
  eq(
    '短拉丁串合并成纵中横一格，汉字逐字竖排',
    runs,
    [
      { text: 'あ', kind: 'upright' },
      { text: 'ab12', kind: 'tateChuYoko' },
      { text: 'い', kind: 'upright' },
    ],
  );
}

{
  const runs = groupVerticalRuns('abcd12345');
  record(
    '超过 4 字符的拉丁串逐字竖排',
    runs.length === 9 && runs.every((r) => r.kind === 'upright'),
    JSON.stringify(runs),
  );
}

{
  const columns = wrapVertical('あいうえおかきくけこ', 5 * 12, 10);
  record('竖排按列高断列', columns.length === 2, JSON.stringify(columns.map((c) => c.map((r) => r.text).join(''))));
  record(
    '竖排不丢字',
    columns.flat().map((r) => r.text).join('') === 'あいうえおかきくけこ',
    JSON.stringify(columns),
  );
}

{
  // 列首不能是收尾标点：标点要被拉到前一列末尾
  const columns = wrapVertical('あいうえ。おかきくけ', 5 * 12, 10);
  const firstOfSecond = columns[1]?.[0]?.text ?? '';
  record(
    '收尾标点不出现在列首',
    firstOfSecond !== '。' && firstOfSecond !== '、',
    `第二列首字是「${firstOfSecond}」`,
  );
}

// ── 四、样式规范化 ──────────────────────────────────────────
console.log('\n四、样式规范化');

{
  const [layer] = normalizeTextLayers([
    { text: 'x', fontSizeRatio: 'abc', lineHeight: 99, letterSpacing: -5, vertical: 'yes' },
  ]);
  record(
    '非法数值被替换成默认值、超界被夹紧',
    layer.fontSizeRatio === 0.035 && layer.lineHeight === 4 && layer.letterSpacing === -0.5 && layer.vertical === false,
    JSON.stringify(layer),
  );
}

// ── 五、命中判定 ────────────────────────────────────────────
console.log('\n五、命中判定');

{
  // 标记是**固定屏幕尺寸**的，所以判定发生在屏幕坐标里。
  // 这一组断言的真正价值在于：它把「画出来的形状」与「判定的形状」
  // 钉在同一份常量上 —— 两边不一致时，症状是「看着点在圆点上却没选中」，
  // 在界面上只会被当成手感差，很难定位到是几像素的事。
  const marker = { id: 'a', screenX: 300, screenY: 500 };
  const other = { id: 'b', screenX: 500, screenY: 500 };
  const markers = [marker, other];

  record('点在圆点中心命中', hitTestMarker(markers, 300, 500 + MARKER_CENTER_DY)?.id === 'a');
  record(
    '点在圆点边缘仍命中',
    hitTestMarker(markers, 300 + MARKER_RADIUS - 1, 500 + MARKER_CENTER_DY)?.id === 'a',
  );
  record(
    '圆点再往外一点就不命中',
    hitTestMarker([marker], 300 + MARKER_RADIUS + 1, 500 + MARKER_CENTER_DY) === null,
  );

  // 箭尖正落在标号坐标上，且只覆盖那一段三角形
  record('箭尖所在处（标号坐标）命中', hitTestMarker([marker], 300, 500)?.id === 'a');
  record('箭头底边处宽度最大', hitTestMarker([marker], 300 + 4, 500 - MARKER_ARROW_HEIGHT + 1)?.id === 'a');
  record(
    '箭头之外（坐标下方）不命中 —— 否则点画面下方会误选到上方的标号',
    hitTestMarker([marker], 300, 501) === null,
  );

  // 重叠时选数组中靠后的那个：它画在上面，用户点的是看得见的那一个
  const overlap = [
    { id: 'under', screenX: 300, screenY: 500 },
    { id: 'over', screenX: 300, screenY: 500 },
  ];
  record('重叠时选中画在上层的标记', hitTestMarker(overlap, 300, 500)?.id === 'over');

  record('点在空白处返回 null', hitTestMarker(markers, 120, 120) === null);
}

// ── 五之二、标号的默认框 ────────────────────────────────────
{
  // 标号是点，w/h 一律为 0；`annotationRect` 在这个前提下要给一个
  // 「以点为中心、边长等于一个字号」的正方形，供 M5 导出按框排版。
  const point = {
    id: 'p',
    positionType: 'in',
    x: 0.5,
    y: 0.5,
    w: 0,
    h: 0,
    vertices: null,
    groupId: null,
    orderIndex: 0,
    content: '',
    note: '',
    style: { fontSizeRatio: 0.04 },
  };

  const rect = annotationRect(point);
  record(
    '打点的默认框以点为中心、边长等于一个字号',
    Math.abs(rect.x + rect.w / 2 - 0.5) < 1e-9 && Math.abs(rect.w - 0.04) < 1e-9 && rect.w === rect.h,
    JSON.stringify(rect),
  );

  const legacy = { ...point, x: 0.4, y: 0.3, w: -0.2, h: 0.1 };
  const legacyRect = annotationRect(legacy);
  record(
    '负宽高的旧数据被统一成正的矩形',
    Math.abs(legacyRect.x - 0.2) < 1e-9 && Math.abs(legacyRect.w - 0.2) < 1e-9 && legacyRect.h > 0,
    JSON.stringify(legacyRect),
  );
}

// ── 六、标点检查 ────────────────────────────────────────────
console.log('\n六、标点检查');

{
  const codes = (text) => checkText(text).map((i) => i.code);

  record('中文旁的半角逗号被指出', codes('你好,世界').includes('HALF_WIDTH_PUNCT'));
  record('数字里的逗号不误报', !codes('共 1,000 元').includes('HALF_WIDTH_PUNCT'));
  record('英文句点不误报', !codes('see v1.2 docs').includes('HALF_WIDTH_PUNCT'));
  record('三个点当省略号被指出', codes('等等...').includes('ELLIPSIS'));
  record('规范省略号不报错', !codes('等等……').includes('ELLIPSIS'));
  record('波浪号被指出', codes('好~').includes('TILDE'));
  record('括号不配对被指出且算错误', hasError(checkText('「你好')));
  record('括号配对时不报', !codes('「你好」').includes('UNBALANCED_PAIR'));
  record('首尾空白被指出', codes(' 你好 ').includes('TRIM_WHITESPACE'));
  record('干净的文本没有任何问题', checkText('这是一句干净的中文译文。').length === 0);
}

function hasError(issues) {
  return issues.some((i) => i.severity === 'error');
}

// ── 七、LabelPlus txt ──────────────────────────────────────
//
// 这一节的重点不是「自己写的解析器能读自己写的输出」（那只证明自洽），
// 而是**照官方 PS 脚本的算法重实现一遍解析器**，用它来读我们的输出。
// 格式漂移正是这样才会被发现：官方 `judgeLineType` 用前缀匹配
// （`>>>>>>` / `------`），`readStartBlocks` 把起始块按 `-` 切开、
// 再把组名按 `\r` 切 —— 横线少一根、组名里混进一个 `-`，都会让
// **组号整体错位**，表现为「译文全串到别的组」，而这种错在界面上看不出来。
console.log('\n七、LabelPlus txt');

/** 官方 judgeLineType 的忠实移植（LabelPlus/PS-Script） */
function officialJudgeLineType(input) {
  const result = { Type: 'unknown', Title: '', Values: [''] };
  let str = input.trim();
  if (str.substr(0, 6) === '>>>>>>') {
    str = str.slice(2 + str.indexOf('>['));
    const index = str.search(/\]<{6,}$/);
    if (index < 0) return result;
    result.Title = str.substring(0, index);
    result.Type = 'filehead';
  } else if (str.substr(0, 6) === '------') {
    str = str.slice(2 + str.indexOf('-['));
    let index = str.search(/\]-{6,}\[/);
    if (index < 0) return result;
    result.Title = str.substring(0, index);
    str = str.slice(2 + str.indexOf('-['));
    index = str.search(/\]$/);
    if (index < 0) return result;
    str = str.substring(0, index);
    result.Values = str.split(',');
    result.Type = 'labelhead';
  }
  return result;
}

/** 官方 readStartBlocks 的忠实移植 */
function officialReadStartBlocks(str) {
  const blocks = str.split('-');
  if (blocks.length < 3) return null;
  const filehead = blocks[0].split(',');
  if (filehead.length < 2) return null;
  const groups = blocks[1].trim().split('\r').map((g) => g.trim());
  return { Groups: groups };
}

/** 官方 lpTextParser 的忠实移植 */
function officialParseLp(text) {
  const body = text.replace(/^\uFEFF/, '');
  const lines = body.split(/\r\n|\n|\r/);
  let state = 'start';
  let notDealStr = '';
  let pending = null;
  let nowFilename = null;
  const labelData = new Map();
  const filenameList = [];
  let groups = null;
  let lastType = 'unknown';

  const push = () => {
    if (nowFilename != null && pending) {
      labelData.get(nowFilename).push({
        Values: pending.Values,
        // 官方是 notDealStr.trim()，而 notDealStr 每行都以 \r 拼接
        Text: notDealStr.trim(),
      });
    }
  };

  for (const lineStr of lines) {
    const msg = officialJudgeLineType(lineStr);
    lastType = msg.Type;
    if (msg.Type === 'filehead') {
      if (state === 'start') {
        const r = officialReadStartBlocks(notDealStr);
        if (!r) return null;
        groups = r.Groups;
      } else if (state === 'context') {
        push();
      }
      labelData.set(msg.Title, []);
      filenameList.push(msg.Title);
      nowFilename = msg.Title;
      notDealStr = '';
      state = 'filehead';
    } else if (msg.Type === 'labelhead') {
      // 起始块都没结束就遇到标号头 —— 官方在这里直接放弃整个文件
      if (state === 'start') return null;
      if (state === 'context') push();
      notDealStr = '';
      pending = msg;
      state = 'context';
    } else {
      notDealStr += '\r' + lineStr;
    }
  }
  // ⚠️ 官方只在「最后一行是普通文本」时才收尾。也就是说文件若以标号头结尾，
  // 那个标号会被丢掉 —— 这正是我们序列化时**连空译文也要写一行**的原因。
  if (state === 'context' && lastType === 'unknown') push();

  if (!groups) return null;
  return {
    groups,
    files: filenameList.map((name) => ({
      filename: name,
      labels: labelData.get(name).map((d) => ({
        x: d.Values[0],
        y: d.Values[1],
        group: d.Values[2],
        text: d.Text,
      })),
    })),
  };
}

const sampleDoc = {
  comment: ['作品：测试作品', '语言：zh-CN'],
  files: [
    {
      filename: '001.jpg',
      markers: [
        { index: 1, x: 0.1, y: 0.2, positionType: 'in', text: '早上好' },
        { index: 2, x: 0.3, y: 0.4, positionType: 'out', text: '第一行\n第二行' },
      ],
    },
    {
      filename: '002.jpg',
      markers: [{ index: 1, x: 1, y: 1.5, positionType: 'in', text: '' }],
    },
  ],
};

{
  const txt = serializeLabelPlus(sampleDoc);

  record('输出以 BOM 开头', txt.charCodeAt(0) === 0xfeff, `首字符码 ${txt.charCodeAt(0)}`);
  record(
    '行尾全是 CRLF（没有裸 LF）',
    !/[^\r]\n/.test(txt) && txt.includes('\r\n'),
    JSON.stringify(txt.slice(0, 24)),
  );

  const official = officialParseLp(txt);
  record('官方解析器能读出来（不是 null）', official !== null);

  if (official) {
    record(
      '官方解析器读到的组名正好是 框内/框外',
      JSON.stringify(official.groups) === JSON.stringify(['框内', '框外']),
      JSON.stringify(official.groups),
    );
    record(
      '官方解析器认出两个文件且文件名正确',
      official.files.length === 2 &&
        official.files[0].filename === '001.jpg' &&
        official.files[1].filename === '002.jpg',
      JSON.stringify(official.files.map((f) => f.filename)),
    );
    record(
      '官方解析器读到的 x/y/组号正确',
      JSON.stringify(official.files[0].labels.map((l) => [l.x, l.y, l.group])) ===
        JSON.stringify([
          ['0.1000', '0.2000', '1'],
          ['0.3000', '0.4000', '2'],
        ]),
      JSON.stringify(official.files[0].labels.map((l) => [l.x, l.y, l.group])),
    );
    record(
      '官方解析器读到的译文正确（含多行）',
      official.files[0].labels[0].text === '早上好' &&
        official.files[0].labels[1].text === '第一行\r第二行',
      JSON.stringify(official.files[0].labels.map((l) => l.text)),
    );
    // 关键回归：官方收尾规则会吃掉「以标号头结尾」的标号
    record(
      '空译文的标号在官方解析器下仍然存在',
      official.files[1].labels.length === 1 && official.files[1].labels[0].text === '',
      JSON.stringify(official.files[1].labels),
    );
  }

  record('坐标是 4 位小数', txt.includes('[0.1000,0.2000,1]'), '');
  record('越界坐标被夹到 1（0–1 之外官方 PS 脚本会当像素值）', txt.includes('[1.0000,1.0000,1]'), '');

  // 自己的解析器往返
  const back = parseLabelPlus(txt);
  record('往返后组名一致', JSON.stringify(back.groups) === JSON.stringify(['框内', '框外']), JSON.stringify(back.groups));
  record('往返后文件数一致', back.files.length === 2, String(back.files.length));
  record(
    '往返后坐标一致',
    back.files[0].markers[0].x === 0.1 && back.files[0].markers[0].y === 0.2,
    JSON.stringify([back.files[0].markers[0].x, back.files[0].markers[0].y]),
  );
  record(
    '往返后框内/框外一致',
    back.files[0].markers[0].positionType === 'in' && back.files[0].markers[1].positionType === 'out',
    JSON.stringify(back.files[0].markers.map((m) => m.positionType)),
  );
  record(
    '往返后序号从 1 连续递增',
    JSON.stringify(back.files[0].markers.map((m) => m.index)) === JSON.stringify([1, 2]),
    JSON.stringify(back.files[0].markers.map((m) => m.index)),
  );
  record('往返后多行译文一致', back.files[0].markers[1].text === '第一行\n第二行', JSON.stringify(back.files[0].markers[1].text));
  record('往返后空译文还是空', back.files[1].markers[0].text === '', JSON.stringify(back.files[1].markers[0].text));
}

{
  // 文件名里的危险字符：`]` 与 `<` 会让官方正则截断标题，把标号挂到别的图上
  record('文件名里的 ] 被清掉', sanitizeLpFilename('a]b.jpg') === 'a_b.jpg', sanitizeLpFilename('a]b.jpg'));
  record('文件名里的 < 被清掉', sanitizeLpFilename('a<b.jpg') === 'a_b.jpg', sanitizeLpFilename('a<b.jpg'));
  record('空文件名回落成 image', sanitizeLpFilename('   ') === 'image', sanitizeLpFilename('   '));

  const deduped = dedupeLpFilenames(['001.jpg', '001.jpg', '001.jpg', 'noext']);
  record(
    '重名文件名被去重（重名会让后一张的标号覆盖前一张）',
    JSON.stringify(deduped) === JSON.stringify(['001.jpg', '001_2.jpg', '001_3.jpg', 'noext']),
    JSON.stringify(deduped),
  );

  const txt = serializeLabelPlus({ files: [{ filename: 'a]b.jpg', markers: [] }] });
  const parsed = officialParseLp(txt);
  record(
    '带危险字符的文件名导出后官方解析器仍读得对',
    parsed && parsed.files.length === 1 && parsed.files[0].filename === 'a_b.jpg',
    parsed ? JSON.stringify(parsed.files.map((f) => f.filename)) : 'null',
  );
}

{
  // 组名里绝不能有 `-`：readStartBlocks 会把起始块切碎，组号整体错位
  const txt = serializeLabelPlus({ files: [] });
  const head = txt.split('>>>>>>')[0];
  const groups = officialReadStartBlocks(head.replace(/^\uFEFF/, ''));
  record(
    '起始块能被官方 readStartBlocks 解析出 2 个非空组名',
    groups && groups.Groups.length === 2 && groups.Groups.every((g) => g.length > 0),
    groups ? JSON.stringify(groups.Groups) : 'null',
  );
  record('组名里不含 - （含 - 会让组号错位）', !LABELPLUS_GROUPS.some((g) => g.includes('-')), '');
}

{
  record('框内映射到组 1', groupIdOfPosition('in') === 1, String(groupIdOfPosition('in')));
  record('框外映射到组 2', groupIdOfPosition('out') === 2, String(groupIdOfPosition('out')));
  record('组 2 反向映射回框外', positionTypeOfGroup(2) === 'out', positionTypeOfGroup(2));
  record('组 3 及以后按框内处理（不丢组号）', positionTypeOfGroup(5) === 'in', positionTypeOfGroup(5));
  record(
    '下载文件名带上作品名与语言',
    labelPlusDownloadName('作品A', 'zh-CN') === '作品A_zh-CN.txt',
    labelPlusDownloadName('作品A', 'zh-CN'),
  );
  record(
    '下载文件名里的路径字符被清掉',
    labelPlusDownloadName('a/b:c', 'zh') === 'a_b_c_zh.txt',
    labelPlusDownloadName('a/b:c', 'zh'),
  );
}

{
  const parsed = parseLabelPlus('随便一段不是 LabelPlus 的文字\n没有任何文件头');
  record('解析非 LabelPlus 文本不抛错且返回空文件表', parsed.files.length === 0, JSON.stringify(parsed.files));
}

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  process.exit(1);
}
console.log('shared 算法全部通过。');
