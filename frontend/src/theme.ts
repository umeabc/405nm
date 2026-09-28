import { theme as antdTheme, type ThemeConfig } from 'antd';

/**
 * Comiku 色板 —— 暖色、柔和、圆角。
 * 参考设计稿：https://comiku-preview.vercel.app
 *
 * 这里只放「令牌」，组件一律用 antd 再覆写令牌，
 * 不自造组件库 —— 否则后续每个页面的交互都要重新造一遍。
 */
export const comiku = {
  primary: '#F0836A',
  bg: '#FDF8F3',
  surface: '#FFFFFF',
  border: '#F0E4DA',
  ink: '#3A3230',
  inkSoft: '#8A7C74',
  success: '#5FA97C',
  warning: '#E4A23C',
  danger: '#D9534F',
} as const;

/** 暗色下的对应令牌。彩翻有暗色模式，这边保持一致。 */
export const comikuDark = {
  primary: '#F0836A',
  bg: '#1C1917',
  surface: '#26211F',
  border: '#3A3230',
  ink: '#F0E9E4',
  inkSoft: '#A89C94',
  success: '#7BC197',
  warning: '#E4A23C',
  danger: '#E07A76',
} as const;

/**
 * 环节状态色：作品卡上的状态徽标与进度条按环节取色，
 * 让人一眼看出这部作品卡在哪一步。
 */
export const stageColors = {
  translating: '#7FA8D9',
  proofreading: '#B08BD1',
  typesetting: '#5FA97C',
  publishable: '#E4A23C',
  published: '#9AA0A6',
} as const;

export type StageKey = keyof typeof stageColors;

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
  const palette = dark ? comikuDark : comiku;

  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: palette.primary,
      colorBgLayout: palette.bg,
      colorBgContainer: palette.surface,
      colorBorderSecondary: palette.border,
      colorText: palette.ink,
      colorTextSecondary: palette.inkSoft,
      colorSuccess: palette.success,
      colorWarning: palette.warning,
      colorError: palette.danger,
      borderRadius: 12,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    },
    components: {
      Card: { borderRadiusLG: 16, paddingLG: 20 },
      Button: { controlHeight: 38, borderRadius: 10 },
      Layout: { bodyBg: palette.bg, headerBg: palette.surface },
    },
  };
}

/** 把当前色板写进 CSS 变量，供非 antd 的原生元素使用。 */
export function applyCssVariables(dark: boolean): void {
  const palette = dark ? comikuDark : comiku;
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.setProperty('--comiku-bg', palette.bg);
  root.style.setProperty('--comiku-surface', palette.surface);
  root.style.setProperty('--comiku-border', palette.border);
  root.style.setProperty('--comiku-ink', palette.ink);
  root.style.setProperty('--comiku-ink-soft', palette.inkSoft);
  root.style.setProperty('--comiku-primary', palette.primary);
  root.style.colorScheme = dark ? 'dark' : 'light';
}
