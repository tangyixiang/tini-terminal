import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { SafetyCheckResult, SftpListResult } from '../../types';

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'terminal_exec',
      description: '在目标服务器上执行 Shell 命令并捕获输出结果。注意：高危命令将触发用户授权弹窗。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '待执行的 Linux shell 指令，如 systemctl status nginx、ss -lntp、df -h 等',
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
      description: '读取远程服务器指定路径的文本文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '远程文件绝对路径，如 /etc/nginx/nginx.conf',
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
      description: '修改或覆盖远程服务器指定路径的文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目标文件路径',
          },
          content: {
            type: 'string',
            description: '新的文件完整内容',
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
      description: '列出远程服务器指定目录下的所有文件与子目录',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目标目录路径，如 /var/log',
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
      description: '快速收集远程主机的 OS 版本、内核、运行时间、CPU 与内存基本信息',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

export async function executeToolCall(
  sessionId: string,
  toolName: string,
  args: Record<string, any>
): Promise<{ stdout: string; isError?: boolean }> {
  if (!window.__TAURI_INTERNALS__) {
    // 浏览器环境回退
    return {
      stdout: `[开发环境测试] 执行工具 ${toolName}，参数: ${JSON.stringify(args)}`,
    };
  }

  try {
    switch (toolName) {
      case 'terminal_exec': {
        const cmd = args.command as string;
        const tabs = useTerminalStore.getState().tabs;
        const currentTab = tabs.find((t) => t.sessionId === sessionId || t.id === sessionId);
        const isLocal = currentTab ? !currentTab.isSsh : (!sessionId || sessionId.startsWith('local'));
        const res = isLocal
          ? await invoke<{
              exit_code: number;
              stdout: string;
              stderr: string;
              duration_ms: number;
            }>('exec_local_command', {
              command: cmd,
            })
          : await invoke<{
              exit_code: number;
              stdout: string;
              stderr: string;
              duration_ms: number;
            }>('ssh_exec_command', {
              sessionId,
              command: cmd,
            });

        if (res.exit_code === 0) {
          return { stdout: res.stdout || '(命令执行成功，无额外输出)' };
        } else {
          return {
            stdout: `退出码 ${res.exit_code}\n标准输出: ${res.stdout}\n错误输出: ${res.stderr}`,
            isError: true,
          };
        }
      }

      case 'file_read': {
        const path = args.path as string;
        const content = await invoke<string>('sftp_read_file', {
          sessionId,
          remotePath: path,
        });
        return { stdout: content };
      }

      case 'file_write': {
        const path = args.path as string;
        const content = args.content as string;
        await invoke('sftp_write_file', {
          sessionId,
          remotePath: path,
          content,
        });
        return { stdout: `文件写入成功: ${path}` };
      }

      case 'file_list': {
        const path = args.path as string;
        const res = await invoke<SftpListResult>('sftp_list_dir', {
          sessionId,
          remotePath: path,
        });
        const formatted = (res.files || [])
          .map(
            (item) =>
              `${item.is_dir ? '[DIR]' : '[FILE]'} ${item.name.padEnd(25)} ${item.size} 字节`
          )
          .join('\n');
        return { stdout: formatted || '(空目录)' };
      }

      case 'system_info': {
        const tabs = useTerminalStore.getState().tabs;
        const currentTab = tabs.find((t) => t.sessionId === sessionId || t.id === sessionId);
        const isLocal = currentTab ? !currentTab.isSsh : (!sessionId || sessionId.startsWith('local'));
        const cmd = 'uname -a && uptime && (free -m 2>/dev/null || top -l 1 | head -n 10)';
        const res = isLocal
          ? await invoke<{ stdout: string }>('exec_local_command', { command: cmd })
          : await invoke<{ stdout: string }>('ssh_exec_command', {
              sessionId,
              command: cmd,
            });
        return { stdout: res.stdout };
      }

      default:
        return { stdout: `未知工具: ${toolName}`, isError: true };
    }
  } catch (e: any) {
    return { stdout: `工具执行异常: ${e?.message || e}`, isError: true };
  }
}

export async function checkSafety(command: string): Promise<SafetyCheckResult> {
  if (window.__TAURI_INTERNALS__) {
    return await invoke<SafetyCheckResult>('check_command_safety', { command });
  }

  const isDanger = /rm\s+-[rfRF]{1,4}\s+(\/|\/\*)/.test(command);
  return {
    is_dangerous: isDanger,
    risk_level: isDanger ? 'dangerous' : 'safe',
    command,
    message: isDanger ? '检测到高危递归删除指令' : '命令合规',
  };
}
