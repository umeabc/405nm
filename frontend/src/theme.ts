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
  /** 主色：Comiku 标志性的紫罗兰 / 鸢尾紫 */
  primary: '#6C5CE7',
  /** 主色深端：按钮悬停与重点强调 */
  primaryDeep: '#5846cf',
  /** 主色浅端：淡紫背景与轻描边 */
  primarySoft: '#8c7cf8',
  /** 点缀金：用于星芒徽章与高亮装饰 */
  gold: '#F59E0B',
  /** 纸质柔和底色 */
  paper: '#F0EEFB',

  /** 全局背景：Comiku 原版浅淡灰紫底色，让纯白卡片自然浮起 */
  bg: '#F6F7FA',
  /** 卡片与容器表面色 */
  surface: '#FFFFFF',
  border: '#E8E9F1',
  borderStrong: '#D7D9E4',
  ink: '#232738',
  inkSoft: '#687182',

  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
} as const;

/**
 * 暗色令牌。
 */
export const paletteDark = {
  primary: '#8C7CF8',
  primaryDeep: '#7664f3',
  primarySoft: '#a295ff',
  gold: '#FBBF24',
  paper: '#1F212E',

  bg: '#14161F',
  surface: '#1D202C',
  border: '#2D3244',
  borderStrong: '#3D445C',
  ink: 'rgba(255, 255, 255, 0.90)',
  inkSoft: 'rgba(255, 255, 255, 0.50)',

  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
} as const;

/**
 * 环节状态色：对齐 Comiku 风格的状态标签与轻量进度条。
 */
export const stageColors = {
  translating: '#10B981',
  proofreading: '#F59E0B',
  typesetting: '#8B5CF6',
  publishable: '#3B82F6',
  published: '#059669',
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
      // Comiku 的基础圆角偏大偏圆润（卡片 16px，普通组件 10px，小元素 6px）
      borderRadius: 10,
      borderRadiusSM: 6,
      borderRadiusLG: 16,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Plus Jakarta Sans', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    },
    components: {
      Card: { borderRadiusLG: 16, paddingLG: 20 },
      Button: { controlHeight: 38, borderRadius: 10 },
      Input: { controlHeight: 38, borderRadius: 10 },
      Select: { controlHeight: 38, borderRadius: 10 },
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
  root.style.setProperty('--nm-primary-rgb', dark ? '140 124 248' : '108 92 231');
  root.style.setProperty('--nm-gold', p.gold);
  root.style.setProperty('--nm-paper', p.paper);
  root.style.setProperty('--nm-header-h', `${HEADER_HEIGHT}px`);
  root.style.colorScheme = dark ? 'dark' : 'light';
}
