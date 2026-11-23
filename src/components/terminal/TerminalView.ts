import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import '@xterm/xterm/css/xterm.css';
import { getDefaultTerminalFontFamily } from '../../lib/platform';

export interface TerminalViewOptions {
  fontSize?: number;
  theme?: ITheme;
  enableWebgl?: boolean;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measureCharHeight(fontFamily: string, fontSize: number): number | null {
  try {
    if (!measureCtx) {
      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(8, 8)
          : document.createElement('canvas');
      measureCtx = (canvas.getContext('2d') as CanvasRenderingContext2D | null) ?? null;
    }
    if (!measureCtx) return null;

    measureCtx.font = `${fontSize}px ${fontFamily}`;
    const metrics = measureCtx.measureText('W');
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    if (typeof ascent === 'number' && typeof descent === 'number' && ascent + descent > 0) {
      return ascent + descent;
    }
    return fontSize * 1.2;
  } catch {
    return fontSize * 1.2;
  }
}

function resolveIntegerLineHeight(
  charHeightDevice: number,
  fontSize: number,
  dpr: number
): number | null {
  if (!Number.isFinite(charHeightDevice) || charHeightDevice <= 0) return null;
  const targetCss = Math.max(fontSize + 1, Math.round(fontSize * 1.45));
  const targetDevice = Math.round(targetCss * dpr);
  const ratio = (targetDevice + 0.5) / charHeightDevice;
  if (!Number.isFinite(ratio)) return null;
  return Number(Math.min(1.8, Math.max(1.05, ratio)).toFixed(4));
}

export class TerminalView {
  private term: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private webLinksAddon: WebLinksAddon;
  private webglAddon: WebglAddon | null = null;
  private enableWebgl: boolean;
  private isDisposed = false;

  constructor(options?: TerminalViewOptions) {
    this.enableWebgl = options?.enableWebgl !== false;
    const terminalFontFamily = getDefaultTerminalFontFamily();

    this.term = new Terminal({
      fontFamily: terminalFontFamily,
      fontSize: options?.fontSize || 14,
      lineHeight: 1.45,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: true,
      scrollback: 10000,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: true,
      smoothScrollDuration: 0,
      scrollOnUserInput: true,
      theme: options?.theme,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    // 使用原生系统浏览器打开终端中的链接，解决 Tauri WebView 默认拦截 window.open 的问题
    this.webLinksAddon = new WebLinksAddon((_event, uri) => {
      if (window.__TAURI_INTERNALS__) {
        invoke('open_external_url', { url: uri }).catch(() => {});
      } else {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }
    });

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
    this.applyIntegerLineHeight();

    // 启用 WebGL GPU 加速渲染；在 Linux Wayland / 虚拟机 / 无 GPU 环境下自动优雅降级至 DOM 渲染器
    if (this.enableWebgl) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          try {
            addon.dispose();
          } catch {}
          if (this.webglAddon === addon) {
            this.webglAddon = null;
          }
        });
        this.term.loadAddon(addon);
        this.webglAddon = addon;
      } catch {
        this.webglAddon = null;
      }
    }
  }

  public applyIntegerLineHeight(): boolean {
    if (this.isDisposed) return false;
    try {
      const fontSize = this.term.options.fontSize || 14;
      const fontFamily = this.term.options.fontFamily || 'monospace';
      const charHeight = measureCharHeight(fontFamily, fontSize);
      if (!charHeight) return false;

      const dpr =
        typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      const charHeightDevice = Math.ceil(charHeight * dpr);
      const ratio = resolveIntegerLineHeight(charHeightDevice, fontSize, dpr);
      if (ratio === null) return false;

      if (Math.abs((this.term.options.lineHeight || 1) - ratio) < 0.001) return false;
      this.term.options.lineHeight = ratio;
      return true;
    } catch {
      return false;
    }
  }

  public fit(): { cols: number; rows: number } | null {
    if (this.isDisposed) return null;
    try {
      const before = { cols: this.term.cols, rows: this.term.rows };
      this.fitAddon.fit();
      const after = { cols: this.term.cols, rows: this.term.rows };
      if (before.cols !== after.cols || before.rows !== after.rows) {
        this.term.refresh(0, Math.max(0, after.rows - 1));
      }
      return after;
    } catch {
      return null;
    }
  }

  public findNext(term: string, options?: ISearchOptions): boolean {
    if (this.isDisposed || !term) return false;
    return this.searchAddon.findNext(term, {
      decorations: {
        matchBackground: '#eab30855',
        matchOverviewRuler: '#eab308',
        activeMatchBackground: '#f97316aa',
        activeMatchColorOverviewRuler: '#f97316',
      },
      ...options,
    });
  }

  public findPrevious(term: string, options?: ISearchOptions): boolean {
    if (this.isDisposed || !term) return false;
    return this.searchAddon.findPrevious(term, {
      decorations: {
        matchBackground: '#eab30855',
        matchOverviewRuler: '#eab308',
        activeMatchBackground: '#f97316aa',
        activeMatchColorOverviewRuler: '#f97316',
      },
      ...options,
    });
  }

  public clearSearch(): void {
    if (this.isDisposed) return;
    try {
      this.searchAddon.clearDecorations();
    } catch {}
  }

  /** 读取当前活动缓冲区末尾 N 行纯文本，供 AI 感知终端现场 */
  public getRecentBufferText(maxLines = 45): string {
    if (this.isDisposed) return '';
    try {
      const buf = this.term.buffer.active;
      const total = buf.length;
      const start = Math.max(0, total - maxLines);
      const lines: string[] = [];
      for (let i = start; i < total; i++) {
        const line = buf.getLine(i);
        if (line) {
          lines.push(line.translateToString(true));
        }
      }
      // 去除尾部连续空行
      while (lines.length > 0 && !lines[lines.length - 1].trim()) {
        lines.pop();
      }
      return lines.join('\n');
    } catch {
      return '';
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

  /** 规范化 Windows 剪贴板 CRLF (\r\n) 换行，避免粘入远程 Linux/vim 产生多余空行或 ^M */
  public paste(text: string): void {
    if (this.isDisposed || !text) return;
    const normalized = text.replace(/\r\n/g, '\n');
    this.term.paste(normalized);
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
    this.applyIntegerLineHeight();
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
      this.webglAddon?.dispose();
    } catch {}
    this.webglAddon = null;
    try {
      this.term.dispose();
    } catch {}
  }
}
