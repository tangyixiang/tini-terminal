export type SendTerminalInputFn = (data: string) => Promise<void>;

export class TerminalInputStream {
  private queue: string[] = [];
  private isFlushing = false;
  private isDisposed = false;
  private sendFn: SendTerminalInputFn;
  private onError?: (err: Error) => void;

  constructor(sendFn: SendTerminalInputFn, onError?: (err: Error) => void) {
    this.sendFn = sendFn;
    this.onError = onError;
  }

  public push(data: string): void {
    if (this.isDisposed || !data) return;
    this.queue.push(data);
    this.flush();
  }

  public async flush(): Promise<void> {
    if (this.isFlushing || this.isDisposed || this.queue.length === 0) {
      return;
    }

    this.isFlushing = true;

    try {
      while (this.queue.length > 0 && !this.isDisposed) {
        const chunk = this.queue.join('');
        this.queue = [];
        await this.sendFn(chunk);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('发送终端输入异常:', error);
      this.onError?.(error);
    } finally {
      this.isFlushing = false;
      if (this.queue.length > 0 && !this.isDisposed) {
        this.flush();
      }
    }
  }

  public clear(): void {
    this.queue = [];
  }

  public dispose(): void {
    this.isDisposed = true;
    this.queue = [];
  }
}
