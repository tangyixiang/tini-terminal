import type { TerminalView } from './TerminalView';
import type { TerminalSession } from './TerminalSession';

export interface TerminalResizeOptions {
  container: HTMLElement;
  view: TerminalView;
  session: TerminalSession;
  getIsActive: () => boolean;
}

export class TerminalResize {
  private container: HTMLElement;
  private view: TerminalView;
  private session: TerminalSession;
  private getIsActive: () => boolean;
  private resizeObserver: ResizeObserver | null = null;
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
      this.sync();
    });
    this.resizeObserver.observe(this.container);
  }

  public sync(): void {
    if (this.isDisposed || !this.container || !this.getIsActive()) return;

    const { clientWidth, clientHeight } = this.container;
    // 只有具有实际可见有效宽高时才执行排版与后端同步，避免隐藏 Tab 被误算为异常极小尺寸
    if (clientWidth < 120 || clientHeight < 60) {
      return;
    }

    const fitResult = this.view.fit();
    if (fitResult && fitResult.cols >= 20 && fitResult.rows >= 5) {
      this.session.resize(fitResult.cols, fitResult.rows);
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }
}
