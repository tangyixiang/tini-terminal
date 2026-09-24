import React, { useState, useEffect } from 'react';
import {
  Play,
  ChevronDown,
  ChevronRight,
  Layers,
} from 'lucide-react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';

export const WorkspaceAgentView: React.FC = () => {
  const {
    workspaces,
    activeWorkspaceId,
    selectedHostIds,
    tasks,
    isExecutingTask,
    fetchWorkspaces,
    runTask,
  } = useWorkspaceStore();

  const { themeId } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const [inputCommand, setInputCommand] = useState('');
  const [inputPrompt, setInputPrompt] = useState('');
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  const handleRunTask = async () => {
    const wsId = activeWorkspaceId || workspaces[0]?.id || 'default';
    const prompt = inputPrompt.trim() || '多机运维任务调度';
    const cmd = inputCommand.trim();
    if (!cmd || isExecutingTask) return;
    if (selectedHostIds.length === 0) {
      alert('请在左侧侧边栏至少勾选一台目标主机');
      return;
    }

    try {
      await runTask(wsId, prompt, selectedHostIds, cmd);
      setInputCommand('');
      setInputPrompt('');
    } catch (err: any) {
      alert('执行多机任务失败: ' + (err?.message || err));
    }
  };

  const toggleStepLog = (stepId: string) => {
    setExpandedSteps((prev) => ({
      ...prev,
      [stepId]: !prev[stepId],
    }));
  };

  // 快捷模版点击
  const applyTemplate = (promptText: string, cmdText: string) => {
    setInputPrompt(promptText);
    setInputCommand(cmdText);
  };

  return (
    <section
      className="flex-1 flex flex-col overflow-hidden relative font-sans text-xs select-none transition-colors duration-200"
      style={{
        backgroundColor: currentTheme.ui.appBg,
        color: currentTheme.ui.text,
      }}
    >
      {/* 顶部任务看板头部 */}
      <div
        className="h-10 px-4 border-b flex items-center justify-between shrink-0"
        style={{
          backgroundColor: currentTheme.ui.headerBg,
          borderColor: currentTheme.ui.border,
        }}
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold text-xs">
            运维工作区
          </span>
          <span className="opacity-30">|</span>
          <span
            className="text-xs font-mono font-semibold"
            style={{ color: currentTheme.ui.accent }}
          >
            目标主机: {selectedHostIds.length} 台已就绪
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono">
          <span
            className="px-2 py-0.5 rounded border"
            style={{
              backgroundColor: currentTheme.ui.cardBg,
              borderColor: currentTheme.ui.border,
            }}
          >
            历史任务数: {tasks.length}
          </span>
        </div>
      </div>

      {/* 任务流与执行卡片列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tasks.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center opacity-40 space-y-3">
            <Layers className="w-12 h-12 stroke-[1.2]" />
            <div className="text-center">
              <p className="font-medium text-sm">暂无多机执行记录</p>
              <p className="text-xs mt-1">
                在下方输入 Shell 指令或选择模版，并发调度集群运维任务
              </p>
            </div>
          </div>
        ) : (
          tasks.map((task) => {
            const isCompleted = task.status === 'Completed';
            const isFailed = task.status === 'Failed';
            const isRunning = task.status === 'Running';

            return (
              <div
                key={task.id}
                className="rounded-lg border p-3 font-mono space-y-3 transition-colors"
                style={{
                  backgroundColor: currentTheme.ui.cardBg,
                  borderColor: currentTheme.ui.border,
                }}
              >
                {/* 任务头 */}
                <div
                  className="flex items-center justify-between pb-2 border-b"
                  style={{ borderColor: currentTheme.ui.border }}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-xs">
                      {task.prompt}
                    </span>
                    <span className="text-[10px] opacity-50">
                      {new Date(task.created_at).toLocaleTimeString()}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {isRunning && (
                      <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[11px] font-semibold animate-pulse">
                        执行中...
                      </span>
                    )}
                    {isCompleted && (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[11px] font-semibold">
                        执行完成
                      </span>
                    )}
                    {isFailed && (
                      <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-[11px] font-semibold">
                        执行异常
                      </span>
                    )}
                  </div>
                </div>

                {/* 总结摘要 */}
                {task.summary && (
                  <div className="text-gray-300 text-[11px] bg-black/30 p-2 rounded">
                    {task.summary}
                  </div>
                )}

                {/* 各节点并发执行矩阵 */}
                <div className="space-y-1.5">
                  <div className="text-[11px] text-gray-400 font-semibold mb-1">
                    各节点执行详情 ({task.steps.length} 节点):
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {task.steps.map((step) => {
                      const isStepOk = step.exit_code === 0;
                      const isExpanded = !!expandedSteps[step.id];

                      return (
                        <div
                          key={step.id}
                          className={`p-2 rounded border text-[11px] flex flex-col justify-between ${
                            isStepOk
                              ? 'border-emerald-500/30 bg-emerald-500/5'
                              : 'border-red-500/30 bg-red-500/5'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between font-bold">
                              <span className="truncate">{step.host_name}</span>
                              <span
                                className={`px-1.5 py-0.2 rounded text-[10px] ${
                                  isStepOk
                                    ? 'bg-emerald-500/20 text-emerald-400'
                                    : 'bg-red-500/20 text-red-400'
                                }`}
                              >
                                码: {step.exit_code ?? -1} ({step.duration_ms}ms)
                              </span>
                            </div>
                            <div className="mt-1 text-gray-400 truncate">
                              命令: <code className="text-amber-300">{step.command}</code>
                            </div>
                          </div>

                          <div className="mt-2 pt-1 border-t border-white/5 flex justify-end">
                            <button
                              onClick={() => toggleStepLog(step.id)}
                              className="text-[10px] text-emerald-400 hover:underline cursor-pointer flex items-center gap-0.5"
                            >
                              {isExpanded ? '收起日志' : '查看日志'}
                              {isExpanded ? (
                                <ChevronDown className="w-3 h-3" />
                              ) : (
                                <ChevronRight className="w-3 h-3" />
                              )}
                            </button>
                          </div>

                          {/* 日志展开 */}
                          {isExpanded && (
                            <div className="mt-1.5 p-1.5 rounded bg-black/60 font-terminal text-[10px] text-gray-300 max-h-32 overflow-y-auto whitespace-pre-wrap select-text">
                              {step.stdout && <div>{step.stdout}</div>}
                              {step.stderr && (
                                <div className="text-red-400 mt-1">{step.stderr}</div>
                              )}
                              {!step.stdout && !step.stderr && (
                                <div className="text-gray-500">无额外输出</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 底部任务发布与输入控制栏 */}
      <div
        className="p-3 border-t shrink-0 space-y-2"
        style={{
          backgroundColor: currentTheme.ui.cardBg,
          borderColor: currentTheme.ui.border,
        }}
      >
        {/* 快捷任务模版 */}
        <div className="flex items-center gap-2 text-[11px] font-mono overflow-x-auto no-scrollbar">
          <span className="text-gray-400 shrink-0">快捷模版:</span>
          <button
            onClick={() => applyTemplate('多机服务端口巡检', 'ss -lntp')}
            className="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5 text-gray-300 cursor-pointer shrink-0"
          >
            端口占用 (ss -lntp)
          </button>
          <button
            onClick={() => applyTemplate('多机磁盘容量分析', 'df -h')}
            className="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5 text-gray-300 cursor-pointer shrink-0"
          >
            磁盘空间 (df -h)
          </button>
          <button
            onClick={() => applyTemplate('多机内存状态巡检', 'free -m')}
            className="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5 text-gray-300 cursor-pointer shrink-0"
          >
            内存占用 (free -m)
          </button>
          <button
            onClick={() =>
              applyTemplate('多机 Nginx 状态检查', 'systemctl status nginx')
            }
            className="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5 text-gray-300 cursor-pointer shrink-0"
          >
            Nginx 状态
          </button>
        </div>

        {/* 输入表单 */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="任务名称/诉求 (可选，如: 统一配置检查)"
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            className="w-1/4 px-2.5 py-1.5 rounded border text-xs outline-none font-mono"
            style={{
              backgroundColor: currentTheme.ui.inputBg,
              borderColor: currentTheme.ui.border,
              color: currentTheme.ui.text,
            }}
          />
          <input
            type="text"
            placeholder="输入待并发执行的 Shell 指令 (例如: nginx -t 或 docker ps)..."
            value={inputCommand}
            onChange={(e) => setInputCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleRunTask();
              }
            }}
            className="flex-1 px-3 py-1.5 rounded border text-xs outline-none font-mono"
            style={{
              backgroundColor: currentTheme.ui.inputBg,
              borderColor: currentTheme.ui.border,
              color: currentTheme.ui.text,
            }}
          />
          <button
            onClick={handleRunTask}
            disabled={isExecutingTask || !inputCommand.trim()}
            className="px-4 py-1.5 rounded font-semibold text-xs cursor-pointer flex items-center gap-1.5 transition-opacity disabled:opacity-40"
            style={{
              backgroundColor: currentTheme.ui.accent,
              color: currentTheme.isDark ? '#000000' : '#ffffff',
            }}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{isExecutingTask ? '调度中...' : '并发调度'}</span>
          </button>
        </div>
      </div>
    </section>
  );
};
