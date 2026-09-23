import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export interface TerminalViewOptions {
  fontSize?: number;
  theme?: ITheme;
}

export class TerminalView {
  private term: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private webLinksAddon: WebLinksAddon;
  private isDisposed = false;

  constructor(options?: TerminalViewOptions) {
    const isWindows =
      typeof navigator !== 'undefined' &&
      /win/i.test(navigator.platform || navigator.userAgent);

    const terminalFontFamily = isWindows
      ? "'Cascadia Mono', Consolas, 'Microsoft YaHei', monospace"
      : "Menlo, Monaco, 'PingFang SC', monospace";

    this.term = new Terminal({
      fontFamily: terminalFontFamily,
      fontSize: options?.fontSize || 14,
      lineHeight: 1.42,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: true,
      scrollback: 10000,
      theme: options?.theme,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.webLinksAddon = new WebLinksAddon();

    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    this.term.loadAddon(this.webLinksAddon);
  }

  public get rawTerm(): Terminal {
    return this.term;
  }

  public get cols(): number {
    return this.term.cols;
  }

  public get rows(): number {
    return this.term.rows;
  }

  public open(container: HTMLElement): void {
    if (this.isDisposed) return;
    this.term.open(container);
  }

  public fit(): { cols: number; rows: number } | null {
    if (this.isDisposed) return null;
    try {
      this.fitAddon.fit();
      return { cols: this.term.cols, rows: this.term.rows };
    } catch {
      return null;
    }
  }

  public focus(): void {
    if (this.isDisposed) return;
    try {
      this.term.focus();
      if (this.term.textarea) {
        this.term.textarea.focus({ preventScroll: true });
      }
    } catch {}
  }

  public blur(): void {
    if (this.isDisposed) return;
    try {
      this.term.blur();
    } catch {}
  }

  public clear(): void {
    if (this.isDisposed) return;
    this.term.clear();
  }

  public selectAll(): void {
    if (this.isDisposed) return;
    this.term.selectAll();
  }

  public clearSelection(): void {
    if (this.isDisposed) return;
    this.term.clearSelection();
  }

  public getSelection(): string {
    if (this.isDisposed) return '';
    return this.term.getSelection() || '';
  }

  public paste(text: string): void {
    if (this.isDisposed || !text) return;
    this.term.paste(text);
  }

  public write(data: string | Uint8Array): void {
    if (this.isDisposed) return;
    this.term.write(data);
  }

  public writeln(data: string): void {
    if (this.isDisposed) return;
    this.term.writeln(data);
  }

  public setTheme(theme: ITheme): void {
    if (this.isDisposed) return;
    this.term.options.theme = theme;
  }

  public setFontSize(fontSize: number): void {
    if (this.isDisposed) return;
    this.term.options.fontSize = fontSize;
  }

  public refresh(start = 0, end = this.term.rows - 1): void {
    if (this.isDisposed) return;
    try {
      this.term.refresh(start, end);
    } catch {}
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    try {
      this.term.dispose();
    } catch {}
  }
}
