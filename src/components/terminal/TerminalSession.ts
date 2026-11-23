import { invoke, Channel } from '@tauri-apps/api/core';
import type { TerminalTab } from '../../types';
import { TerminalInputStream } from './TerminalInputStream';

export interface TerminalSessionOptions {
  tab: TerminalTab;
  onOutput: (data: string) => void;
  onConnectedChange?: (connected: boolean) => void;
  onLatencyChange?: (latencyMs: number | null) => void;
  onInputError?: (err: Error) => void;
}

interface TerminalChannelPayload {
  session_id: string;
  data: string;
  closed?: boolean;
  latency_ms?: number | null;
  generation?: number;
}

interface SshConnectResult {
  latency_ms: number;
  generation: number;
}

export class TerminalSession {
  private tab: TerminalTab;
  private onOutput: (data: string) => void;
  private onConnectedChange?: (connected: boolean) => void;
  private onLatencyChange?: (latencyMs: number | null) => void;
  private onInputError?: (err: Error) => void;
  private channel: Channel<TerminalChannelPayload> | null = null;
  private inputStream: TerminalInputStream;
  private outputListeners = new Set<(chunk: string) => void>();
  private isConnected = false;
  private isConnecting = false;
  private isDisposed = false;
  private currentGeneration = 0;
  private lastCols = 0;
  private lastRows = 0;
  private pendingSize: { cols: number; rows: number } | null = null;
  private isResizing = false;

  constructor(options: TerminalSessionOptions) {
    this.tab = options.tab;
    this.onOutput = options.onOutput;
    this.onConnectedChange = options.onConnectedChange;
    this.onLatencyChange = options.onLatencyChange;
    this.onInputError = options.onInputError;

    this.inputStream = new TerminalInputStream(
      async (chunk: string) => {
        await this.transmitInput(chunk);
      },
      (err) => {
        const msg = err.message || '';
        if (
          msg.includes('未找到') ||
          msg.includes('已关闭') ||
          msg.includes('not found') ||
          msg.includes('closed')
        ) {
          this.isConnected = false;
          this.onConnectedChange?.(false);
        }
        this.onInputError?.(err);
      }
    );
  }

  public updateTab(tab: TerminalTab): void {
    this.tab = tab;
  }

  public getConnected(): boolean {
    return this.isConnected;
  }

  public getGeneration(): number {
    return this.currentGeneration;
  }

  public subscribeOutput(listener: (chunk: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  public async connect(cols = 80, rows = 24): Promise<void> {
    if (this.isDisposed || this.isConnected || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    this.lastCols = cols;
    this.lastRows = rows;

    if (!window.__TAURI_INTERNALS__) {
      this.isConnecting = false;
      this.isConnected = false;
      this.onOutput('\x1b[31m[环境异常]\x1b[0m 未检测到桌面端原生运行时，无法创建 PTY/SSH 终端通道。\r\n');
      this.onConnectedChange?.(false);
      return;
    }

    try {
      const channel = new Channel<TerminalChannelPayload>();
      let boundGeneration = 0;

      channel.onmessage = (payload) => {
        if (this.isDisposed) return;
        // 隔离旧代次会话的延迟事件，防止误将新连接置为断开
        if (
          typeof payload.generation === 'number' &&
          payload.generation > 0 &&
          boundGeneration > 0 &&
          payload.generation !== boundGeneration
        ) {
          return;
        }
        if (payload.data) {
          this.onOutput(payload.data);
          for (const listener of this.outputListeners) {
            try {
              listener(payload.data);
            } catch {}
          }
        }
        if (payload.closed) {
          this.isConnected = false;
          this.onConnectedChange?.(false);
          this.onLatencyChange?.(null);
        }
      };
      this.channel = channel;

      if (this.tab.isSsh && this.tab.server) {
        this.onOutput(
          `\x1b[90m正在建立 SSH 连接 ${this.tab.server.host}:${this.tab.server.port} (${this.tab.server.username})...\x1b[0m\r\n`
        );

        const result = await invoke<SshConnectResult | number>('connect_ssh_terminal', {
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

        if (typeof result === 'object' && result !== null) {
          boundGeneration = result.generation || 0;
          this.currentGeneration = boundGeneration;
          this.onLatencyChange?.(typeof result.latency_ms === 'number' ? result.latency_ms : null);
        } else {
          this.onLatencyChange?.(typeof result === 'number' ? result : null);
        }
      } else {
        const gen = await invoke<number>('start_local_terminal', {
          sessionId: this.tab.sessionId,
          cols,
          rows,
          channel,
        });
        boundGeneration = typeof gen === 'number' ? gen : 0;
        this.currentGeneration = boundGeneration;
        this.onLatencyChange?.(0);
      }

      this.isConnected = true;
      this.onConnectedChange?.(true);
    } catch (err: any) {
      this.isConnected = false;
      this.onOutput(`\r\n\x1b[31m[连接失败] ${err?.message || err}\x1b[0m\r\n`);
      this.onConnectedChange?.(false);
      this.onLatencyChange?.(null);
    } finally {
      this.isConnecting = false;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;
    this.isConnecting = false;
    this.pendingSize = null;
    this.lastCols = 0;
    this.lastRows = 0;
    this.inputStream.clear();

    if (this.channel) {
      this.channel.onmessage = () => {};
      this.channel = null;
    }

    this.onConnectedChange?.(false);
    this.onLatencyChange?.(null);
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

    if (!window.__TAURI_INTERNALS__ || !this.isConnected) return;

    this.pendingSize = { cols, rows };
    if (this.isResizing) return;

    this.isResizing = true;
    try {
      while (this.pendingSize && !this.isDisposed) {
        const target = this.pendingSize;
        this.pendingSize = null;
        try {
          await invoke('resize_terminal', {
            sessionId: this.tab.sessionId,
            isSsh: this.tab.isSsh,
            cols: target.cols,
            rows: target.rows,
          });
        } catch (err) {
          console.error('调整终端尺寸异常:', err);
        }
      }
    } finally {
      this.isResizing = false;
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    this.isConnected = false;
    this.isConnecting = false;
    this.outputListeners.clear();
    this.inputStream.dispose();

    if (this.channel) {
      this.channel.onmessage = () => {};
      this.channel = null;
    }
  }

  private async transmitInput(chunk: string): Promise<void> {
    if (this.isDisposed) return;

    if (this.isConnecting) {
      for (let i = 0; i < 40 && this.isConnecting; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    if (!window.__TAURI_INTERNALS__) return;

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
