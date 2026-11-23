import { stripAnsi } from '../agent/summary';

export interface PtyBridgeHandle {
  sendInput: (data: string) => void;
  getRecentScreenText: (maxLines?: number) => string;
  subscribeOutput: (listener: (chunk: string) => void) => () => void;
  isWindowsLocal?: boolean;
}

const bridges = new Map<string, PtyBridgeHandle>();

export function registerPtyBridge(sessionId: string, handle: PtyBridgeHandle): void {
  bridges.set(sessionId, handle);
}

export function unregisterPtyBridge(sessionId: string): void {
  bridges.delete(sessionId);
}

export function getPtyBridge(sessionId: string): PtyBridgeHandle | undefined {
  return bridges.get(sessionId);
}

/** 向指定活动终端发送文本/命令（供 SFTP 联动、快捷命令库、广播输入使用） */
export function sendToTerminal(sessionId: string, text: string): boolean {
  const bridge = bridges.get(sessionId);
  if (!bridge) return false;
  bridge.sendInput(text);
  return true;
}

/** 获取指定终端当前屏幕及滚动区末尾 N 行纯文本快照 */
export function getTerminalSnapshot(sessionId: string, maxLines = 45): string {
  const bridge = bridges.get(sessionId);
  if (!bridge) return '';
  return bridge.getRecentScreenText(maxLines);
}

/**
 * 在当前交互式 PTY 中直接执行命令并采集完整输出与退出码
 * 天然继承用户在终端内已执行的 su / sudo -i / cd / export / venv / docker exec / 跳板机上下文
 */
export function runCommandInInteractivePty(
  sessionId: string,
  command: string,
  onStream?: (chunk: string) => void,
  timeoutMs = 90000
): Promise<{ exitCode: number; stdout: string }> {
  const bridge = bridges.get(sessionId);
  if (!bridge) {
    return Promise.reject(new Error('当前交互式终端未就绪，无法在 PTY 中内联执行'));
  }

  return new Promise((resolve) => {
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const startMarker = `__TINI_BEGIN_${token}__`;
    const endPrefix = `__TINI_END_${token}__:`;

    let rawBuffer = '';
    let started = false;
    let settled = false;
    let emittedLen = 0;

    const cleanup = (unsubscribe: () => void, timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer);
      unsubscribe();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      const cleaned = stripAnsi(rawBuffer).replace(/\r/g, '');
      resolve({
        exitCode: -1,
        stdout: `${cleaned}\n[终端内联命令等待结束标记超时 (${Math.round(timeoutMs / 1000)}s)，请检查终端是否停留在交互密码或阻塞状态]`,
      });
    }, timeoutMs);

    const unsubscribe = bridge.subscribeOutput((chunk) => {
      if (settled) return;
      rawBuffer += chunk;
      const clean = stripAnsi(rawBuffer).replace(/\r\n?/g, '\n');

      // 跳过命令回显行，寻找独立输出的起始标记行
      if (!started) {
        const startRe = new RegExp(`(?:^|\\n)${startMarker}\\n`);
        const m = startRe.exec(clean);
        if (!m) return;
        started = true;
        emittedLen = m.index + m[0].length;
      }

      const body = clean.slice(emittedLen);
      const endRe = new RegExp(`(?:^|\\n)${endPrefix}(-?\\d+)\\b`);
      const endMatch = endRe.exec(body);

      if (endMatch) {
        settled = true;
        cleanup(unsubscribe, timer);
        const output = body.slice(0, endMatch.index).trimEnd();
        const exitCode = parseInt(endMatch[1], 10);
        if (onStream && output.length > 0) {
          // 补发尚未流出的尾部
          onStream('');
        }
        resolve({ exitCode: Number.isNaN(exitCode) ? 0 : exitCode, stdout: output });
      } else if (onStream) {
        // 避免把尚未收齐的结束标记前缀提前流式输出
        const safeCut = Math.max(0, body.length - endPrefix.length - 8);
        if (safeCut > 0) {
          const piece = body.slice(0, safeCut);
          emittedLen += safeCut;
          onStream(piece);
        }
      }
    });

    // 区分 Windows PowerShell 与 POSIX Shell 的标记打印语法
    const wrapped = bridge.isWindowsLocal
      ? `Write-Output "${startMarker}"; ${command}; $tini_ec = if ($?) { if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }; Write-Output "${endPrefix}$tini_ec"\r`
      : ` printf '\\n%s\\n' '${startMarker}'; ${command}; __tini_ec=$?; printf '\\n%s%d\\n' '${endPrefix}' "$__tini_ec"\n`;

    bridge.sendInput(wrapped);
  });
}
