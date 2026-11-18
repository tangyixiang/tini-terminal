import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export interface TerminalViewOptions {
  fontSize?: number;
  theme?: ITheme;
}

/**
 * 使用与 xterm 相同的 canvas 度量方式获取字符高度（ascent + descent）。
 * 这是 xterm 在支持 TextMetrics 时的首选度量策略，避免依赖其内部私有字段。
 */
let measureCtx: CanvasRenderingContext2D | null = null;
function measureCharHeight(fontFamily: string, fontSize: number): number | null {
  try {
    if (!measureCtx) {
      const canvas = typeof OffscreenCanvas !== 'undefined'
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
    // 退回行高近似值（多数等宽字体的 em 行高约为 1.2 倍字号）
    return fontSize * 1.2;
  } catch {
    return fontSize * 1.2;
  }
}

/**
 * xterm 的单元格高度按设备像素计算：
 *   cellHeight(device) = floor(ceil(charHeight × dpr) × lineHeight)
 *   cellHeight(css)    = cellHeight(device) / dpr
 * dpr=2、fontSize=14 时常见结果是 23.5px 这类半像素行高，行间亚像素缝隙会让字形
 * 相互渗入，表现为文字重叠与错行。反解 lineHeight 让 CSS 行高精确落在整数像素。
 */
function resolveIntegerLineHeight(
  charHeightDevice: number,
  fontSize: number,
  dpr: number
): number | null {
  if (!Number.isFinite(charHeightDevice) || charHeightDevice <= 0) return null;
  const targetCss = Math.max(fontSize + 1, Math.round(fontSize * 1.45));
  const targetDevice = Math.round(targetCss * dpr);
  // +0.5 保证 floor() 恰好取到目标整数值
  const ratio = (targetDevice + 0.5) / charHeightDevice;
  if (!Number.isFinite(ratio)) return null;
  return Number(Math.min(1.8, Math.max(1.05, ratio)).toFixed(4));
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
      lineHeight: 1.45,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: true,
      scrollback: 10000,
      // 保留给 WebGL 渲染器使用；当前默认 DOM 渲染器会忽略此项
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: true,
      smoothScrollDuration: 0,
      scrollOnUserInput: true,
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
    this.applyIntegerLineHeight();
  }

  /**
   * 依据实际字体度量把行高归整为整数 CSS 像素。
   *
   * xterm(DOM 渲染器) 的行高计算链路是：
   *   charHeight(device) = ceil(字体 ascent+descent × dpr)
   *   cellHeight(device) = floor(charHeight(device) × lineHeight)
   *   cellHeight(css)    = cellHeight(device) / dpr
   * 因此 lineHeight=1.45 在 dpr=2 时会得到 23.5px 这类半像素行高，
   * 行间亚像素缝隙就是文字重叠/错行（尤其输入行压住上一行输出）的根源。
   * 这里反解一个 lineHeight，使 cellHeight(css) 恰好落在整数像素上。
   *
   * @returns 是否实际调整了行高（调用方据此决定是否重新 fit）
   */
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
      // 行列发生变化时强制整屏重绘，清除 resize 前残留的旧画布帧，避免字符叠加
      if (before.cols !== after.cols || before.rows !== after.rows) {
        this.term.refresh(0, Math.max(0, after.rows - 1));
      }
      return after;
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
    // 字号变化会改变字符度量，行高需重新归整为整数像素
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
      this.term.dispose();
    } catch {}
  }
}
