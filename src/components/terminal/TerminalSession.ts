import { invoke, Channel } from '@tauri-apps/api/core';
import type { TerminalTab } from '../../types';
import { TerminalInputStream } from './TerminalInputStream';

export interface TerminalSessionOptions {
  tab: TerminalTab;
  onOutput: (data: string) => void;
  onConnectedChange?: (connected: boolean) => void;
}

export class TerminalSession {
  private tab: TerminalTab;
  private onOutput: (data: string) => void;
  private onConnectedChange?: (connected: boolean) => void;
  private channel: Channel<{ session_id: string; data: string }> | null = null;
  private inputStream: TerminalInputStream;
  private isConnected = false;
  private isConnecting = false;
  private isDisposed = false;
  private lastCols = 0;
  private lastRows = 0;

  constructor(options: TerminalSessionOptions) {
    this.tab = options.tab;
    this.onOutput = options.onOutput;
    this.onConnectedChange = options.onConnectedChange;

    this.inputStream = new TerminalInputStream(async (chunk: string) => {
      await this.transmitInput(chunk);
    });
  }

  public updateTab(tab: TerminalTab): void {
    this.tab = tab;
  }

  public getConnected(): boolean {
    return this.isConnected;
  }

  public async connect(cols = 80, rows = 24): Promise<void> {
    if (this.isDisposed || this.isConnected || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    this.lastCols = cols;
    this.lastRows = rows;

    if (!window.__TAURI_INTERNALS__) {
      this.onOutput('\x1b[32m[本地预览模式]\x1b[0m 正在模拟终端连接至 ' + this.tab.title + '\r\n');
      this.onOutput('ANSI 颜色支持测试:\r\n');
      this.onOutput(
        '  \x1b[31m[错误 Red]\x1b[0m  \x1b[32m[成功 Green]\x1b[0m  \x1b[33m[警告 Yellow]\x1b[0m  \x1b[34m[路径 Blue]\x1b[0m  \x1b[35m[标量 Magenta]\x1b[0m  \x1b[36m[信息 Cyan]\x1b[0m\r\n'
      );
      this.onOutput('\x1b[32mroot@' + (this.tab.server?.name || 'local') + '\x1b[0m:\x1b[34m~\x1b[0m# ');

      this.isConnected = true;
      this.isConnecting = false;
      this.onConnectedChange?.(true);
      return;
    }

    try {
      const channel = new Channel<{ session_id: string; data: string }>();
      channel.onmessage = (payload) => {
        if (!this.isDisposed) {
          this.onOutput(payload.data);
        }
      };
      this.channel = channel;

      if (this.tab.isSsh && this.tab.server) {
        this.onOutput(
          `\x1b[90m正在建立 SSH 连接 ${this.tab.server.host}:${this.tab.server.port} (${this.tab.server.username})...\x1b[0m\r\n`
        );

        await invoke('connect_ssh_terminal', {
          sessionId: this.tab.sessionId,
          options: {
            host: this.tab.server.host,
            port: this.tab.server.port,
            username: this.tab.server.username,
            auth_type: this.tab.server.auth_type,
            credential: this.tab.server.credential || null,
            passphrase: this.tab.server.passphrase || null,
            cols,
            rows,
          },
          channel,
        });
      } else {
        await invoke('start_local_terminal', {
          sessionId: this.tab.sessionId,
          cols,
          rows,
          channel,
        });
      }

      this.isConnected = true;
      this.onConnectedChange?.(true);
    } catch (err: any) {
      this.isConnected = false;
      this.onOutput(`\r\n\x1b[31m[连接失败] ${err?.message || err}\x1b[0m\r\n`);
      this.onConnectedChange?.(false);
    } finally {
      this.isConnecting = false;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;
    this.isConnecting = false;
    this.inputStream.clear();

    if (this.channel) {
      this.channel.onmessage = () => {};
      this.channel = null;
    }

    this.onConnectedChange?.(false);
  }

  public async closeBackend(): Promise<void> {
    if (window.__TAURI_INTERNALS__) {
      try {
        await invoke('close_terminal', {
          sessionId: this.tab.sessionId,
          isSsh: this.tab.isSsh,
        });
      } catch (err) {
        console.error('关闭终端会话异常:', err);
      }
    }
  }

  public async retry(cols = 80, rows = 24): Promise<void> {
    await this.disconnect();
    await this.closeBackend();
    // 延迟 80ms 确保底层的网络 socket 与 PTY 进程释放完成
    await new Promise((resolve) => setTimeout(resolve, 80));
    await this.connect(cols, rows);
  }

  public send(data: string): void {
    if (this.isDisposed || !data) return;
    this.inputStream.push(data);
  }

  public async resize(cols: number, rows: number): Promise<void> {
    if (this.isDisposed) return;
    if (cols < 20 || rows < 5) return;
    if (cols === this.lastCols && rows === this.lastRows) return;

    this.lastCols = cols;
    this.lastRows = rows;

    if (window.__TAURI_INTERNALS__ && this.isConnected) {
      try {
        await invoke('resize_terminal', {
          sessionId: this.tab.sessionId,
          isSsh: this.tab.isSsh,
          cols,
          rows,
        });
      } catch (err) {
        console.error('调整终端尺寸异常:', err);
      }
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    this.isConnected = false;
    this.isConnecting = false;
    this.inputStream.dispose();

    if (this.channel) {
      this.channel.onmessage = () => {};
      this.channel = null;
    }
  }

  private async transmitInput(chunk: string): Promise<void> {
    if (this.isDisposed) return;

    // 若会话尚在建立中，等待连接就绪，避免过早输入导致丢字或未找到会话
    if (this.isConnecting) {
      for (let i = 0; i < 40 && this.isConnecting; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    if (!window.__TAURI_INTERNALS__) {
      for (const char of chunk) {
        if (char === '\r') {
          this.onOutput('\r\n\x1b[32mroot@' + (this.tab.server?.name || 'local') + '\x1b[0m:\x1b[34m~\x1b[0m# ');
        } else if (char === '\u007f') {
          this.onOutput('\b \b');
        } else {
          this.onOutput(char);
        }
      }
      return;
    }

    await Promise.race([
      invoke('send_terminal_input', {
        sessionId: this.tab.sessionId,
        isSsh: this.tab.isSsh,
        data: chunk,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('发送终端输入超时')), 3000)
      ),
    ]);
  }
}
