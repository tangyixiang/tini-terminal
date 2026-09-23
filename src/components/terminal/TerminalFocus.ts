import type { TerminalView } from './TerminalView';

export interface TerminalFocusOptions {
  tabId: string;
  view: TerminalView;
  container: HTMLElement;
  getIsActive: () => boolean;
}

export class TerminalFocus {
  private tabId: string;
  private view: TerminalView;
  private container: HTMLElement;
  private getIsActive: () => boolean;
  private isDisposed = false;
  private handleRefocusBound: (e: Event) => void;
  private handleWindowFocusBound: () => void;
  private handleContainerFocusBound: () => void;

  constructor(options: TerminalFocusOptions) {
    this.tabId = options.tabId;
    this.view = options.view;
    this.container = options.container;
    this.getIsActive = options.getIsActive;

    this.handleRefocusBound = this.handleRefocus.bind(this);
    this.handleWindowFocusBound = this.handleWindowFocus.bind(this);
    this.handleContainerFocusBound = this.handleContainerFocus.bind(this);

    window.addEventListener('terminal:refocus', this.handleRefocusBound);
    window.addEventListener('focus', this.handleWindowFocusBound);

    this.container.addEventListener('mousedown', this.handleContainerFocusBound);
    this.container.addEventListener('click', this.handleContainerFocusBound);
    this.container.addEventListener('pointerdown', this.handleContainerFocusBound);
  }

  public updateTabId(tabId: string): void {
    this.tabId = tabId;
  }

  public focus(): void {
    if (this.isDisposed || !this.getIsActive()) return;
    this.view.focus();
  }

  public blur(): void {
    if (this.isDisposed) return;
    this.view.blur();
  }

  public onActiveChange(isActive: boolean): void {
    if (this.isDisposed) return;
    if (isActive) {
      this.focus();
      requestAnimationFrame(() => this.focus());
      setTimeout(() => this.focus(), 50);
      setTimeout(() => this.focus(), 150);
    } else {
      this.blur();
    }
  }

  private handleContainerFocus(): void {
    if (this.isDisposed || !this.getIsActive()) return;
    this.focus();
  }

  private handleWindowFocus(): void {
    if (this.isDisposed || !this.getIsActive()) return;
    this.focus();
  }

  private handleRefocus(e: Event): void {
    if (this.isDisposed || !this.getIsActive()) return;
    const customEvent = e as CustomEvent<{ tabId?: string }>;
    if (!customEvent.detail?.tabId || customEvent.detail.tabId === this.tabId) {
      this.focus();
      setTimeout(() => this.focus(), 30);
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    window.removeEventListener('terminal:refocus', this.handleRefocusBound);
    window.removeEventListener('focus', this.handleWindowFocusBound);

    this.container.removeEventListener('mousedown', this.handleContainerFocusBound);
    this.container.removeEventListener('click', this.handleContainerFocusBound);
    this.container.removeEventListener('pointerdown', this.handleContainerFocusBound);
  }
}
