import { invoke, Channel } from '@tauri-apps/api/core';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { SafetyCheckResult, SftpListResult } from '../../types';

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'terminal_exec',
      description:
        '在目标服务器上执行 Linux shell 指令并捕获真实标准输出及错误。注意：创建大型运维脚本必须使用 file_write 写入，再通过本工具授予执行权限并运行；执行部署或变更后必须使用本工具进行状态闭环验证。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '待执行的 Linux shell 指令，如 docker ps、ss -lntp、systemctl status xxx 等',
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
      description:
        '在目标服务器上创建、修改或覆盖指定路径的文件内容（系统会自动创建父级目录）。编写运维脚本、服务管理脚本、配置文件等必须真实调用此工具写入磁盘，严禁仅在回复文本中假装部署！',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目标文件绝对路径，如 /usr/local/bin/workbuddy 或 /home/soft/service.sh',
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
      description: '列出远程服务器指定目录下的所有文件与子目录详情',
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
  args: Record<string, any>,
  onStream?: (chunk: string) => void
): Promise<{ stdout: string; isError?: boolean }> {
  if (!window.__TAURI_INTERNALS__) {
    // 浏览器环境回退
    if (onStream) {
      onStream(`[本地模拟] 执行工具 ${toolName}...\n`);
    }
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

        const channel = new Channel<{ stream: string; data: string }>();
        channel.onmessage = (payload) => {
          if (onStream && payload?.data) {
            onStream(payload.data);
          }
        };

        const res = isLocal
          ? await invoke<{
              exit_code: number;
              stdout: string;
              stderr: string;
              duration_ms: number;
            }>('exec_local_command', {
              command: cmd,
              channel,
            })
          : await invoke<{
              exit_code: number;
              stdout: string;
              stderr: string;
              duration_ms: number;
            }>('ssh_exec_command', {
              sessionId,
              command: cmd,
              channel,
            });

        if (res.exit_code === 0) {
          return { stdout: res.stdout || '(命令执行成功，无额外输出)' };
        } else {
          return {
            stdout: `退出码 ${res.exit_code}\n${res.stdout ? `标准输出:\n${res.stdout}\n` : ''}${res.stderr ? `错误输出:\n${res.stderr}` : ''}`,
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
