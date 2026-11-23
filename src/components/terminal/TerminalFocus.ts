import { focusManager } from '../../core/focus/FocusManager';
import type { TerminalView } from './TerminalView';

export interface TerminalFocusOptions {
  tabId: string;
  sessionId: string;
  view: TerminalView;
  container: HTMLElement;
  getIsActive: () => boolean;
}

export class TerminalFocus {
  private tabId: string;
  private sessionId: string;
  private view: TerminalView;
  private container: HTMLElement;
  private getIsActive: () => boolean;
  private isDisposed = false;
  private pointerDownOnCanvas = false;
  private unregisterFocus: () => void;

  private handleRefocusBound: (e: Event) => void;
  private handleWindowFocusBound: () => void;
  private handleContainerMouseDownBound: (e: Event) => void;
  private handleContainerMouseUpBound: (e: Event) => void;

  constructor(options: TerminalFocusOptions) {
    this.tabId = options.tabId;
    this.sessionId = options.sessionId;
    this.view = options.view;
    this.container = options.container;
    this.getIsActive = options.getIsActive;

    this.unregisterFocus = focusManager.registerTerminal(this.sessionId, () => {
      if (this.isDisposed || !this.getIsActive()) return;
      this.view.focus();
    });

    this.handleRefocusBound = this.handleRefocus.bind(this);
    this.handleWindowFocusBound = this.handleWindowFocus.bind(this);
    this.handleContainerMouseDownBound = this.handleContainerMouseDown.bind(this);
    this.handleContainerMouseUpBound = this.handleContainerMouseUp.bind(this);

    window.addEventListener('terminal:refocus', this.handleRefocusBound);
    window.addEventListener('focus', this.handleWindowFocusBound);
    this.container.addEventListener('mousedown', this.handleContainerMouseDownBound);
    this.container.addEventListener('mouseup', this.handleContainerMouseUpBound);
  }

  public updateTabId(tabId: string): void {
    this.tabId = tabId;
  }

  public focus(force = false): void {
    if (this.isDisposed || !this.getIsActive()) return;
    if (force) {
      this.view.focus();
      return;
    }
    focusManager.requestTerminalFocus(this.sessionId);
  }

  public blur(): void {
    if (this.isDisposed) return;
    this.view.blur();
  }

  public onActiveChange(isActive: boolean): void {
    if (this.isDisposed) return;
    if (isActive) {
      focusManager.setActiveTerminal(this.sessionId);
      this.focus();
      requestAnimationFrame(() => this.focus());
      setTimeout(() => this.focus(), 60);
    } else {
      this.blur();
    }
  }

  private handleContainerMouseDown(e: Event): void {
    if (this.isDisposed || !this.getIsActive()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, [data-terminal-overlay]')) {
      this.pointerDownOnCanvas = false;
      return;
    }
    this.pointerDownOnCanvas = true;
    // 用户明确点击终端画布时立即聚焦，并在微任务中校正 WebKit 默认 mousedown 失焦
    this.view.focus();
  }

  private handleContainerMouseUp(e: Event): void {
    if (!this.pointerDownOnCanvas || this.isDisposed || !this.getIsActive()) return;
    this.pointerDownOnCanvas = false;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, [data-terminal-overlay]')) {
      return;
    }
    // 拖拽划词选中时不干扰选区，普通点击后确保焦点落回 .xterm-helper-textarea
    requestAnimationFrame(() => {
      if (this.isDisposed || !this.getIsActive()) return;
      const active = document.activeElement;
      if (!active || !active.classList.contains('xterm-helper-textarea')) {
        this.view.focus();
      }
    });
  }

  private handleWindowFocus(): void {
    if (this.isDisposed || !this.getIsActive()) return;
    focusManager.requestTerminalFocus(this.sessionId);
  }

  private handleRefocus(e: Event): void {
    if (this.isDisposed || !this.getIsActive()) return;
    const customEvent = e as CustomEvent<{ tabId?: string }>;
    if (!customEvent.detail?.tabId || customEvent.detail.tabId === this.tabId) {
      focusManager.requestTerminalFocus(this.sessionId);
      setTimeout(() => focusManager.requestTerminalFocus(this.sessionId), 30);
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    this.unregisterFocus();
    window.removeEventListener('terminal:refocus', this.handleRefocusBound);
    window.removeEventListener('focus', this.handleWindowFocusBound);
    this.container.removeEventListener('mousedown', this.handleContainerMouseDownBound);
    this.container.removeEventListener('mouseup', this.handleContainerMouseUpBound);
  }
}
