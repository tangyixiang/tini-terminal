import type { IDisposable } from '@xterm/xterm';
import { isMacPlatform } from '../../lib/platform';
import type { TerminalView } from './TerminalView';
import type { TerminalSession } from './TerminalSession';

export interface TerminalInputOptions {
  view: TerminalView;
  session: TerminalSession;
  getIsActive: () => boolean;
  onOpenSearch?: () => void;
  onMultiLinePaste?: (text: string) => void;
  onZoomFont?: (delta: number) => void;
}

export class TerminalInput {
  private view: TerminalView;
  private session: TerminalSession;
  private getIsActive: () => boolean;
  private onOpenSearch?: () => void;
  private onMultiLinePaste?: (text: string) => void;
  private onZoomFont?: (delta: number) => void;
  private onDataDisposable: IDisposable | null = null;
  private isDisposed = false;

  constructor(options: TerminalInputOptions) {
    this.view = options.view;
    this.session = options.session;
    this.getIsActive = options.getIsActive;
    this.onOpenSearch = options.onOpenSearch;
    this.onMultiLinePaste = options.onMultiLinePaste;
    this.onZoomFont = options.onZoomFont;

    this.bind();
  }

  private bind(): void {
    const rawTerm = this.view.rawTerm;

    this.onDataDisposable = rawTerm.onData((data) => {
      if (this.isDisposed || !this.getIsActive()) return;
      this.session.send(data);
    });

    rawTerm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      return this.handleKeyEvent(event);
    });
  }

  public triggerSafePaste(text: string): void {
    if (this.isDisposed || !text) return;
    const normalized = text.replace(/\r\n/g, '\n');
    // 多行内容（含换行符且非末尾单个换行）触发防误触确认弹窗，防止在生产终端误执行多条指令
    const trimmedTrailing = normalized.replace(/\n$/, '');
    if (trimmedTrailing.includes('\n') && this.onMultiLinePaste) {
      this.onMultiLinePaste(normalized);
      return;
    }
    this.view.paste(normalized);
  }

  private pasteFromClipboard(): void {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text && !this.isDisposed) {
          this.triggerSafePaste(text);
        }
      })
      .catch(() => {});
  }

  private handleKeyEvent(event: KeyboardEvent): boolean {
    if (this.isDisposed || event.type !== 'keydown') {
      return true;
    }

    const isMac = isMacPlatform();
    const keyLower = event.key.toLowerCase();

    if (isMac) {
      // macOS：Cmd 负责本地终端快捷键，Ctrl 完整透传给远程 Shell (Ctrl+C/W/R/L/D)
      if (event.metaKey && !event.ctrlKey && !event.altKey) {
        if (keyLower === 'c') {
          const selection = this.view.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {});
            this.view.clearSelection();
            return false;
          }
          return true;
        }
        if (keyLower === 'v') {
          event.preventDefault();
          this.pasteFromClipboard();
          return false;
        }
        if (keyLower === 'f') {
          event.preventDefault();
          this.onOpenSearch?.();
          return false;
        }
        if (keyLower === 'k') {
          event.preventDefault();
          this.view.clear();
          return false;
        }
        if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          this.onZoomFont?.(1);
          return false;
        }
        if (event.key === '-') {
          event.preventDefault();
          this.onZoomFont?.(-1);
          return false;
        }
      }
      return true;
    }

    // Windows / Linux：使用 Ctrl+Shift 避免劫持 Bash/Vim 的 Ctrl+C/W/R/K/L 控制键
    if (event.ctrlKey && event.shiftKey && !event.altKey) {
      if (event.code === 'KeyC' || keyLower === 'c') {
        const selection = this.view.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
          this.view.clearSelection();
        }
        return false;
      }
      if (event.code === 'KeyV' || keyLower === 'v') {
        event.preventDefault();
        this.pasteFromClipboard();
        return false;
      }
      if (event.code === 'KeyF' || keyLower === 'f') {
        event.preventDefault();
        this.onOpenSearch?.();
        return false;
      }
      if (event.code === 'KeyK' || keyLower === 'k') {
        event.preventDefault();
        this.view.clear();
        return false;
      }
    }

    // Windows / Linux 下：有选区时按 Ctrl+C 复制并清除选区；无选区时原样发送 SIGINT
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      if (keyLower === 'c') {
        const selection = this.view.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
          this.view.clearSelection();
          return false;
        }
      }
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        this.onZoomFont?.(1);
        return false;
      }
      if (event.key === '-') {
        event.preventDefault();
        this.onZoomFont?.(-1);
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
