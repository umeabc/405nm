import { theme as antdTheme, type ThemeConfig } from 'antd';

/**
 * 405nm 的色板与令牌。
 *
 * 视觉语言对齐彩翻（moeflow-irohamod）—— 团队用惯了那一套，新站不该让人重新学一遍配色。
 * 色值与尺寸的确切出处见 `docs/moeflow-ui-reference.md`。
 *
 * **只借「值」不借「实现」**：那边是 antd 4 + 构建期 Less 变量覆盖，
 * 这边是 antd 5 的 token 体系，两边没有共同的抽象层，主题代码照搬不过来。
 * 所以这里是照它的色值在我们自己的令牌层重写一遍。
 */
export const palette = {
  /** 主色。按钮、链接、选中态、进度条。 */
  primary: '#FF657C',
  /** 主色深端。按钮渐变终点、登录页站名 —— 需要比主色更沉的场合用它。 */
  primaryDeep: '#d94c66',
  /** 主色浅端。次要描边与选中底。 */
  primarySoft: '#ff8f9c',
  /**
   * 金色点缀。**只用于装饰** —— 登录页光环、卡片顶部斜条纹。
   * 它明度太高，承载正文会掉对比度；需要文字的地方一律走 `warning`。
   * 两者确实相近（都取自彩翻），但一个是装饰色、一个是语义色，混用会同时丢掉这两重含义。
   */
  gold: '#f2b64b',
  /** 纸粉底。登录页渐变的起色，以及后台那种「整片留白」的底。 */
  paper: '#fdf4f6',

  bg: '#FFFFFF',
  surface: '#FFFFFF',
  border: '#EEEEEE',
  borderStrong: '#DBDBDB',
  ink: 'rgba(0, 0, 0, 0.85)',
  inkSoft: 'rgba(0, 0, 0, 0.45)',

  success: '#5FA97C',
  warning: '#E4A23C',
  danger: '#D9534F',
} as const;

/**
 * 暗色令牌。
 *
 * 彩翻的暗色是「一份 CSS 变量表 + 一大堆 antd 深色覆盖 `!important`」手工堆出来的，
 * 那套做法会漏白。我们走 antd 5 的 `darkAlgorithm`，这里只补它算不出来的那几项。
 */
export const paletteDark = {
  primary: '#FF657C',
  primaryDeep: '#e0506a',
  primarySoft: '#ff8f9c',
  gold: '#f2b64b',
  paper: '#241A1C',

  // 彩翻的暗色底是中性灰，不带暖调。主色换成冷粉之后，原先那套暖褐底色会打架。
  bg: '#121212',
  surface: '#1C1C1C',
  border: '#303030',
  borderStrong: '#3A3A3A',
  ink: 'rgba(255, 255, 255, 0.85)',
  inkSoft: 'rgba(255, 255, 255, 0.45)',

  success: '#7BC197',
  warning: '#E4A23C',
  danger: '#E07A76',
} as const;

/**
 * 环节状态色：作品卡上的状态徽标与进度条按环节取色，让人一眼看出卡在哪一步。
 *
 * 这五个色**刻意避开主色**（粉）—— 主色会出现在同一张卡片的按钮和进度条上，
 * 再用它表示环节就分不清「这是环节色还是可点区域」了。
 */
export const stageColors = {
  translating: '#7FA8D9',
  proofreading: '#B08BD1',
  typesetting: '#5FA97C',
  publishable: '#E4A23C',
  published: '#9AA0A6',
} as const;

export type StageKey = keyof typeof stageColors;

/** 顶栏高度。画布类页面要按它算可用高度，因此做成变量而不是散落的魔数。 */
export const HEADER_HEIGHT = 56;

export const THEME_STORAGE_KEY = 'nm405.theme';

export function readStoredDark(): boolean {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
  } catch {
    // localStorage 在隐私模式下可能抛异常，忽略即可。
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function buildTheme(dark: boolean): ThemeConfig {
  const p = dark ? paletteDark : palette;

  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: p.primary,
      colorBgLayout: p.bg,
      colorBgContainer: p.surface,
      colorBorderSecondary: p.border,
      colorText: p.ink,
      colorTextSecondary: p.inkSoft,
      colorSuccess: p.success,
      colorWarning: p.warning,
      colorError: p.danger,
      // 彩翻的基础圆角是 8px（antd 默认 6），小元素 4px。
      borderRadius: 8,
      borderRadiusSM: 4,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    },
    components: {
      // 卡片也是 8 —— 彩翻的作品卡就是 8px 内圆角，圆角再大一点就不是那个观感了。
      Card: { borderRadiusLG: 8, paddingLG: 20 },
      Button: { controlHeight: 38 },
      Layout: { bodyBg: p.bg, headerBg: p.surface, headerHeight: HEADER_HEIGHT },
    },
  };
}

/** 把当前色板写进 CSS 变量，供非 antd 的原生元素使用。 */
export function applyCssVariables(dark: boolean): void {
  const p = dark ? paletteDark : palette;
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.setProperty('--nm-bg', p.bg);
  root.style.setProperty('--nm-surface', p.surface);
  root.style.setProperty('--nm-border', p.border);
  root.style.setProperty('--nm-border-strong', p.borderStrong);
  root.style.setProperty('--nm-ink', p.ink);
  root.style.setProperty('--nm-ink-soft', p.inkSoft);
  root.style.setProperty('--nm-primary', p.primary);
  root.style.setProperty('--nm-primary-deep', p.primaryDeep);
  root.style.setProperty('--nm-primary-soft', p.primarySoft);
  root.style.setProperty('--nm-gold', p.gold);
  root.style.setProperty('--nm-paper', p.paper);
  root.style.setProperty('--nm-header-h', `${HEADER_HEIGHT}px`);
  root.style.colorScheme = dark ? 'dark' : 'light';
}
