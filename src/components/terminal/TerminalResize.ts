import type { TerminalView } from './TerminalView';
import type { TerminalSession } from './TerminalSession';

export interface TerminalResizeOptions {
  container: HTMLElement;
  view: TerminalView;
  session: TerminalSession;
  getIsActive: () => boolean;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** 拖拽/布局动画期间的重排合并窗口，避免逐帧向后端发送 resize */
const RESIZE_DEBOUNCE_MS = 60;
/** 容器有效尺寸下限，隐藏或折叠状态下不参与排版 */
const MIN_WIDTH = 120;
const MIN_HEIGHT = 60;

export class TerminalResize {
  private container: HTMLElement;
  private view: TerminalView;
  private session: TerminalSession;
  private getIsActive: () => boolean;
  private resizeObserver: ResizeObserver | null = null;
  private rafId: number | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastApplied: TerminalSize = { cols: 0, rows: 0 };
  private isDisposed = false;

  constructor(options: TerminalResizeOptions) {
    this.container = options.container;
    this.view = options.view;
    this.session = options.session;
    this.getIsActive = options.getIsActive;

    this.initObserver();
  }

  private initObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.schedule();
    });
    this.resizeObserver.observe(this.container);
  }

  /** ResizeObserver 高频回调：用 rAF 合并到最近一帧，再补一次尾部延迟重排 */
  private schedule(): void {
    if (this.isDisposed) return;

    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.sync();
      });
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // 后台标签页中 rAF 可能被完全挂起，这里主动释放句柄，避免后续永远不再排帧
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.sync();
    }, RESIZE_DEBOUNCE_MS);
  }

  /**
   * 立即按容器尺寸排版并与后端同步。
   * @param force 忽略上次已应用的尺寸（首连、重连、字体变更时使用）
   */
  public sync(force = false): TerminalSize | null {
    if (this.isDisposed || !this.container) return null;
    // 非激活标签仅在强制排版（首次建连）时参与计算
    if (!force && !this.getIsActive()) return null;
    if (typeof document !== 'undefined' && document.hidden && !force) return null;

    const { clientWidth, clientHeight } = this.container;
    if (clientWidth < MIN_WIDTH || clientHeight < MIN_HEIGHT) return null;

    const fitResult = this.view.fit();
    if (!fitResult || fitResult.cols < 20 || fitResult.rows < 5) return null;

    const unchanged =
      fitResult.cols === this.lastApplied.cols && fitResult.rows === this.lastApplied.rows;

    if (unchanged && !force) return fitResult;

    this.lastApplied = { cols: fitResult.cols, rows: fitResult.rows };
    this.session.resize(fitResult.cols, fitResult.rows);
    return fitResult;
  }

  /** 会话重连后需要按新 PTY 强制同步一次尺寸 */
  public resetAppliedSize(): void {
    this.lastApplied = { cols: 0, rows: 0 };
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }
}
