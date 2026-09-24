import { invoke } from '@tauri-apps/api/core';
import type { SafetyCheckResult } from '../../types';

export const WORKSPACE_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'host_exec',
      description:
        '在指定主机上执行 Linux shell 指令并捕获真实标准输出及错误。注意：创建大型运维脚本必须使用 host_file_write 写入，再通过本工具授予执行权限并运行；执行部署或变更后必须使用本工具进行状态闭环验证。',
      parameters: {
        type: 'object',
        properties: {
          host_id: {
            type: 'string',
            description: '目标主机唯一标识（ID 或主机名称）',
          },
          command: {
            type: 'string',
            description: '待执行的 Linux shell 指令，如 docker ps、ss -lntp、systemctl status xxx 等',
          },
        },
        required: ['host_id', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_file_read',
      description: '读取指定主机上的文本文件或配置文件内容',
      parameters: {
        type: 'object',
        properties: {
          host_id: {
            type: 'string',
            description: '目标主机唯一标识（ID 或主机名称）',
          },
          path: {
            type: 'string',
            description: '目标文件绝对路径，如 /etc/nginx/nginx.conf',
          },
        },
        required: ['host_id', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_file_write',
      description:
        '在目标主机上创建、修改或覆盖指定路径的文件内容（系统会自动创建父级目录）。编写运维脚本、服务管理脚本、配置文件等必须真实调用此工具写入磁盘。',
      parameters: {
        type: 'object',
        properties: {
          host_id: {
            type: 'string',
            description: '目标主机唯一标识（ID 或主机名称）',
          },
          path: {
            type: 'string',
            description: '目标文件绝对路径，如 /usr/local/bin/deploy.sh 或 /etc/nginx/nginx.conf',
          },
          content: {
            type: 'string',
            description: '完整文件内容',
          },
        },
        required: ['host_id', 'path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_system_info',
      description: '快速收集指定主机的 OS 版本、内核、运行时间、CPU 与内存基本信息',
      parameters: {
        type: 'object',
        properties: {
          host_id: {
            type: 'string',
            description: '目标主机唯一标识（ID 或主机名称）',
          },
        },
        required: ['host_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_transfer',
      description: '跨主机传输文件：从源主机读取文件并同步写入目标主机指定路径',
      parameters: {
        type: 'object',
        properties: {
          src_host_id: {
            type: 'string',
            description: '源主机唯一标识（ID 或主机名称）',
          },
          src_path: {
            type: 'string',
            description: '源文件绝对路径',
          },
          dst_host_id: {
            type: 'string',
            description: '目标主机唯一标识（ID 或主机名称）',
          },
          dst_path: {
            type: 'string',
            description: '目标文件绝对路径',
          },
        },
        required: ['src_host_id', 'src_path', 'dst_host_id', 'dst_path'],
      },
    },
  },
];

export async function executeWorkspaceToolCall(
  toolName: string,
  args: Record<string, any>,
  onStream?: (chunk: string) => void
): Promise<{ stdout: string; isError?: boolean }> {
  if (!window.__TAURI_INTERNALS__) {
    if (onStream) {
      onStream(`[测试环境] 执行多机工具 ${toolName}...\n`);
    }
    return {
      stdout: `[开发环境测试] 执行多机工具 ${toolName}，参数: ${JSON.stringify(args)}`,
    };
  }

  try {
    switch (toolName) {
      case 'host_exec': {
        const hostId = args.host_id as string;
        const cmd = args.command as string;
        const res = await invoke<{
          exit_code: number;
          stdout: string;
          stderr: string;
          duration_ms: number;
        }>('execute_host_command', {
          hostId,
          command: cmd,
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

      case 'host_file_read': {
        const hostId = args.host_id as string;
        const path = args.path as string;
        const content = await invoke<string>('execute_host_file_read', {
          hostId,
          filePath: path,
        });
        return { stdout: content };
      }

      case 'host_file_write': {
        const hostId = args.host_id as string;
        const path = args.path as string;
        const content = args.content as string;
        await invoke('execute_host_file_write', {
          hostId,
          filePath: path,
          content,
        });
        return { stdout: `主机 [${hostId}] 写入文件成功: ${path} (大小: ${content.length} 字节)` };
      }

      case 'host_system_info': {
        const hostId = args.host_id as string;
        const cmd = 'uname -a && uptime && (free -m 2>/dev/null || vm_stat 2>/dev/null || top -l 1 | head -n 10)';
        const res = await invoke<{
          exit_code: number;
          stdout: string;
          stderr: string;
        }>('execute_host_command', {
          hostId,
          command: cmd,
        });
        return { stdout: res.stdout || res.stderr };
      }

      case 'host_transfer': {
        const srcHost = args.src_host_id as string;
        const srcPath = args.src_path as string;
        const dstHost = args.dst_host_id as string;
        const dstPath = args.dst_path as string;

        // 1. 从源主机读取
        const content = await invoke<string>('execute_host_file_read', {
          hostId: srcHost,
          filePath: srcPath,
        });

        // 2. 写入目标主机
        await invoke('execute_host_file_write', {
          hostId: dstHost,
          filePath: dstPath,
          content,
        });

        return {
          stdout: `跨主机传输完成: 从 [${srcHost}] ${srcPath} 读取并写入 [${dstHost}] ${dstPath} (共 ${content.length} 字节)`,
        };
      }

      default:
        return { stdout: `未知多机工具: ${toolName}`, isError: true };
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
