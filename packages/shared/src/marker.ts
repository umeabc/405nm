/**
 * 打点标记的几何 —— 就是标号在画布上的那个「数字圆点 + 三角箭头」。
 *
 * 单独成模块、并由**绘制与命中判定共用**，是为了堵死一类很难查的 bug：
 * 画的地方和判定的地方各写一套尺寸，改了一处忘了另一处，
 * 表现是「明明点在圆点上却没选中」或者「点空白却选中了旁边的标号」。
 * 这类问题在标号密集的页面上会被当成「手感差」，很难定位到具体是几像素。
 *
 * 尺寸一律是**屏幕像素**，不随缩放变化 —— 放大到 400% 时标记还是这么大。
 * 跟着放大它会盖住整格画面，跟着缩小又点不中。代价是判定必须在屏幕空间做，
 * 不能在归一化空间里比矩形（这也是原来的矩形命中判定不能用在这儿的原因）。
 *
 * 形态对齐彩翻（moeflow-irohamod）：那边是 29px 的数字圆 + 8×5 的三角箭头，
 * 挂在标号坐标上、整体向上偏移，箭尖指向真实坐标。这里的比例取自它，
 * 数值按 canvas 的绘制习惯做了取整。
 */

/** 圆点半径（屏幕像素）。 */
export const MARKER_RADIUS = 12;

/** 箭头高度：从标号坐标（箭尖）到箭头底边。 */
export const MARKER_ARROW_HEIGHT = 9;

/** 箭头底边宽度。 */
export const MARKER_ARROW_WIDTH = 10;

/** 圆点中心相对标号坐标的纵向偏移（负值 = 在坐标上方）。 */
export const MARKER_CENTER_DY = -(MARKER_ARROW_HEIGHT + MARKER_RADIUS);

/** 数字字号（屏幕像素）。圆点直径 24，字号 12 留出足够的内边距。 */
export const MARKER_FONT_SIZE = 12;

/** 圆点里的数字用什么字体。序号要窄、要等宽，不然 11 和 40 的宽度差会看出来。 */
export const MARKER_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** 一个标记在屏幕上的位置：箭尖所指的那一点。 */
export type MarkerAnchor = {
  screenX: number;
  screenY: number;
};

/**
 * 命中判定：点 (px, py) 落在了哪个标记上，没命中返回 null。
 *
 * 命中区 = 圆点 ∪ 箭头，**不留额外容差**。容差看起来更「友好」，
 * 但标号密集时相邻标记的容差会互相吃掉对方的地盘，
 * 反而让「想选的那个」更难选中 —— 这是典型的帮倒忙。
 */
export function hitTestMarker<T extends MarkerAnchor>(
  markers: readonly T[],
  px: number,
  py: number,
): T | null {
  // 逆序遍历：数组靠后的画在上面，点击应当优先选中看得见的那一个。
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    const marker = markers[i]!;
    const dx = px - marker.screenX;
    const dy = py - marker.screenY;

    // 圆点
    if (Math.hypot(dx, dy - MARKER_CENTER_DY) <= MARKER_RADIUS) return marker;

    // 箭头：以标号坐标为顶尖、朝下的等腰三角形，半宽随高度线性变化。
    if (dy <= 0 && dy >= -MARKER_ARROW_HEIGHT) {
      const halfWidth = (MARKER_ARROW_WIDTH / 2) * (-dy / MARKER_ARROW_HEIGHT);
      if (Math.abs(dx) <= halfWidth) return marker;
    }
  }

  return null;
}
