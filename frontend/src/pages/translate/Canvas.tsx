import { useCallback, useEffect, useRef, useState } from 'react';
import {
  annotationRect,
  clamp01,
  hitTest,
  layoutText,
  type Annotation,
  type Measure,
  type Rect,
} from '@405nm/shared';
import type { SourceWithTranslations } from '../../api/client';
import { comiku, comikuDark } from '../../theme';

/**
 * 翻校画布。
 *
 * 三件必须做对的事：
 *
 * 1. **坐标全程归一化**。图片摆放、标号位置、命中判定都在 0–1 空间里算，
 *    只在绘制那一刻乘以图片像素尺寸与缩放。于是「40% 缩放下拖的框」与
 *    「150% 缩放下拖的框」存进去是同一件事，换屏幕、换导出分辨率都不会错位。
 * 2. **文字排版走共享模块**（`@405nm/shared` 的 layoutText）。画布上看到的断行
 *    就是将来导出得到的断行 —— 两边各写一套必然漂移，而漂移要等到用户
 *    已经在 PS 里排完版才会被发现。
 * 3. **绘制由 rAF 驱动，不依赖 React 状态**。一次拖动会产生上百个 mousemove，
 *    每个都走 setState 会让整个工作台（含右侧几十个输入框）重渲染，
 *    在漫画页这种大图上直接卡住。所以：数据放进 ref，`draw()` 从 ref 读，
 *    拖动期间每帧直接重绘；松手才把结果提交给 React。
 *
 * 拖拽中的几何**只存在于 ref**，右侧面板的输入框要等松手才更新 —— 这是有意的：
 * 边拖边同步输入框等于每次 mousemove 都重渲染整个面板，正是要避免的事。
 */

const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

export type CanvasTool = 'select' | 'box' | 'pin';
export type CanvasTextMode = 'translation' | 'proofread' | 'source';

export type CanvasProps = {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  sources: SourceWithTranslations[];
  textMode: CanvasTextMode;
  selectedId: string | null;
  tool: CanvasTool;
  onSelect: (id: string | null) => void;
  /** 画完一个新框（归一化坐标） */
  onCreate: (rect: Rect, kind: 'box' | 'pin') => void;
  /** 拖动或缩放结束后提交一次新几何 */
  onGeometryChange: (id: string, rect: Rect) => void;
  /** 是否显示「怎么开始」的空态提示 */
  showHint: boolean;
};

type Viewport = { scale: number; offsetX: number; offsetY: number };

type DragState =
  | { kind: 'draw'; startX: number; startY: number }
  | { kind: 'move'; id: string; startNX: number; startNY: number; originX: number; originY: number }
  | { kind: 'resize'; id: string; startNX: number; startNY: number; originW: number; originH: number };

/** 拖动中的临时覆盖：id → 新几何。只活在 ref 里，不进 React 状态。 */
type Overrides = Map<string, Rect>;

