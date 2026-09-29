import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DragOutlined,
  EnvironmentOutlined,
  MessageOutlined,
  MinusOutlined,
  PlusOutlined,
  SelectOutlined,
} from '@ant-design/icons';
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

/**
 * 翻校画布 —— Comiku 暗室工作区风格。
 *
 * 视觉规范对齐 https://comiku-preview.vercel.app：
 *  - 深暗蓝灰棋盘格背景工作区；
 *  - 顶部悬浮深色胶囊工具栏（指针 / 框内 / 框外 / 抓手 | 缩放）；
 *  - 图纸带微阴影呈现；
 *  - 标号：框内亮粉圆形（#ff6584），框外青绿圆角方块（#14b8a6），高亮外光晕（halo ring）；
 *  - 底部浮动提示与翻页快捷条。
 */

/** 标记配色：对齐 Comiku 原版（框内洋红粉白字、框外青绿白字）。 */
const MARKER_COLORS: Record<PositionType, { fill: string; stroke: string; text: string; halo: string }> = {
  in: { fill: '#ff6584', stroke: '#e64969', text: '#ffffff', halo: 'rgba(255, 101, 132, 0.45)' },
  out: { fill: '#14b8a6', stroke: '#0d9488', text: '#ffffff', halo: 'rgba(20, 184, 166, 0.45)' },
};

export const MARKER_FILL: Record<PositionType, string> = {
  in: MARKER_COLORS.in.fill,
  out: MARKER_COLORS.out.fill,
};

export const MARKER_TEXT: Record<PositionType, string> = {
  in: MARKER_COLORS.in.text,
  out: MARKER_COLORS.out.text,
};

const CLICK_SLOP_PX = 6;

export type CanvasTextMode = 'translation' | 'proofread' | 'source';

export type ToolMode = 'select' | 'in' | 'out' | 'pan';

export type CanvasProps = {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  sources: SourceWithTranslations[];
  textMode: CanvasTextMode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (point: { x: number; y: number }, positionType: PositionType) => void;
  onGeometryChange: (id: string, point: { x: number; y: number }) => void;
  showHint: boolean;
  pageIndex?: number;
  pageCount?: number;
  onPrevPage?: () => void;
  onNextPage?: () => void;
};

