import type { AiProviderConfig, AiSettings } from '../types';

export interface AiProviderPreset {
  /** 展示名称，同时作为持久化的 provider 标识 */
  name: string;
  baseUrl: string;
  model: string;
  /** 是否为「自定义」预设，选择后保留用户已填写内容 */
  custom?: boolean;
  /** 模型输入框的提示文案 */
  modelHint?: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    modelHint: 'deepseek-chat 或 deepseek-reasoner',
  },
  {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    modelHint: 'gpt-4o 或 gpt-4o-mini',
  },
  {
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    modelHint: 'qwen-plus 或 qwen-max',
  },
  {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    modelHint: 'moonshot-v1-8k / moonshot-v1-32k',
  },
  {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    modelHint: 'glm-4-plus 或 glm-4-flash',
  },
  {
    name: 'Ollama (本地私有化)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    modelHint: '本地已拉取的模型名',
  },
  {
    name: 'vLLM (自建部署)',
    baseUrl: 'http://localhost:8000/v1',
    model: 'default',
    modelHint: '自建服务的模型名',
  },
  {
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    model: '',
    custom: true,
    modelHint: '填写兼容 OpenAI 协议的服务地址与模型名',
  },
];

export const CUSTOM_PROVIDER_NAME = '自定义 (OpenAI 兼容)';
export const DEFAULT_PROVIDER_PRESET = AI_PROVIDER_PRESETS[0];

export function findPreset(name?: string): AiProviderPreset | undefined {
  if (!name) return undefined;
  return AI_PROVIDER_PRESETS.find((preset) => preset.name === name);
}

export function createDefaultProviderConfig(id = 'default-provider'): AiProviderConfig {
  return {
    id,
    name: `${DEFAULT_PROVIDER_PRESET.name} 默认`,
    provider: DEFAULT_PROVIDER_PRESET.name,
    base_url: DEFAULT_PROVIDER_PRESET.baseUrl,
    api_key: '',
    model: DEFAULT_PROVIDER_PRESET.model,
  };
}

export function createProviderConfigFromPreset(
  presetName: string,
  id: string,
  displayName: string
): AiProviderConfig {
  const preset = findPreset(presetName) || DEFAULT_PROVIDER_PRESET;
  return {
    id,
    name: displayName,
    provider: preset.name,
    base_url: preset.baseUrl,
    api_key: '',
    model: preset.model,
  };
}

export interface AiRuntime {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
}

/**
 * 解析当前生效的模型运行时参数
 * 不做任何厂商默认值兜底：缺配置时返回空值，由调用方给出明确错误提示
 */
export function resolveAiRuntime(settings: AiSettings): AiRuntime {
  const activeProvider =
    settings.providers?.find((p) => p.id === settings.active_provider_id) ||
    settings.providers?.[0];

  const preset = findPreset(activeProvider?.provider) || DEFAULT_PROVIDER_PRESET;

  const baseUrl = activeProvider?.base_url || settings.ai_base_url || preset.baseUrl || '';
  const model = activeProvider?.model || settings.ai_model || preset.model || '';
  const apiKey = activeProvider?.api_key ?? settings.ai_api_key ?? '';

  return {
    baseUrl: (baseUrl || '').replace(/\/+$/, ''),
    apiKey: apiKey || '',
    model: model || '',
    providerName: activeProvider?.provider || preset.name,
  };
}

/** 校验运行时参数是否足够发起请求，返回缺失项说明 */
export function validateAiRuntime(runtime: AiRuntime): string | null {
  if (!runtime.baseUrl) return '尚未配置模型服务地址 (Base URL)，请在设置中补全后再试。';
  if (!runtime.model) return '尚未配置模型名称，请在设置中补全后再试。';
  return null;
}
