/**
 * 前后端共享的纯逻辑。
 *
 * 这一层刻意不含任何框架、数据库、Node 专有 API —— 前端画布与后端导出会
 * 引同一份实现，保证「预览看到的换行」与「导出得到的换行」逐字一致。
 * 这是本包存在的**唯一理由**：两边各写一套，漂移只是时间问题，
 * 而漂移会在用户已经在 PS 里排完版之后才被发现。
 */

export { naturalCompare, naturalSortKey, sortByNatural } from './natural-sort.js';

export {
  DEFAULT_FONT_SIZE_RATIO,
  DEFAULT_TEXT_STYLE,
  POSITION_TYPES,
  annotationRect,
  clamp01,
  layoutAnnotation,
  layoutText,
  resolveStyle,
  type Annotation,
  type LaidOutText,
  type LayoutInput,
  type PositionType,
  type Rect,
  type TextAlign,
  type TextStyle,
} from './annotation.js';

export {
  MARKER_ARROW_HEIGHT,
  MARKER_ARROW_WIDTH,
  MARKER_CENTER_DY,
  MARKER_FONT_FAMILY,
  MARKER_FONT_SIZE,
  MARKER_RADIUS,
  hitTestMarker,
  type MarkerAnchor,
} from './marker.js';

export {
  TATE_CHU_YOKO_MAX,
  atomize,
  canEndLine,
  canStartLine,
  groupVerticalRuns,
  normalizeTextLayers,
  wrapText,
  wrapVertical,
  type Measure,
  type NormalizedTextLayer,
  type TextAtom,
  type VerticalRun,
} from './typeset-layer.js';

export {
  checkText,
  hasBlockingIssues,
  type TextIssue,
  type TextIssueSeverity,
} from './text-check.js';

export {
  LABELPLUS_GROUPS,
  LP_VERSION,
  dedupeLpFilenames,
  groupIdOfPosition,
  labelPlusDownloadName,
  parseLabelPlus,
  positionTypeOfGroup,
  sanitizeLpFilename,
  serializeLabelPlus,
  type LpDocument,
  type LpFile,
  type LpMarker,
} from './labelplus.js';
