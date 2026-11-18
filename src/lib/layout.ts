/**
 * 主工作区横向布局约束。
 * 终端画布始终保持可用宽度，避免侧栏 / AI 面板把终端挤压成不可读的窄条。
 */

export const MIN_TERMINAL_WIDTH = 420;
export const MIN_SIDEBAR_WIDTH = 160;
export const MAX_SIDEBAR_WIDTH = 400;
export const MIN_AI_PANEL_WIDTH = 260;
export const COMPACT_AI_PANEL_WIDTH = 360;
/** 宽屏模式下 AI 面板占窗口宽度的比例 */
export const WIDE_AI_PANEL_RATIO = 0.48;
/** 两个拖拽手柄占用的横向尺寸总和 */
export const RESIZE_HANDLE_TOTAL = 20;

/** 侧栏允许保存的绝对宽度区间（实际渲染时还会按视口收敛） */
export const SIDEBAR_ABS_MIN = 160;
export const SIDEBAR_ABS_MAX = 400;
export const AI_PANEL_ABS_MIN = 260;
export const AI_PANEL_ABS_MAX = 1200;

function viewportWidth(fallback = 1280): number {
  return typeof window !== 'undefined' && window.innerWidth > 0
    ? window.innerWidth
    : fallback;
}

/** 侧栏最大宽度：不超过窗口 30%，且为终端留出最小可用宽度 */
export function maxSidebarWidth(windowWidth = viewportWidth()): number {
  const byRatio = Math.round(windowWidth * 0.3);
  const byTerminal = windowWidth - MIN_TERMINAL_WIDTH - MIN_AI_PANEL_WIDTH - RESIZE_HANDLE_TOTAL;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, byRatio, byTerminal));
}

export function clampSidebarWidth(width: number, windowWidth = viewportWidth()): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxSidebarWidth(windowWidth), Math.round(width)));
}

/** 仅做绝对区间收敛，用于持久化用户偏好值 */
export function clampSidebarPreference(width: number): number {
  return Math.max(SIDEBAR_ABS_MIN, Math.min(SIDEBAR_ABS_MAX, Math.round(width)));
}

/** AI 面板最大宽度：保证左侧侧栏与终端仍有可用空间 */
export function maxAiPanelWidth(
  windowWidth = viewportWidth(),
  sidebarWidth = 0
): number {
  const available =
    windowWidth - sidebarWidth - MIN_TERMINAL_WIDTH - RESIZE_HANDLE_TOTAL;
  const byRatio = Math.round(windowWidth * 0.55);
  return Math.max(MIN_AI_PANEL_WIDTH, Math.min(byRatio, available));
}

export function clampAiPanelWidth(
  width: number,
  windowWidth = viewportWidth(),
  sidebarWidth = 0
): number {
  return Math.max(
    MIN_AI_PANEL_WIDTH,
    Math.min(maxAiPanelWidth(windowWidth, sidebarWidth), Math.round(width))
  );
}

/** 仅做绝对区间收敛，用于持久化用户偏好值 */
export function clampAiPanelPreference(width: number): number {
  return Math.max(AI_PANEL_ABS_MIN, Math.min(AI_PANEL_ABS_MAX, Math.round(width)));
}

/** 双击手柄 / 点击面板按钮时在紧凑与宽屏之间切换的目标宽度（偏好值，渲染时再按视口收敛） */
export function nextAiPanelPreference(currentWidth: number, windowWidth = viewportWidth()): number {
  const target =
    currentWidth > 500 ? COMPACT_AI_PANEL_WIDTH : Math.round(windowWidth * WIDE_AI_PANEL_RATIO);
  return clampAiPanelPreference(target);
}