type Viewport = { scale: number; offsetX: number; offsetY: number };
type DragState = { id: string; startNX: number; startNY: number; originX: number; originY: number };
type PanState = { startX: number; startY: number; originOffsetX: number; originOffsetY: number };
type Overrides = Map<string, { x: number; y: number }>;
type PendingCreate = { type: PositionType; normX: number; normY: number; screenX: number; screenY: number };

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
  pageIndex,
  pageCount,
  onPrevPage,
  onNextPage,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [size, setSize] = useState({ w: 800, h: 600 });
  const [imageReady, setImageReady] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolMode>('select');
  const [, bumpViewport] = useState(0);

  const sourcesRef = useRef(sources);
  const viewportRef = useRef<Viewport>({ scale: 1, offsetX: 0, offsetY: 0 });
  const selectedRef = useRef<string | null>(selectedId);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const overridesRef = useRef<Overrides>(new Map());
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const activeToolRef = useRef<ToolMode>(activeTool);
  const rafRef = useRef<number | null>(null);

  sourcesRef.current = sources;
  selectedRef.current = selectedId;
  hoveredRef.current = hoveredId;
  activeToolRef.current = activeTool;

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

  const fitViewport = useCallback((): Viewport => {
    if (imageWidth <= 0 || imageHeight <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
    const pad = 36;
    const scale = Math.min((size.w - pad * 2) / imageWidth, (size.h - pad * 2) / imageHeight, 1);
    return {
      scale: Math.max(0.1, scale),
      offsetX: (size.w - imageWidth * scale) / 2,
      offsetY: (size.h - imageHeight * scale) / 2,
    };
  }, [imageWidth, imageHeight, size.w, size.h]);

  useEffect(() => {
    viewportRef.current = fitViewport();
    bumpViewport((n) => n + 1);
  }, [size.w, size.h, imageWidth, imageHeight, fitViewport]);

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

    // Comiku 暗室棋盘格背景
    ctx.fillStyle = '#1e202c';
    ctx.fillRect(0, 0, w, h);

    const checkSize = 16;
    ctx.fillStyle = '#252837';
    for (let x = 0; x < w; x += checkSize * 2) {
      for (let y = 0; y < h; y += checkSize * 2) {
        ctx.fillRect(x, y, checkSize, checkSize);
        ctx.fillRect(x + checkSize, y + checkSize, checkSize, checkSize);
      }
    }

    const image = imageRef.current;
    const drawW = imageWidth * vp.scale;
    const drawH = imageHeight * vp.scale;

    // 白纸图纸底与柔和投影
    if (image) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 28;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(vp.offsetX, vp.offsetY, drawW, drawH);
      ctx.restore();

      ctx.drawImage(image, vp.offsetX, vp.offsetY, drawW, drawH);
    }

    // 绘制标号
    sourcesRef.current.forEach((source, index) => {
      const { x: nx, y: ny } = coordOf(source);
      const anchor = toScreen(nx, ny);
      const selected = source.id === selectedRef.current;
      const hovered = source.id === hoveredRef.current;
      const colors = MARKER_COLORS[source.positionType] ?? MARKER_COLORS.in;
      const centerY = anchor.y + MARKER_CENTER_DY;

      // 选中时的大光晕（Halo Ring）
      if (selected) {
        ctx.beginPath();
        ctx.arc(anchor.x, centerY, MARKER_RADIUS + 7, 0, Math.PI * 2);
        ctx.strokeStyle = colors.halo;
        ctx.lineWidth = 4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(anchor.x, centerY, MARKER_RADIUS + 2, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 箭头：等腰三角形，箭尖落在真实坐标上
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

      // 标号本体：框内圆形，框外带圆角矩形质感
      ctx.beginPath();
      if (source.positionType === 'out') {
        const r = MARKER_RADIUS;
        const x = anchor.x - r;
        const y = centerY - r;
        const cr = 4;
        ctx.moveTo(x + cr, y);
        ctx.arcTo(x + r * 2, y, x + r * 2, y + r * 2, cr);
        ctx.arcTo(x + r * 2, y + r * 2, x, y + r * 2, cr);
        ctx.arcTo(x, y + r * 2, x, y, cr);
        ctx.arcTo(x, y, x + r * 2, y, cr);
      } else {
        ctx.arc(anchor.x, centerY, MARKER_RADIUS, 0, Math.PI * 2);
      }
      ctx.fillStyle = colors.fill;
      ctx.fill();
      ctx.strokeStyle = hovered && !selected ? '#ffffff' : colors.stroke;
      ctx.lineWidth = hovered && !selected ? 2.5 : 1.2;
      ctx.stroke();

      // 序号（白色加粗字）
      ctx.font = `700 ${MARKER_FONT_SIZE}px ${MARKER_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.text;
      ctx.fillText(String(index + 1), anchor.x, centerY + 1);
    });
  }, [imageWidth, imageHeight, toScreen]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      draw();
    });
  }, [draw]);

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

  // ── 交互处理 ──────────────────────────────────────────────
  const pointerPos = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

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
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;

    const { x, y } = pointerPos(event);
    const point = toNormalized(x, y);
    const hit = hitAt(x, y);
    const tool = activeToolRef.current;

    // 抓手工具：拖动画布
    if (tool === 'pan' || event.button === 1) {
      panRef.current = {
        startX: x,
        startY: y,
        originOffsetX: viewportRef.current.offsetX,
        originOffsetY: viewportRef.current.offsetY,
      };
      return;
    }

    if (hit) {
      onSelect(hit.id);
      pendingCreateRef.current = null;
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

    onSelect(null);
    let createType: PositionType = 'in';
    if (tool === 'in') createType = event.button === 2 ? 'out' : 'in';
    else if (tool === 'out') createType = event.button === 2 ? 'in' : 'out';
    else createType = event.button === 2 ? 'out' : 'in';

    pendingCreateRef.current = {
      type: createType,
      normX: point.x,
      normY: point.y,
      screenX: x,
      screenY: y,
    };
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    const { x, y } = pointerPos(event);

    if (panRef.current) {
      const pan = panRef.current;
      viewportRef.current.offsetX = pan.originOffsetX + (x - pan.startX);
      viewportRef.current.offsetY = pan.originOffsetY + (y - pan.startY);
      scheduleDraw();
      bumpViewport((n) => n + 1);
      return;
    }

    const drag = dragRef.current;
    if (!drag) {
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

  const settle = (screenX: number, screenY: number) => {
    panRef.current = null;
    dragRef.current = null;

    const pending = [...overridesRef.current.entries()];
    overridesRef.current.clear();
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

  const handleMouseLeave = () => {
    pendingCreateRef.current = null;
    panRef.current = null;
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
    const ratio = nextScale / current.scale;
    viewportRef.current = {
      scale: nextScale,
      offsetX: cx - (cx - current.offsetX) * ratio,
      offsetY: cy - (cy - current.offsetY) * ratio,
    };
    scheduleDraw();
    bumpViewport((n) => n + 1);
  };

  const handleWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const { x, y } = pointerPos(event);
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, x, y);
  };

  useEffect(() => () => {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
  }, []);

  // ── 译文浮层 ──────────────────────────────────────────────
  const overlayId = hoveredId ?? selectedId;
  const overlay = overlayId ? sources.find((s) => s.id === overlayId) : undefined;
  const overlayText = overlay ? displayTextOf(overlay, textMode) || overlay.content : '';

  let overlayStyle: React.CSSProperties | null = null;
  if (overlay) {
    const { x: nx, y: ny } = overridesRef.current.get(overlay.id) ?? { x: overlay.x, y: overlay.y };
    const anchor = toScreen(nx, ny);
    const POP_WIDTH = 232;
    const preferRight = anchor.x + 18 + POP_WIDTH <= size.w;
    overlayStyle = {
      left: preferRight ? anchor.x + 18 : Math.max(4, anchor.x - 18 - POP_WIDTH),
      top: Math.max(4, anchor.y + MARKER_CENTER_DY - MARKER_RADIUS),
      width: POP_WIDTH,
    };
  }

  const currentZoomPercent = Math.round(viewportRef.current.scale * 100);

  return (
    <div
      ref={containerRef}
      className="nm-canvas-wrap"
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 320,
        overflow: 'hidden',
        borderRadius: 16,
        border: '1px solid var(--nm-border)',
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* ── 顶部浮动深色胶囊工具栏（Comiku 风格）───────────────── */}
      <div className="cm-canvas-capsule-bar">
        <button
          type="button"
          className={`cm-capsule-btn${activeTool === 'select' ? ' is-active' : ''}`}
          onClick={() => setActiveTool('select')}
          title="选择 / 移动标记"
        >
          <SelectOutlined />
        </button>
        <button
          type="button"
          className={`cm-capsule-btn${activeTool === 'in' ? ' is-active' : ''}`}
          onClick={() => setActiveTool('in')}
          title="添加框内标记"
        >
          <EnvironmentOutlined />
        </button>
        <button
          type="button"
          className={`cm-capsule-btn${activeTool === 'out' ? ' is-active' : ''}`}
          onClick={() => setActiveTool('out')}
          title="添加框外标记"
        >
          <MessageOutlined />
        </button>
        <button
          type="button"
          className={`cm-capsule-btn${activeTool === 'pan' ? ' is-active' : ''}`}
          onClick={() => setActiveTool('pan')}
          title="移动画布"
        >
          <DragOutlined />
        </button>

        <div className="cm-capsule-divider" />

        <button type="button" className="cm-capsule-btn" onClick={() => zoomBy(1 / 1.2)} title="缩小">
          <MinusOutlined style={{ fontSize: 11 }} />
        </button>
        <div
          className="cm-capsule-zoom-text"
          onClick={() => {
            viewportRef.current = fitViewport();
            scheduleDraw();
            bumpViewport((n) => n + 1);
          }}
          title="点击重置为适宽"
        >
          {currentZoomPercent}%
        </div>
        <button type="button" className="cm-capsule-btn" onClick={() => zoomBy(1.2)} title="放大">
          <PlusOutlined style={{ fontSize: 11 }} />
        </button>
      </div>

      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          cursor: activeTool === 'pan' ? 'grab' : hoveredId ? 'pointer' : 'crosshair',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
      />

      {/* 浮层 */}
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

      {/* ── 底部浮动提示与翻页快捷条 ──────────────────────────── */}
      <div className="cm-canvas-bottom-bar">
        <span>选中标记后可拖动，右侧编辑译文</span>
        {pageCount && pageCount > 1 ? (
          <div className="cm-canvas-page-nav">
            <button
              type="button"
              className="cm-canvas-page-btn"
              disabled={!pageIndex || pageIndex <= 1}
              onClick={onPrevPage}
            >
              上一页
            </button>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>
              {pageIndex} / {pageCount}
            </span>
            <button
              type="button"
              className="cm-canvas-page-btn"
              disabled={!pageIndex || pageIndex >= pageCount}
              onClick={onNextPage}
            >
              下一页
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function displayTextOf(source: SourceWithTranslations, mode: CanvasTextMode): string {
  if (mode === 'source') return source.content;
  const selected = source.selected;
  if (!selected) return '';
  return mode === 'proofread' ? selected.proofreadContent || selected.content : selected.content;
}
