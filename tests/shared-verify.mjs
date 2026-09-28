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
  checkText,
  groupVerticalRuns,
  hitTest,
  layoutText,
  normalizeTextLayers,
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
  const big = { id: 'big', kind: 'box', x: 0.1, y: 0.1, w: 0.8, h: 0.8, vertices: null, groupId: null, orderIndex: 0, content: '', note: '', style: {} };
  const small = { id: 'small', kind: 'box', x: 0.4, y: 0.4, w: 0.1, h: 0.1, vertices: null, groupId: null, orderIndex: 1, content: '', note: '', style: {} };
  const hit = hitTest([big, small], 0.45, 0.45);
  record('大框套小框时命中小框（用户想选的是小的那个）', hit?.id === 'small', String(hit?.id));
  record('点在只有大框的地方命中外层框', hitTest([big, small], 0.15, 0.15)?.id === 'big');
  record('点在空白处返回 null', hitTest([big, small], 0.95, 0.95) === null);

  const pin = { id: 'pin', kind: 'pin', x: 0.5, y: 0.5, w: 0, h: 0, vertices: null, groupId: null, orderIndex: 2, content: '', note: '', style: { fontSizeRatio: 0.05 } };
  record('打点标记在中心附近可命中', hitTest([pin], 0.5, 0.5)?.id === 'pin');
  record('打点标记在远处不命中', hitTest([pin], 0.6, 0.6) === null);
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

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  process.exit(1);
}
console.log('shared 算法全部通过。');
