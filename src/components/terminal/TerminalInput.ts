import type { IDisposable } from '@xterm/xterm';
import type { TerminalView } from './TerminalView';
import type { TerminalSession } from './TerminalSession';

export interface TerminalInputOptions {
  view: TerminalView;
  session: TerminalSession;
  getIsActive: () => boolean;
}

export class TerminalInput {
  private view: TerminalView;
  private session: TerminalSession;
  private getIsActive: () => boolean;
  private onDataDisposable: IDisposable | null = null;
  private isDisposed = false;

  constructor(options: TerminalInputOptions) {
    this.view = options.view;
    this.session = options.session;
    this.getIsActive = options.getIsActive;

    this.bind();
  }

  private bind(): void {
    const rawTerm = this.view.rawTerm;

    // 单一按键与粘贴输入出口：所有终端输入统一由此经过
    this.onDataDisposable = rawTerm.onData((data) => {
      if (this.isDisposed || !this.getIsActive()) return;
      this.session.send(data);
    });

    // 快捷键拦截与自定义处理
    rawTerm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      return this.handleKeyEvent(event);
    });
  }

  private handleKeyEvent(event: KeyboardEvent): boolean {
    if (this.isDisposed || event.type !== 'keydown') {
      return true;
    }

    const isCtrl = event.ctrlKey || event.metaKey;

    // Shift + Ctrl/Cmd + C：复制选区
    if (event.shiftKey && isCtrl) {
      const keyLower = event.key.toLowerCase();
      if (event.code === 'KeyC' || keyLower === 'c') {
        const selection = this.view.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        }
        return false;
      }

      // Shift + Ctrl/Cmd + V：统一通过 xterm 原生 paste 分发，杜绝外部旁路直接写队列
      if (event.code === 'KeyV' || keyLower === 'v') {
        event.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text && !this.isDisposed) {
              this.view.paste(text);
            }
          })
          .catch(() => {});
        return false;
      }
    }

    return true;
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.onDataDisposable) {
      this.onDataDisposable.dispose();
      this.onDataDisposable = null;
    }
  }
}