export function Canvas({
  imageUrl,
  imageWidth,
  imageHeight,
  sources,
  textMode,
  selectedId,
  tool,
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
  const [previewRect, setPreviewRect] = useState<Rect | null>(null);

  // 绘制所要读的一切都镜像到 ref —— draw() 必须是稳定引用且不依赖 React 状态，
  // 否则 rAF 回调会捕获到过期的闭包。
  const sourcesRef = useRef(sources);
  const viewportRef = useRef<Viewport>({ scale: 1, offsetX: 0, offsetY: 0 });
  const selectedRef = useRef<string | null>(selectedId);
  const dragRef = useRef<DragState | null>(null);
  const overridesRef = useRef<Overrides>(new Map());
  const previewRef = useRef<Rect | null>(null);
  const rafRef = useRef<number | null>(null);

  const dark =
    typeof document !== 'undefined' &&
    document.documentElement.dataset.theme === 'dark';

  sourcesRef.current = sources;
  selectedRef.current = selectedId;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, imageWidth, imageHeight]);

  // ── 坐标换算 ──────────────────────────────────────────────
  const toScreen = (nx: number, ny: number) => {
    const vp = viewportRef.current;
    return { x: vp.offsetX + nx * imageWidth * vp.scale, y: vp.offsetY + ny * imageHeight * vp.scale };
  };

  const toNormalized = (sx: number, sy: number) => {
    const vp = viewportRef.current;
    return {
      x: clamp01((sx - vp.offsetX) / (imageWidth * vp.scale)),
      y: clamp01((sy - vp.offsetY) / (imageHeight * vp.scale)),
    };
  };

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
    ctx.fillStyle = dark ? '#1C1917' : '#2A2422';
    ctx.fillRect(0, 0, w, h);

    const image = imageRef.current;
    if (image) {
      ctx.drawImage(image, vp.offsetX, vp.offsetY, imageWidth * vp.scale, imageHeight * vp.scale);
    }

    for (const source of sourcesRef.current) {
      const override = overridesRef.current.get(source.id);
      const base = annotationRect(asAnnotation(source));
      const rect: Rect = override ?? base;

      const topLeft = toScreen(rect.x, rect.y);
      const boxW = rect.w * imageWidth * vp.scale;
      const boxH = rect.h * imageHeight * vp.scale;
      const selected = source.id === selectedRef.current;

      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.strokeStyle = selected ? comiku.primary : dark ? '#F0E9E47A' : '#FFFFFFAA';
      ctx.setLineDash(source.kind === 'pin' ? [4, 3] : []);
      ctx.strokeRect(topLeft.x, topLeft.y, boxW, boxH);
      ctx.setLineDash([]);

      if (source.kind === 'pin') {
        const center = toScreen(rect.x, rect.y);
        ctx.beginPath();
        ctx.arc(center.x, center.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = selected ? comiku.primary : '#FFFFFFCC';
        ctx.fill();
      }

      const text = displayTextOf(source, textMode);
      if (text) {
        // 度量回调闭包在这次绘制内不变，直接按当前样式设字体即可。
        const measure: Measure = (value, fontSizePx) => {
          ctx.font = fontOf(fontSizePx, source);
          return ctx.measureText(value).width;
        };

        const layout = layoutText({
          text,
          imageWidth: imageWidth * vp.scale,
          imageHeight: imageHeight * vp.scale,
          rect,
          style: source.style,
          measure,
        });

        ctx.font = fontOf(layout.fontSizePx, source);
        ctx.textBaseline = 'middle';
        ctx.textAlign =
          layout.style.align === 'left' ? 'left' : layout.style.align === 'right' ? 'right' : 'center';

        const lineHeight = layout.fontSizePx * layout.style.lineHeight;
        const blockHeight = layout.lines.length * lineHeight;
        const startY = topLeft.y + (boxH - blockHeight) / 2 + lineHeight / 2;
        const textX =
          layout.style.align === 'left'
            ? topLeft.x + 3
            : layout.style.align === 'right'
              ? topLeft.x + boxW - 3
              : topLeft.x + boxW / 2;

        // 描边色与文字色**反着来**：深色字用浅描边、浅色字用深描边。
        // 漫画页底色深浅不定，固定用深描边的话，深色页面上的黑字会彻底看不见
        // （这一条是在浏览器里盯着一张近黑色的页才发现的）。
        ctx.lineWidth = Math.max(2, layout.fontSizePx * 0.16);
        ctx.strokeStyle = isDarkColor(layout.style.color) ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.6)';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;

        layout.lines.forEach((line, index) => {
          const y = startY + index * lineHeight;
          // 先描边再填字。漫画页底色深浅不定，纯填色在某些页面上完全看不清。
          ctx.strokeText(line, textX, y);
          ctx.fillStyle = layout.style.color || '#FFFFFF';
          ctx.fillText(line, textX, y);
        });

        // 塞不下时在右上角点一个红点，而不是把字继续缩到看不见 ——
        // 一个 4px 的译文等同于丢字，让译者知道比悄悄糊过去有用。
        if (layout.overflow) {
          ctx.beginPath();
          ctx.arc(topLeft.x + boxW - 6, topLeft.y + 6, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = comiku.danger;
          ctx.fill();
        }
      }

      // 序号标签，与右侧列表一一对应
      const label = String(index1Based(sourcesRef.current, source.id));
      ctx.font = `11px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = selected ? comiku.primary : 'rgba(0,0,0,0.65)';
      const labelW = 15;
      ctx.fillRect(topLeft.x - labelW - 2, topLeft.y, labelW, 15);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(label, topLeft.x - labelW + 2, topLeft.y + 8);

      // 选中框的缩放手柄
      if (selected && source.kind === 'box') {
        const handle = { x: topLeft.x + boxW, y: topLeft.y + boxH };
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = comiku.primary;
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    const preview = previewRef.current;
    if (preview) {
      const topLeft = toScreen(preview.x, preview.y);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = comiku.primary;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        topLeft.x,
        topLeft.y,
        preview.w * imageWidth * vp.scale,
        preview.h * imageHeight * vp.scale,
      );
      ctx.setLineDash([]);
    }
  }, [dark, imageWidth, imageHeight, textMode]);

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
  }, [size.w, size.h, draw, sources, selectedId, imageReady, previewRect]);

  // ── 交互 ──────────────────────────────────────────────────
  const pointerPos = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handleMouseDown = (event: React.MouseEvent) => {
    if (!imageReady) return;
    const { x, y } = pointerPos(event);
    const point = toNormalized(x, y);

    if (tool === 'box' || tool === 'pin') {
      dragRef.current = { kind: 'draw', startX: point.x, startY: point.y };
      onSelect(null);
      return;
    }

    // 缩放手柄优先于命中判定：手柄画在框的外侧，命中判定覆盖不到它。
    const selected = sourcesRef.current.find((s) => s.id === selectedRef.current);
    if (selected && selected.kind === 'box') {
      const rect = annotationRect(asAnnotation(selected));
      const handle = toScreen(rect.x + rect.w, rect.y + rect.h);
      if (Math.hypot(handle.x - x, handle.y - y) < 12) {
        dragRef.current = {
          kind: 'resize',
          id: selected.id,
          startNX: point.x,
          startNY: point.y,
          originW: rect.w,
          originH: rect.h,
        };
        return;
      }
    }

    const hit = hitTest(sourcesRef.current.map(asAnnotation), point.x, point.y);
    onSelect(hit?.id ?? null);

    if (hit) {
      dragRef.current = {
        kind: 'move',
        id: hit.id,
        startNX: point.x,
        startNY: point.y,
        originX: hit.x,
        originY: hit.y,
      };
    }
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;

    const { x, y } = pointerPos(event);
    const point = toNormalized(x, y);

    if (drag.kind === 'draw') {
      const rect = {
        x: Math.min(drag.startX, point.x),
        y: Math.min(drag.startY, point.y),
        w: Math.abs(point.x - drag.startX),
        h: Math.abs(point.y - drag.startY),
      };
      previewRef.current = rect;
      setPreviewRect(rect);
      scheduleDraw();
      return;
    }

    const source = sourcesRef.current.find((s) => s.id === drag.id);
    if (!source) return;
    const base = annotationRect(asAnnotation(source));

    if (drag.kind === 'move') {
      overridesRef.current.set(drag.id, {
        x: clamp01(drag.originX + (point.x - drag.startNX)),
        y: clamp01(drag.originY + (point.y - drag.startNY)),
        w: base.w,
        h: base.h,
      });
    } else {
      overridesRef.current.set(drag.id, {
        x: base.x,
        y: base.y,
        w: Math.max(0.01, clamp01(drag.originW + (point.x - drag.startNX))),
        h: Math.max(0.01, clamp01(drag.originH + (point.y - drag.startNY))),
      });
    }

    scheduleDraw();
  };

  const handleMouseUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;

    if (drag?.kind === 'draw') {
      const rect = previewRef.current;
      previewRef.current = null;
      setPreviewRect(null);

      if (tool === 'pin') {
        // 「点」工具：一次点击就是一个点，不管中间有没有移动过。
        onCreate({ x: drag.startX, y: drag.startY, w: 0, h: 0 }, 'pin');
        scheduleDraw();
        return;
      }

      // 「框」工具：拖出矩形就是那个矩形；**只点了一下没拖动**时给一个默认大小的框。
      //
      // ⚠️ 这里曾是本文件最隐蔽的一个 bug：早先写成「没有 preview 就直接 return」，
      // 于是「点一下」什么都不发生 —— 因为 mousedown 与 mouseup 之间通常
      // **不会有 mousemove**，preview 一直是空的。真实鼠标下这个 bug 表现为
      // 「点工具时灵时不灵」（手抖一下才会出点），几乎无法复现。
      // 教训：交互的「无事发生」分支一定要显式写出来，不能靠早退兜。
      const isClick = !rect || (rect.w < 0.015 && rect.h < 0.015);
      if (isClick) {
        const w = 0.16;
        const h = 0.09;
        onCreate(
          {
            x: clamp01(drag.startX - w / 2),
            y: clamp01(drag.startY - h / 2),
            w,
            h,
          },
          'box',
        );
      } else if (rect.w > 0.01 && rect.h > 0.01) {
        onCreate(rect, 'box');
      }

      scheduleDraw();
      return;
    }

    // 提交拖动结果：此刻才写 React 状态（一次 setState，而不是一百次）。
    const pending = [...overridesRef.current.entries()];
    overridesRef.current.clear();
    for (const [id, rect] of pending) onGeometryChange(id, rect);
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

  return (
    <div
      ref={containerRef}
      className="nm-canvas-wrap"
      style={{ borderColor: dark ? comikuDark.border : comiku.border }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: tool === 'select' ? 'default' : 'crosshair' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />

      <div className="nm-canvas-zoom">
        <button type="button" onClick={() => zoomBy(1 / 1.2)}>
          −
        </button>
        <button
          type="button"
          onClick={() => {
            viewportRef.current = fitViewport();
            scheduleDraw();
          }}
        >
          适宽
        </button>
        <button type="button" onClick={() => zoomBy(1.2)}>
          +
        </button>
      </div>

      {showHint && sources.length === 0 ? (
        <div className="nm-canvas-hint">选「框」或「点」工具，在图上拖出文本框</div>
      ) : null}
    </div>
  );
}

/** 把 SourceWithTranslations 适配成共享模块要的 Annotation 形状。 */
function asAnnotation(source: SourceWithTranslations): Annotation {
  return {
    id: source.id,
    kind: source.kind,
    x: source.x,
    y: source.y,
    w: source.w,
    h: source.h,
    vertices: source.vertices,
    groupId: source.groupId,
    orderIndex: source.orderIndex,
    content: source.content,
    note: source.note,
    style: source.style,
  };
}

function displayTextOf(source: SourceWithTranslations, mode: CanvasTextMode): string {
  if (mode === 'source') return source.content;
  const selected = source.selected;
  if (!selected) return '';
  return mode === 'proofread' ? selected.proofreadContent || selected.content : selected.content;
}

/**
 * 这个颜色算不算「深色」。
 *
 * 用感知亮度（人眼对绿最敏感、对蓝最不敏感）而不是简单的平均值 ——
 * 纯蓝 (0,0,255) 的平均值是 85（看着像深色），但感知亮度只有 29，
 * 在纸上确实很暗，用深色描边就没法看。
 * 认不出来的写法一律当作浅色（描边用深色），这样最坏情况是黑色描边黑字 ——
 * 而反过来（浅描边浅字）会完全看不见。
 */
function isDarkColor(color: string): boolean {
  const hex = color.trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return false;
  const value = parseInt(match[1]!, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

function fontOf(fontSizePx: number, source: SourceWithTranslations): string {
  const bold = source.style?.bold ? 'bold ' : '';
  const italic = source.style?.italic ? 'italic ' : '';
  return `${italic}${bold}${fontSizePx}px ${FONT_FAMILY}`;
}

/** 列表里的序号（从 1 开始），与画布左侧的小标签一致。 */
function index1Based(sources: readonly SourceWithTranslations[], id: string): number {
  const index = sources.findIndex((s) => s.id === id);
  return index < 0 ? 0 : index + 1;
}

export { FONT_FAMILY };
