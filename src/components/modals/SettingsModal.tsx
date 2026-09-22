import React, { useState, useEffect } from 'react';
import { X, CheckCircle2, AlertCircle, Loader2, Palette, Sparkles } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { BUILTIN_THEMES, type ThemeId } from '../../types/theme';
import type { AiProviderConfig, PermissionMode } from '../../types';

export const SettingsModal: React.FC = () => {
  const {
    isSettingsModalOpen,
    toggleSettingsModal,
    settings,
    saveSettings,
    themeId,
    setThemeId,
    terminalFontSize,
    setTerminalFontSize,
  } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<'appearance' | 'ai'>('appearance');

  const { permissionMode: currentPermissionMode, setPermissionMode } = useAgentStore();
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string>('');
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [dangerLevel, setDangerLevel] = useState(settings.danger_level);
  const [permissionModeLocal, setPermissionModeLocal] = useState<PermissionMode>(
    settings.permission_mode || currentPermissionMode || 'ask'
  );

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    const list =
      settings.providers && settings.providers.length > 0
        ? settings.providers
        : [
            {
              id: 'provider-default',
              name: (settings.ai_provider || 'DeepSeek') + ' 默认',
              provider: settings.ai_provider || 'DeepSeek',
              base_url: settings.ai_base_url || 'https://api.deepseek.com/v1',
              api_key: settings.ai_api_key || '',
              model: settings.ai_model || 'deepseek-chat',
            },
          ];
    const activeId =
      settings.active_provider_id && list.some((p) => p.id === settings.active_provider_id)
        ? settings.active_provider_id
        : list[0].id;

    setProviders(list);
    setActiveProviderId(activeId);
    setSelectedProviderId(activeId);
    setDangerLevel(settings.danger_level);
    setPermissionModeLocal(settings.permission_mode || currentPermissionMode || 'ask');
    setTestResult(null);
  }, [isSettingsModalOpen, settings, currentPermissionMode]);

  if (!isSettingsModalOpen) return null;

  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const selectedProvider: AiProviderConfig =
    providers.find((p) => p.id === selectedProviderId) ||
    providers[0] || {
      id: 'temp',
      name: '',
      provider: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: '',
      model: 'deepseek-chat',
    };

  const handleSelectProvider = (id: string) => {
    setSelectedProviderId(id);
    setTestResult(null);
  };

  const handleSetCurrentActive = () => {
    setActiveProviderId(selectedProviderId);
  };

  const handleAddProvider = () => {
    const newId = 'provider-' + Date.now();
    const newProvider: AiProviderConfig = {
      id: newId,
      name: `新配置 ${providers.length + 1}`,
      provider: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: '',
      model: 'deepseek-chat',
    };
    setProviders((prev) => [...prev, newProvider]);
    setSelectedProviderId(newId);
    setTestResult(null);
  };

  const handleDeleteProvider = () => {
    if (providers.length <= 1) return;
    const filtered = providers.filter((p) => p.id !== selectedProviderId);
    let nextSelected = filtered[0].id;
    if (activeProviderId === selectedProviderId) {
      setActiveProviderId(nextSelected);
    }
    setProviders(filtered);
    setSelectedProviderId(nextSelected);
    setTestResult(null);
  };

  const handleUpdateField = (field: keyof AiProviderConfig, value: string) => {
    setProviders((prev) =>
      prev.map((p) => (p.id === selectedProviderId ? { ...p, [field]: value } : p))
    );
  };

  const handleProviderChange = (newProvider: string) => {
    let newBaseUrl = '';
    let newModel = '';
    switch (newProvider) {
      case 'DeepSeek':
        newBaseUrl = 'https://api.deepseek.com/v1';
        newModel = 'deepseek-chat';
        break;
      case 'OpenAI':
        newBaseUrl = 'https://api.openai.com/v1';
        newModel = 'gpt-4o';
        break;
      case 'Ollama':
        newBaseUrl = 'http://localhost:11434/v1';
        newModel = 'llama3.2';
        break;
      case 'vLLM':
        newBaseUrl = 'http://localhost:8000/v1';
        newModel = 'default';
        break;
      default:
        break;
    }
    setProviders((prev) =>
      prev.map((p) =>
        p.id === selectedProviderId
          ? {
              ...p,
              provider: newProvider,
              ...(newBaseUrl ? { base_url: newBaseUrl } : {}),
              ...(newModel ? { model: newModel } : {}),
            }
          : p
      )
    );
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      if (window.__TAURI_INTERNALS__) {
        const res = await invoke<{
          success: boolean;
          message: string;
          latency_ms: number;
        }>('test_ai_connection', {
          req: {
            base_url: selectedProvider.base_url.trim(),
            api_key: selectedProvider.api_key.trim(),
            model: selectedProvider.model.trim(),
          },
        });
        setTestResult({
          success: res.success,
          message: `${res.message} (耗时: ${res.latency_ms}ms)`,
        });
      } else {
        const start = Date.now();
        const res = await fetch(
          `${selectedProvider.base_url.replace(/\/+$/, '')}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(selectedProvider.api_key
                ? { Authorization: `Bearer ${selectedProvider.api_key}` }
                : {}),
            },
            body: JSON.stringify({
              model: selectedProvider.model,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 5,
            }),
          }
        );
        const elapsed = Date.now() - start;
        if (res.ok) {
          setTestResult({
            success: true,
            message: `连接成功 (HTTP ${res.status}, 耗时: ${elapsed}ms)`,
          });
        } else {
          setTestResult({
            success: false,
            message: `连接失败 (HTTP ${res.status})`,
          });
        }
      }
    } catch (e: any) {
      setTestResult({
        success: false,
        message: `测试异常: ${e?.message || e}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const active =
      providers.find((p) => p.id === activeProviderId) || providers[0];
    await saveSettings({
      providers,
      active_provider_id: activeProviderId,
      ai_provider: active?.provider || 'DeepSeek',
      ai_base_url: (active?.base_url || '').trim(),
      ai_api_key: (active?.api_key || '').trim(),
      ai_model: (active?.model || '').trim(),
      danger_level: dangerLevel,
      permission_mode: permissionModeLocal,
    });
    setPermissionMode(permissionModeLocal);
    toggleSettingsModal(false);
  };

  return (
    <div className="fixed inset-0 bg-black/65 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div
        className="rounded-xl w-full max-w-2xl h-[490px] shadow-2xl flex flex-col overflow-hidden border"
        style={{
          backgroundColor: currentTheme.ui.cardBg,
          borderColor: currentTheme.ui.border,
          color: currentTheme.ui.text,
        }}
      >
        {/* 弹窗顶栏 */}
        <div
          className="h-11 px-4 border-b flex items-center justify-between shrink-0"
          style={{
            backgroundColor: currentTheme.ui.headerBg,
            borderColor: currentTheme.ui.border,
          }}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold tracking-wide">系统设置</span>
          </div>
          <button
            onClick={() => toggleSettingsModal(false)}
            className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
            style={{ color: currentTheme.ui.text }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 弹窗主体：经典左右分栏 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧菜单导航 */}
          <div
            className="w-44 border-r p-2 flex flex-col justify-between shrink-0"
            style={{
              backgroundColor: currentTheme.ui.sidebarBg,
              borderColor: currentTheme.ui.border,
            }}
          >
            <div className="space-y-1">
              <button
                onClick={() => setActiveTab('appearance')}
                className="w-full px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 text-left transition-colors cursor-pointer"
                style={{
                  backgroundColor:
                    activeTab === 'appearance'
                      ? currentTheme.ui.hoverBg
                      : 'transparent',
                  color:
                    activeTab === 'appearance'
                      ? currentTheme.ui.accent
                      : currentTheme.ui.textMuted,
                }}
              >
                <Palette className="w-4 h-4 shrink-0" />
                <span>外观与终端</span>
              </button>

              <button
                onClick={() => setActiveTab('ai')}
                className="w-full px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 text-left transition-colors cursor-pointer"
                style={{
                  backgroundColor:
                    activeTab === 'ai' ? currentTheme.ui.hoverBg : 'transparent',
                  color:
                    activeTab === 'ai'
                      ? currentTheme.ui.accent
                      : currentTheme.ui.textMuted,
                }}
              >
                <Sparkles className="w-4 h-4 shrink-0" />
                <span>AI 智能运维</span>
              </button>
            </div>

            <div
              className="text-[10px] px-2 py-1 font-mono"
              style={{ color: currentTheme.ui.textMuted }}
            >
              配置自动同步本地
            </div>
          </div>

          {/* 右侧内容区域 */}
          <div
            className="flex-1 overflow-y-auto p-5"
            style={{ backgroundColor: currentTheme.ui.terminalBg }}
          >
            {activeTab === 'appearance' ? (
              /* 面板 1：外观与终端配置 (Appearance) */
              <div className="space-y-4 text-xs">
                <div>
                  <h4 className="font-semibold uppercase tracking-wider mb-1">
                    界面与终端主题
                  </h4>
                  <p
                    className="text-[11px] mb-2"
                    style={{ color: currentTheme.ui.textMuted }}
                  >
                    选择终端与全局界面的色彩风格
                  </p>
                  <select
                    value={themeId}
                    onChange={(e) => setThemeId(e.target.value as ThemeId)}
                    className="w-full border rounded px-2.5 py-2 focus:outline-none"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  >
                    <option value="aliyun">默认主题</option>
                    <option value="vscode">VS Code Dark+</option>
                    <option value="github_dark">GitHub Dark</option>
                    <option value="github_light">GitHub Light</option>
                    <option value="one_dark">One Dark Pro</option>
                  </select>
                </div>

                <div
                  className="pt-2 border-t"
                  style={{ borderColor: currentTheme.ui.border }}
                >
                  <h4 className="font-semibold uppercase tracking-wider mb-1">
                    终端与 Agent 字体大小
                  </h4>
                  <p
                    className="text-[11px] mb-2"
                    style={{ color: currentTheme.ui.textMuted }}
                  >
                    调整终端与运维面板字符大小 (11px ~ 22px，支持即时自适应渲染)
                  </p>
                  <div
                    className="flex items-center gap-3 p-2.5 rounded border"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                    }}
                  >
                    <button
                      onClick={() => setTerminalFontSize(terminalFontSize - 1)}
                      className="w-7 h-7 rounded border font-bold flex items-center justify-center cursor-pointer hover:opacity-80"
                      style={{
                        backgroundColor: currentTheme.ui.hoverBg,
                        borderColor: currentTheme.ui.border,
                        color: currentTheme.ui.text,
                      }}
                    >
                      -
                    </button>
                    <input
                      type="range"
                      min={11}
                      max={22}
                      value={terminalFontSize}
                      onChange={(e) =>
                        setTerminalFontSize(parseInt(e.target.value))
                      }
                      className="flex-1 cursor-pointer"
                      style={{ accentColor: currentTheme.ui.accent }}
                    />
                    <span
                      className="w-12 text-center font-mono font-semibold"
                      style={{ color: currentTheme.ui.accent }}
                    >
                      {terminalFontSize}px
                    </span>
                    <button
                      onClick={() => setTerminalFontSize(terminalFontSize + 1)}
                      className="w-7 h-7 rounded border font-bold flex items-center justify-center cursor-pointer hover:opacity-80"
                      style={{
                        backgroundColor: currentTheme.ui.hoverBg,
                        borderColor: currentTheme.ui.border,
                        color: currentTheme.ui.text,
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>

                <div
                  className="pt-2 border-t"
                  style={{ borderColor: currentTheme.ui.border }}
                >
                  <h4 className="font-semibold uppercase tracking-wider mb-1">
                    终端字体系列
                  </h4>
                  <p
                    className="text-[11px] mb-2"
                    style={{ color: currentTheme.ui.textMuted }}
                  >
                    等宽字符渲染栈
                  </p>
                  <input
                    type="text"
                    readOnly
                    value="Menlo, Monaco, 'Courier New', monospace"
                    className="w-full border rounded px-2.5 py-1.5 font-mono text-[11px] cursor-not-allowed opacity-80"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.textMuted,
                    }}
                  />
                </div>
              </div>
            ) : (
              /* 面板 2：AI 智能运维模型参数配置 (AI Model) */
              <div className="space-y-3.5 text-xs">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      className="font-medium"
                      style={{ color: currentTheme.ui.text }}
                    >
                      模型配置
                    </label>
                    <div className="flex items-center gap-1.5">
                      {selectedProvider.id !== activeProviderId ? (
                        <button
                          type="button"
                          onClick={handleSetCurrentActive}
                          className="px-2 py-0.5 rounded border text-[11px] font-medium transition-colors cursor-pointer"
                          style={{
                            backgroundColor: currentTheme.ui.hoverBg,
                            borderColor: currentTheme.ui.border,
                            color: currentTheme.ui.accent,
                          }}
                        >
                          设为激活
                        </button>
                      ) : (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium border"
                          style={{
                            borderColor: currentTheme.ui.accent,
                            color: currentTheme.ui.accent,
                          }}
                        >
                          已激活
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={handleAddProvider}
                        className="px-2 py-0.5 rounded border text-[11px] font-medium transition-colors cursor-pointer hover:opacity-80"
                        style={{
                          backgroundColor: currentTheme.ui.hoverBg,
                          borderColor: currentTheme.ui.border,
                          color: currentTheme.ui.text,
                        }}
                      >
                        + 新增
                      </button>
                      {providers.length > 1 && (
                        <button
                          type="button"
                          onClick={handleDeleteProvider}
                          className="px-2 py-0.5 rounded border text-[11px] font-medium transition-colors cursor-pointer text-red-400 hover:text-red-300"
                          style={{
                            backgroundColor: currentTheme.ui.hoverBg,
                            borderColor: currentTheme.ui.border,
                          }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                  <select
                    value={selectedProviderId}
                    onChange={(e) => handleSelectProvider(e.target.value)}
                    className="w-full border rounded px-2.5 py-1.5 focus:outline-none font-mono text-xs"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || '未命名配置'} {p.id === activeProviderId ? '(激活)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    className="block font-medium mb-1"
                    style={{ color: currentTheme.ui.text }}
                  >
                    配置名称
                  </label>
                  <input
                    type="text"
                    value={selectedProvider.name}
                    onChange={(e) => handleUpdateField('name', e.target.value)}
                    placeholder="例如: DeepSeek 官方"
                    className="w-full border rounded px-2.5 py-1.5 text-xs focus:outline-none"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  />
                </div>

                <div>
                  <label
                    className="block font-medium mb-1"
                    style={{ color: currentTheme.ui.text }}
                  >
                    模型提供商
                  </label>
                  <select
                    value={selectedProvider.provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="w-full border rounded px-2.5 py-1.5 focus:outline-none"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  >
                    <option value="DeepSeek">DeepSeek</option>
                    <option value="OpenAI">OpenAI</option>
                    <option value="Ollama">Ollama (本地私有化)</option>
                    <option value="vLLM">vLLM (本地/云端部署)</option>
                    <option value="Custom">自定义 (OpenAI 兼容协议)</option>
                  </select>
                </div>

                <div>
                  <label
                    className="block font-medium mb-1"
                    style={{ color: currentTheme.ui.text }}
                  >
                    API Base URL
                  </label>
                  <input
                    type="text"
                    value={selectedProvider.base_url}
                    onChange={(e) => handleUpdateField('base_url', e.target.value)}
                    placeholder="https://api.deepseek.com/v1"
                    className="w-full border rounded px-2.5 py-1.5 font-mono text-xs focus:outline-none"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  />
                </div>

                <div>
                  <label
                    className="block font-medium mb-1"
                    style={{ color: currentTheme.ui.text }}
                  >
                    API Key
                  </label>
                  <input
                    type="password"
                    value={selectedProvider.api_key}
                    onChange={(e) => handleUpdateField('api_key', e.target.value)}
                    placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
                    className="w-full border rounded px-2.5 py-1.5 font-mono text-xs focus:outline-none"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  />
                </div>

                <div>
                  <label
                    className="block font-medium mb-1"
                    style={{ color: currentTheme.ui.text }}
                  >
                    模型名称
                  </label>
                  <input
                    type="text"
                    value={selectedProvider.model}
                    onChange={(e) => handleUpdateField('model', e.target.value)}
                    placeholder="deepseek-chat 或 deepseek-reasoner"
                    className="w-full border rounded px-2.5 py-1.5 font-mono text-xs focus:outline-none"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  />
                </div>

                <div>
                  <label
                    className="block font-medium mb-1"
                    style={{ color: currentTheme.ui.text }}
                  >
                    执行授权模式
                  </label>
                  <select
                    value={permissionModeLocal}
                    onChange={(e) =>
                      setPermissionModeLocal(e.target.value as PermissionMode)
                    }
                    className="w-full border rounded px-2.5 py-1.5 focus:outline-none"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  >
                    <option value="ask">需确认 (高危与写操作需人工确认)</option>
                    <option value="read_only">只读模式 (仅允许查询指令与文件查看)</option>
                    <option value="full">全权模式 (自动授权执行所有智能运维指令)</option>
                  </select>
                </div>

                <div>
                  <label
                    className="block font-medium mb-1"
                    style={{ color: currentTheme.ui.text }}
                  >
                    危险命令拦截等级
                  </label>
                  <select
                    value={dangerLevel}
                    onChange={(e) =>
                      setDangerLevel(e.target.value as 'high' | 'medium' | 'low')
                    }
                    className="w-full border rounded px-2.5 py-1.5 focus:outline-none"
                    style={{
                      backgroundColor: currentTheme.ui.inputBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  >
                    <option value="high">
                      高等级 (强制弹窗拦截 rm -rf, dd, mkfs, 关机重启等)
                    </option>
                    <option value="medium">
                      中等级 (仅拦截格式化与清空指令)
                    </option>
                    <option value="low">低等级 (仅日志记录，不弹窗中断)</option>
                  </select>
                </div>

                <div className="pt-2 flex items-center justify-between">
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className="px-3 py-1.5 rounded border text-xs cursor-pointer flex items-center gap-1.5 font-medium transition-colors"
                    style={{
                      backgroundColor: currentTheme.ui.hoverBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                    }}
                  >
                    {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    测试连接
                  </button>

                  {testResult && (
                    <div
                      className={`p-1.5 rounded flex items-center gap-1.5 text-xs ${
                        testResult.success
                          ? 'bg-emerald-950/40 border border-emerald-800/60 text-emerald-300'
                          : 'bg-red-950/40 border border-red-800/60 text-red-300'
                      }`}
                    >
                      {testResult.success ? (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span className="truncate max-w-[260px]">
                        {testResult.message}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 弹窗底栏 */}
        <div
          className="h-12 px-4 border-t flex items-center justify-end gap-2 shrink-0"
          style={{
            backgroundColor: currentTheme.ui.headerBg,
            borderColor: currentTheme.ui.border,
          }}
        >
          <button
            onClick={() => toggleSettingsModal(false)}
            className="px-4 py-1.5 rounded text-xs cursor-pointer border hover:opacity-80"
            style={{
              backgroundColor: currentTheme.ui.hoverBg,
              borderColor: currentTheme.ui.border,
              color: currentTheme.ui.text,
            }}
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded text-xs font-semibold cursor-pointer text-black hover:opacity-90 transition-opacity"
            style={{ backgroundColor: currentTheme.ui.accent }}
          >
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
};

