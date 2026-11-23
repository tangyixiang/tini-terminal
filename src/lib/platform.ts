export type DesktopPlatform = 'macos' | 'windows' | 'linux';

/**
 * 统一识别当前运行的桌面操作系统（严格区分 macOS / Windows / Linux）
 */
export function getDesktopPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = (navigator.userAgent || '').toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();
  if (ua.includes('mac') || platform.includes('mac')) return 'macos';
  if (ua.includes('win') || platform.includes('win')) return 'windows';
  return 'linux';
}

export function isMacPlatform(): boolean {
  return getDesktopPlatform() === 'macos';
}

export function isWindowsPlatform(): boolean {
  return getDesktopPlatform() === 'windows';
}

export function isLinuxPlatform(): boolean {
  return getDesktopPlatform() === 'linux';
}

/**
 * 按三端分别返回合适的等宽 + 中文回退字体栈
 */
export function getDefaultTerminalFontFamily(): string {
  switch (getDesktopPlatform()) {
    case 'windows':
      return "'Cascadia Mono', Consolas, 'Microsoft YaHei', monospace";
    case 'macos':
      return "Menlo, Monaco, 'PingFang SC', monospace";
    case 'linux':
      return "'JetBrains Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono CJK SC', 'WenQuanYi Micro Hei Mono', monospace";
  }
}

export function getDefaultTerminalFontDisplay(): string {
  switch (getDesktopPlatform()) {
    case 'windows':
      return 'Cascadia Mono, Consolas, 微软雅黑';
    case 'macos':
      return 'Menlo, Monaco, 苹方 (PingFang SC)';
    case 'linux':
      return 'JetBrains Mono, DejaVu Sans Mono, Noto Sans Mono CJK SC';
  }
}

export function getLocalShellDisplayName(): string {
  switch (getDesktopPlatform()) {
    case 'windows':
      return 'PowerShell';
    case 'macos':
      return 'zsh / bash';
    case 'linux':
      return 'bash / zsh';
  }
}

/**
 * 将 Tauri v2 (wry) 原生拖放事件的坐标归一化为 CSS 逻辑像素：
 * - Windows (WebView2): ScreenToClient 返回物理像素，高分屏下需除以 devicePixelRatio
 * - macOS (WKWebView): NSDraggingInfo.draggingLocation 返回逻辑点，不可再除以 dpr
 * - Linux (WebKitGTK): GTK drag-motion 返回逻辑控件坐标，不可再除以 dpr
 */
export function normalizeTauriDragPosition(position?: { x: number; y: number } | null): {
  x: number;
  y: number;
} {
  if (!position) return { x: 0, y: 0 };
  if (isWindowsPlatform()) {
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    return { x: position.x / dpr, y: position.y / dpr };
  }
  return { x: position.x, y: position.y };
}
