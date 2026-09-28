import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MARKER_ARROW_HEIGHT,
  MARKER_ARROW_WIDTH,
  MARKER_CENTER_DY,
  MARKER_FONT_FAMILY,
  MARKER_FONT_SIZE,
  MARKER_RADIUS,
  clamp01,
  hitTestMarker,
  type PositionType,
} from '@405nm/shared';
import type { SourceWithTranslations } from '../../api/client';
import { palette, paletteDark } from '../../theme';

/**
 * 翻校画布。
 *
 * 形态对齐彩翻（moeflow-irohamod）的工作台：**画面上只有标记，没有矩形**。
 * 一个标号就是「数字圆点 + 三角箭头」，箭尖落在它真实所在的坐标上。
 * 译文不再画在图上（那是"框"时代的做法），改由悬停/选中时的浮层显示 ——
 * 一页三十个矩形叠在画面上，本身就把要看的东西挡住了。
 *
 * 三件必须做对的事：
 *
 * 1. **坐标全程归一化**。图片摆放、标号位置都在 0–1 空间里算，
 *    只在绘制那一刻乘以图片像素尺寸与缩放。于是「40% 缩放下点的标号」与
 *    「150% 缩放下点的标号」存进去是同一件事，换屏幕、换导出分辨率都不会错位。
 *    ⚠️ **但命中判定必须在屏幕空间做** —— 标记是固定屏幕尺寸的，见下面第 3 条。
 * 2. **绘制由 rAF 驱动，不依赖 React 状态**。一次拖动会产生上百个 mousemove，
 *    每个都走 setState 会让整个工作台（含右侧几十个输入框）重渲染，
 *    在漫画页这种大图上直接卡住。所以：数据放进 ref，`draw()` 从 ref 读，
 *    拖动期间每帧直接重绘；松手才把结果提交给 React。
 * 3. **标记是固定屏幕尺寸的**（不随缩放变大变小），所以它的命中判定只能在
 *    屏幕坐标里做。圆点与箭头的尺寸来自 `@405nm/shared` 的 `marker.ts`，
 *    与绘制用的是同一份常量 —— 两边各写一套的话，症状是「看着点在圆点上却没选中」，
 *    在界面上只会被当成手感差，极难定位。
 *
 * 鼠标键位（与彩翻一致）：
 *   - **左键点空白 = 新建框内标号**，**右键点空白 = 新建框外标号**
 *   - 左键点已有标记 = 选中它；按住拖动 = 移动
 *   - **右键点已有标记不删**（彩翻是右键删除，但那边没确认、也没撤销）——
 *     删除走右侧列表上的按钮，那里有明确的确认。
 *     删一个标号会连带删掉它下面的全部译文，一次误点不该有这种后果。
 *   - Esc 取消选中（在翻校页里处理）
 */

/** 标记配色。框内粉、框外金 —— 与彩翻的 `Label` 一致。 */
const MARKER_COLORS: Record<PositionType, { fill: string; stroke: string; text: string }> = {
  in: { fill: 'rgb(255, 150, 156)', stroke: 'rgba(186, 58, 78, 0.55)', text: '#4a2028' },
  out: { fill: 'rgb(255, 213, 131)', stroke: 'rgba(168, 118, 18, 0.55)', text: '#4a3410' },
};

/**
 * 只用填充色的那份，给画布外面的图例用（翻校页把键位说明摆在画布上方）。
 * 导出的是同一份常量而不是另抄一组色值 —— 图例和画布对不上会让人以为
 * 自己色觉出了问题，而那种 bug 没人会去查代码。
 */
export const MARKER_FILL: Record<PositionType, string> = {
  in: MARKER_COLORS.in.fill,
  out: MARKER_COLORS.out.fill,
};

/** 画在标记上的文字用什么色（浅底配深字）。右侧列表的框内/框外标签也用这个。 */
export const MARKER_TEXT: Record<PositionType, string> = {
  in: MARKER_COLORS.in.text,
  out: MARKER_COLORS.out.text,
};

