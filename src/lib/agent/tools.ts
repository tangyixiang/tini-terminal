import { invoke, Channel } from '@tauri-apps/api/core';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { isWindowsPlatform } from '../platform';
import { runCommandInInteractivePty } from '../terminal/ptyBridge';
import type { SafetyCheckResult, SafetyLevel, SessionContext, SftpListResult } from '../../types';
import { formatCommandExitOutput, isDiagnosticCommand } from './commandUtils';

export { isDiagnosticCommand };

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'terminal_exec',
      description:
        '在目标主机或本地终端执行 Shell 指令并获取真实标准输出与退出码。编写脚本/配置文件请优先用 file_write，再通过本工具运行与闭环验证。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '待执行的 Shell 指令，如 docker ps、ss -lntp、systemctl status xxx 等',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: '读取目标主机或本地指定路径的文本文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件绝对路径，如 /etc/nginx/nginx.conf',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_write',
      description:
        '在目标主机或本地创建、修改或覆盖指定路径的文件内容（自动创建父级目录）。写脚本、配置文件必须真实调用此工具写入磁盘。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目标文件绝对路径，如 /usr/local/bin/deploy.sh',
          },
          content: {
            type: 'string',
            description: '完整文件内容',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_list',
      description: '列出目标主机或本地指定目录下的所有文件与子目录详情',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目标目录绝对路径，如 /var/log',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: '快速收集目标主机或本机的 OS 版本、内核、运行时间、CPU 与内存基本信息',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

async function fetchSessionContext(sessionId: string): Promise<SessionContext | null> {
  if (!window.__TAURI_INTERNALS__) return null;
  try {
    return await invoke<SessionContext | null>('get_session_context', { sessionId });
  } catch {
    return null;
  }
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export async function executeToolCall(
  sessionId: string,
  toolName: string,
  args: Record<string, any>,
  onStream?: (chunk: string) => void
): Promise<{ stdout: string; isError?: boolean }> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      stdout: '未检测到原生运行时环境，无法执行终端与文件工具',
      isError: true,
    };
  }

  const resolveTarget = (): { isLocal: boolean; loginUser?: string } | { error: string } => {
    const currentTab = useTerminalStore
      .getState()
      .tabs.find((t) => t.sessionId === sessionId || t.id === sessionId);
    if (!currentTab) {
      return { error: `未找到终端会话 ${sessionId}，请确认标签页仍然存在` };
    }
    return { isLocal: !currentTab.isSsh, loginUser: currentTab.server?.username };
  };

  try {
    switch (toolName) {
      case 'terminal_exec': {
        const cmd = String(args.command || '');
        const target = resolveTarget();
        if ('error' in target) {
          return { stdout: target.error, isError: true };
        }

        const execMode = useAgentStore.getState().executionMode;

        // 终端内联 PTY 模式：直接写入用户当前交互式 Shell，100% 继承 su / sudo -i / cd / env / 跳板机上下文
        if (execMode === 'pty') {
          const ptyRes = await runCommandInInteractivePty(sessionId, cmd, onStream);
          if (ptyRes.exitCode === 0) {
            return { stdout: ptyRes.stdout || '(命令执行成功，无额外输出)' };
          }
          const isDiag = isDiagnosticCommand(cmd);
          return {
            stdout: formatCommandExitOutput(ptyRes.exitCode, ptyRes.stdout, '', isDiag),
            isError: !isDiag,
          };
        }

        // 隔离 Exec 模式：自动携带当前终端追踪到的 cwd，减少目录割裂感
        const ctx = await fetchSessionContext(sessionId);
        const channel = new Channel<{ stream: string; data: string }>();
        channel.onmessage = (payload) => {
          if (onStream && payload?.data) {
            onStream(payload.data);
          }
        };

        let res: { exit_code: number; stdout: string; stderr: string; duration_ms: number };
        if (target.isLocal) {
          res = await invoke('exec_local_command', {
            command: cmd,
            cwd: ctx?.cwd || null,
            channel,
          });
        } else {
          // 若当前终端目录已知（非空且为合法 POSIX 路径），先 cd 再执行，保持目录一致
          const effectiveCmd =
            ctx?.cwd && ctx.cwd.startsWith('/')
              ? `cd ${shellQuote(ctx.cwd)} 2>/dev/null || true; ${cmd}`
              : cmd;
          res = await invoke('ssh_exec_command', {
            sessionId,
            command: effectiveCmd,
            channel,
          });
        }

        if (res.exit_code === 0) {
          return { stdout: res.stdout || '(命令执行成功，无额外输出)' };
        }
        const isDiag = isDiagnosticCommand(cmd);
        return {
          stdout: formatCommandExitOutput(res.exit_code, res.stdout, res.stderr, isDiag),
          isError: !isDiag,
        };
      }

      case 'file_read': {
        const path = String(args.path || '');
        const target = resolveTarget();
        if ('error' in target) {
          return { stdout: target.error, isError: true };
        }
        const content = target.isLocal
          ? await invoke<string>('local_read_file', { path })
          : await invoke<string>('sftp_read_file', { sessionId, remotePath: path });
        return { stdout: content };
      }

      case 'file_write': {
        const path = String(args.path || '');
        const content = String(args.content ?? '');
        const target = resolveTarget();
        if ('error' in target) {
          return { stdout: target.error, isError: true };
        }
        if (target.isLocal) {
          await invoke('local_write_file', { path, content });
        } else {
          await invoke('sftp_write_file', { sessionId, remotePath: path, content });
        }
        return { stdout: `文件写入成功: ${path}` };
      }

      case 'file_list': {
        const path = String(args.path || '');
        const target = resolveTarget();
        if ('error' in target) {
          return { stdout: target.error, isError: true };
        }
        const res = target.isLocal
          ? await invoke<SftpListResult>('local_list_dir', { path })
          : await invoke<SftpListResult>('sftp_list_dir', { sessionId, remotePath: path });
        const formatted = (res.files || [])
          .map(
            (item) =>
              `${item.is_dir ? '[DIR]' : '[FILE]'} ${item.name.padEnd(25)} ${item.size} 字节`
          )
          .join('\n');
        return { stdout: formatted || '(空目录)' };
      }

      case 'system_info': {
        const target = resolveTarget();
        if ('error' in target) {
          return { stdout: target.error, isError: true };
        }

        // 按操作系统区分本机信息采集指令（修复 Windows 本地终端运行 uname/free 必报错问题）
        const isWinLocal = target.isLocal && isWindowsPlatform();
        const cmd = isWinLocal
          ? '$os = Get-CimInstance Win32_OperatingSystem; $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; "OS: $($os.Caption) ($($os.Version))"; "CPU: $($cpu.Name) ($($cpu.NumberOfLogicalProcessors) threads)"; "Memory: Free $([math]::Round($os.FreePhysicalMemory/1MB,2)) GB / Total $([math]::Round($os.TotalVisibleMemorySize/1MB,2)) GB"; "LastBoot: $($os.LastBootUpTime)"'
          : 'uname -a && uptime && (free -m 2>/dev/null || vm_stat 2>/dev/null || top -l 1 | head -n 10)';

        const channel = new Channel<{ stream: string; data: string }>();
        channel.onmessage = (payload) => {
          if (onStream && payload?.data) {
            onStream(payload.data);
          }
        };

        const res = target.isLocal
          ? await invoke<{ exit_code: number; stdout: string; stderr: string }>(
              'exec_local_command',
              { command: cmd, cwd: null, channel }
            )
          : await invoke<{ exit_code: number; stdout: string; stderr: string }>(
              'ssh_exec_command',
              { sessionId, command: cmd, channel }
            );

        if (res.exit_code !== 0) {
          return {
            stdout: formatCommandExitOutput(res.exit_code, res.stdout, res.stderr, false),
            isError: true,
          };
        }
        return { stdout: res.stdout || '(系统信息输出为空)' };
      }

      default:
        return { stdout: `未知工具: ${toolName}`, isError: true };
    }
  } catch (e: any) {
    return { stdout: `工具执行异常: ${e?.message || e}`, isError: true };
  }
}

export async function checkSafety(
  command: string,
  dangerLevel: SafetyLevel = 'high'
): Promise<SafetyCheckResult> {
  if (window.__TAURI_INTERNALS__) {
    return await invoke<SafetyCheckResult>('check_command_safety', {
      command,
      dangerLevel,
    });
  }

  const isDanger = /rm\s+-[rfRF]{1,4}\s+(\/|\/\*)/.test(command);
  return {
    is_dangerous: isDanger,
    risk_level: isDanger ? 'dangerous' : 'safe',
    command,
    message: isDanger ? '检测到高危递归删除指令' : '命令合规',
  };
}