/** 按下与松开之间移动超过这么多**屏幕像素**，就不算「点一下」。 */
const CLICK_SLOP_PX = 6;

export type CanvasTextMode = 'translation' | 'proofread' | 'source';

export type CanvasProps = {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  sources: SourceWithTranslations[];
  textMode: CanvasTextMode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 在归一化坐标处新建一个标号。框内还是框外由按下的鼠标键决定。 */
  onCreate: (point: { x: number; y: number }, positionType: PositionType) => void;
  /** 拖动结束后提交一次新坐标 */
  onGeometryChange: (id: string, point: { x: number; y: number }) => void;
  /** 是否显示「怎么开始」的空态提示 */
  showHint: boolean;
};

type Viewport = { scale: number; offsetX: number; offsetY: number };

type DragState = { id: string; startNX: number; startNY: number; originX: number; originY: number };

/** 拖动中的临时坐标：id → 新位置。只活在 ref 里，不进 React 状态。 */
type Overrides = Map<string, { x: number; y: number }>;

/** 按下鼠标但还没松手 —— 松手时若没怎么移动就创建一个标号。 */
type PendingCreate = {
  type: PositionType;
  normX: number;
  normY: number;
  screenX: number;
  screenY: number;
};

export function Canvas({
  imageUrl,
  imageWidth,
  imageHeight,
  sources,
  textMode,
  selectedId,
  onSelect,
  onCreate,
  onGeometryChange,
  showHint,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [size, setSize] = useState({ w: 800, h: 600 });
  const [imageReady, setImageReady] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /**
   * 视口值只存在 ref 里（见文件头第 2 条），但浮层是 DOM、要用 React 渲染，
   * 所以缩放/适宽之后得主动叫一次重渲染。这个计数就是那个「叫一声」。
   * 它只在用户显式缩放时变，不是每帧 —— 拖动过程仍然零 React 渲染。
   */
  const [, bumpViewport] = useState(0);

  // 绘制所要读的一切都镜像到 ref —— draw() 必须是稳定引用且不依赖 React 状态，
  // 否则 rAF 回调会捕获到过期的闭包。
  const sourcesRef = useRef(sources);
  const viewportRef = useRef<Viewport>({ scale: 1, offsetX: 0, offsetY: 0 });
  const selectedRef = useRef<string | null>(selectedId);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const overridesRef = useRef<Overrides>(new Map());
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const rafRef = useRef<number | null>(null);

  const dark =
    typeof document !== 'undefined' &&
    document.documentElement.dataset.theme === 'dark';

  sourcesRef.current = sources;
  selectedRef.current = selectedId;
  hoveredRef.current = hoveredId;

  // ── 容器尺寸 ──────────────────────────────────────────────
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    });
    observer.observe(element);
    setSize({ w: element.clientWidth, h: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  // ── 图片加载 ──────────────────────────────────────────────
  useEffect(() => {
    if (!imageUrl) {
      imageRef.current = null;
      setImageReady(false);
      return;
    }
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (!alive) return;
      imageRef.current = image;
      setImageReady(true);
    };
    image.onerror = () => {
      if (!alive) return;
      imageRef.current = null;
      setImageReady(false);
    };
    image.src = imageUrl;
    return () => {
      alive = false;
    };
  }, [imageUrl]);

  // ── 视口 ──────────────────────────────────────────────────
  const fitViewport = useCallback(
    (): Viewport => {
      if (!imageWidth || !imageHeight || size.w <= 0 || size.h <= 0) {
        return { scale: 1, offsetX: 0, offsetY: 0 };
      }
      const scale = Math.min(size.w / imageWidth, size.h / imageHeight);
      return {
        scale,
        offsetX: (size.w - imageWidth * scale) / 2,
        offsetY: (size.h - imageHeight * scale) / 2,
      };
    },
    [imageWidth, imageHeight, size.w, size.h],
  );

  // 容器尺寸变化时重新适宽。刻意**不保留**用户的缩放级别：
  // 保留缩放要么需要一个「相对基准」的概念，要么会在窗口变小后
  // 把图留在视野外 —— 而「适宽」是绝大多数情况下想要的那一个。
  useEffect(() => {
    viewportRef.current = fitViewport();
    bumpViewport((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, imageWidth, imageHeight]);

  // ── 坐标换算 ──────────────────────────────────────────────
  const toScreen = useCallback(
    (nx: number, ny: number) => {
      const vp = viewportRef.current;
      return {
        x: vp.offsetX + nx * imageWidth * vp.scale,
        y: vp.offsetY + ny * imageHeight * vp.scale,
      };
    },
    [imageWidth, imageHeight],
  );

  const toNormalized = (sx: number, sy: number) => {
    const vp = viewportRef.current;
    return {
      x: clamp01((sx - vp.offsetX) / (imageWidth * vp.scale)),
      y: clamp01((sy - vp.offsetY) / (imageHeight * vp.scale)),
    };
  };

  /** 当前生效的标号坐标（拖动中读临时值）。 */
  const coordOf = (source: SourceWithTranslations): { x: number; y: number } =>
    overridesRef.current.get(source.id) ?? { x: source.x, y: source.y };

  // ── 绘制 ──────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const vp = viewportRef.current;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = dark ? '#121212' : '#2A2422';
    ctx.fillRect(0, 0, w, h);

    const image = imageRef.current;
    if (image) {
      ctx.drawImage(image, vp.offsetX, vp.offsetY, imageWidth * vp.scale, imageHeight * vp.scale);
    }

    // 逆序绘制不可行（序号要与右侧列表一致），所以命中判定反过来取数组末尾 ——
    // 见 hitTestMarker 的注释。
    sourcesRef.current.forEach((source, index) => {
      const { x: nx, y: ny } = coordOf(source);
      const anchor = toScreen(nx, ny);
      const selected = source.id === selectedRef.current;
      const hovered = source.id === hoveredRef.current;
      const colors = MARKER_COLORS[source.positionType] ?? MARKER_COLORS.in;
      const centerY = anchor.y + MARKER_CENTER_DY;

      // 选中时先画一个外环，让它在密集的页面上也能一眼找到
      if (selected) {
        ctx.beginPath();
        ctx.arc(anchor.x, centerY, MARKER_RADIUS + 5, 0, Math.PI * 2);
        ctx.strokeStyle = palette.primary;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 箭头：等腰三角形，箭尖就是标号坐标
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(anchor.x - MARKER_ARROW_WIDTH / 2, anchor.y - MARKER_ARROW_HEIGHT);
      ctx.lineTo(anchor.x + MARKER_ARROW_WIDTH / 2, anchor.y - MARKER_ARROW_HEIGHT);
      ctx.closePath();
      ctx.fillStyle = colors.fill;
      ctx.fill();
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = 1;
      ctx.stroke();

      // 圆点
      ctx.beginPath();
      ctx.arc(anchor.x, centerY, MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = colors.fill;
      ctx.fill();
      ctx.strokeStyle = hovered && !selected ? palette.primary : colors.stroke;
      ctx.lineWidth = hovered && !selected ? 3 : 1.5;
      ctx.stroke();

      // 序号
      ctx.font = `600 ${MARKER_FONT_SIZE}px ${MARKER_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.text;
      ctx.fillText(String(index + 1), anchor.x, centerY + 1);
    });
  }, [dark, imageWidth, imageHeight, toScreen]);

  /** 请求下一帧重绘。多次调用只会排一帧。 */
  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      draw();
    });
  }, [draw]);

  // 画布尺寸与所有会改变画面的输入变化时重绘。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(size.w * dpr));
    canvas.height = Math.max(1, Math.round(size.h * dpr));
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    draw();
  }, [size.w, size.h, draw, sources, selectedId, hoveredId, imageReady]);

  // ── 交互 ──────────────────────────────────────────────────
  const pointerPos = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** 屏幕坐标下的命中判定。标记是固定屏幕尺寸的，所以不能用归一化坐标比。 */
  const hitAt = (screenX: number, screenY: number): SourceWithTranslations | null =>
    hitTestMarker(
      sourcesRef.current.map((source) => {
        const { x, y } = coordOf(source);
        const anchor = toScreen(x, y);
        return { source, screenX: anchor.x, screenY: anchor.y };
      }),
      screenX,
      screenY,
    )?.source ?? null;

  const handleMouseDown = (event: React.MouseEvent) => {
    if (!imageReady) return;
    // 只认左键与右键。中键（自动滚动）与浏览器手势键一律不处理。
    if (event.button !== 0 && event.button !== 2) return;

    const { x, y } = pointerPos(event);
    const point = toNormalized(x, y);
    const hit = hitAt(x, y);

    if (hit) {
      onSelect(hit.id);
      pendingCreateRef.current = null;
      // 只有左键能拖。右键点已有标记不做事 —— 见文件头。
      if (event.button === 0) {
        dragRef.current = {
          id: hit.id,
          startNX: point.x,
          startNY: point.y,
          originX: hit.x,
          originY: hit.y,
        };
      }
      return;
    }

    // 点在空白处：先记下来，松手时若几乎没动才真的创建。
    // 不在这里直接创建，是为了「按住左键划过画面」不会沿途撒下一串标号。
    onSelect(null);
    pendingCreateRef.current = {
      type: event.button === 2 ? 'out' : 'in',
      normX: point.x,
      normY: point.y,
      screenX: x,
      screenY: y,
    };
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    const { x, y } = pointerPos(event);
    const drag = dragRef.current;

    if (!drag) {
      // 没在拖动时只做一件事：更新悬停状态。**只在变化时** setState ——
      // 否则每次 mousemove 都重渲染整个工作台。
      const hovered = hitAt(x, y)?.id ?? null;
      if (hovered !== hoveredRef.current) setHoveredId(hovered);
      return;
    }

    const point = toNormalized(x, y);
    overridesRef.current.set(drag.id, {
      x: clamp01(drag.originX + (point.x - drag.startNX)),
      y: clamp01(drag.originY + (point.y - drag.startNY)),
    });
    scheduleDraw();
  };

  /** 提交拖动结果，并处理「点一下」的创建。两个 handler 共用。 */
  const settle = (screenX: number, screenY: number) => {
    const drag = dragRef.current;
    dragRef.current = null;

    const pending = [...overridesRef.current.entries()];
    overridesRef.current.clear();
    // 提交拖动结果：此刻才写 React 状态（一次 setState，而不是一百次）。
    for (const [id, point] of pending) onGeometryChange(id, point);

    const create = pendingCreateRef.current;
    pendingCreateRef.current = null;
    if (create) {
      const moved = Math.hypot(screenX - create.screenX, screenY - create.screenY);
      if (moved < CLICK_SLOP_PX) {
        onCreate({ x: create.normX, y: create.normY }, create.type);
      }
    }

    scheduleDraw();
  };

  const handleMouseUp = (event: React.MouseEvent) => {
    const { x, y } = pointerPos(event);
    settle(x, y);
  };

  /** 指针移出画布：拖动照常提交，但「点一下」作废 —— 松手发生在画布外面。 */
  const handleMouseLeave = () => {
    pendingCreateRef.current = null;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const pending = [...overridesRef.current.entries()];
    overridesRef.current.clear();
    for (const [id, point] of pending) onGeometryChange(id, point);
    scheduleDraw();
  };

  const zoomBy = (factor: number, centerX?: number, centerY?: number) => {
    const current = viewportRef.current;
    const nextScale = Math.max(0.05, Math.min(8, current.scale * factor));
    const cx = centerX ?? size.w / 2;
    const cy = centerY ?? size.h / 2;
    // 以给定位置为中心缩放：偏移量按同一比例变化，
    // 否则放大会把用户正在看的那一块推出视野。
    const ratio = nextScale / current.scale;
    viewportRef.current = {
      scale: nextScale,
      offsetX: cx - (cx - current.offsetX) * ratio,
      offsetY: cy - (cy - current.offsetY) * ratio,
    };
    scheduleDraw();
    // 浮层是 DOM，位置得靠 React 重算 —— 见 bumpViewport 的注释。
    bumpViewport((n) => n + 1);
  };

  const handleWheel = (event: React.WheelEvent) => {
    // 只有按住 Ctrl/⌘ 才缩放：普通滚轮留给页面滚动，
    // 否则用户在长页面里想往下翻会被画布吃掉滚动。
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const { x, y } = pointerPos(event);
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, x, y);
  };

  // 卸载时清掉挂起的 rAF，避免对已卸载的画布绘制
  useEffect(() => () => {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
  }, []);

  // ── 译文浮层 ──────────────────────────────────────────────
  // 悬停优先，其次选中 —— 两者都有时说明用户在指着另一个，应当给悬停的那个。
  const overlayId = hoveredId ?? selectedId;
  const overlay = overlayId ? sources.find((s) => s.id === overlayId) : undefined;
  const overlayText = overlay ? displayTextOf(overlay, textMode) || overlay.content : '';

  let overlayStyle: React.CSSProperties | null = null;
  if (overlay) {
    const { x: nx, y: ny } = overridesRef.current.get(overlay.id) ?? { x: overlay.x, y: overlay.y };
    const anchor = toScreen(nx, ny);
    const POP_WIDTH = 232;
    // 默认摆在标记右侧；右边放不下就翻到左边。
    // 不做上下翻转 —— 横向够用就够了，纵向翻转会让浮层跑到光标上面去，
    // 读起来要重新找一次位置。
    const preferRight = anchor.x + 18 + POP_WIDTH <= size.w;
    overlayStyle = {
      left: preferRight ? anchor.x + 18 : Math.max(4, anchor.x - 18 - POP_WIDTH),
      top: Math.max(4, anchor.y + MARKER_CENTER_DY - MARKER_RADIUS),
      width: POP_WIDTH,
    };
  }

  return (
    <div
      ref={containerRef}
      className="nm-canvas-wrap"
      style={{ borderColor: dark ? paletteDark.border : palette.border }}
      // 右键要用来创建「框外」标号，必须挡掉浏览器的右键菜单。
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: hoveredId ? 'pointer' : 'crosshair' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
      />

      {/* 浮层不吃鼠标事件：它盖在图上，若可交互就会挡住下面标号的点选。
          译文本来就在右侧面板里可编辑，这里只是「在图上就地看一眼」。 */}
      {overlay && overlayStyle ? (
        <div className="nm-marker-pop" style={overlayStyle}>
          <div className="nm-marker-pop-head">
            <span
              className="nm-marker-pop-dot"
              style={{ background: MARKER_COLORS[overlay.positionType]?.fill ?? MARKER_COLORS.in.fill }}
            />
            {overlay.positionType === 'in' ? '框内' : '框外'}
          </div>
          <div className="nm-marker-pop-text">
            {overlayText || <span className="nm-marker-pop-empty">（还没有译文）</span>}
          </div>
        </div>
      ) : null}

      <div className="nm-canvas-zoom">
        <button type="button" onClick={() => zoomBy(1 / 1.2)}>
          −
        </button>
        <button
          type="button"
          onClick={() => {
            viewportRef.current = fitViewport();
            scheduleDraw();
            bumpViewport((n) => n + 1);
          }}
        >
          适宽
        </button>
        <button type="button" onClick={() => zoomBy(1.2)}>
          +
        </button>
      </div>

      {showHint && sources.length === 0 ? (
        <div className="nm-canvas-hint">左键点画面 = 框内标号，右键点 = 框外标号</div>
      ) : null}
    </div>
  );
}

function displayTextOf(source: SourceWithTranslations, mode: CanvasTextMode): string {
  if (mode === 'source') return source.content;
  const selected = source.selected;
  if (!selected) return '';
  return mode === 'proofread' ? selected.proofreadContent || selected.content : selected.content;
}
