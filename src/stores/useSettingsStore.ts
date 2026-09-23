import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AiSettings, AiProviderConfig, PermissionMode } from '../types';
import { BUILTIN_THEMES, type ThemeConfig, type ThemeId } from '../types/theme';
import { useAgentStore } from './useAgentStore';

interface SettingsState {
  settings: AiSettings;
  themeId: ThemeId;
  isSettingsModalOpen: boolean;
  isServerModalOpen: boolean;
  isSftpDrawerOpen: boolean;
  isAiPanelOpen: boolean;
  isServerSidebarOpen: boolean;
  sidebarWidth: number;
  aiPanelWidth: number;
  terminalFontSize: number;
  editingServerId: string | null;
  fetchSettings: () => Promise<void>;
  saveSettings: (partial: Partial<AiSettings>) => Promise<void>;
  getActiveProviderConfig: () => AiProviderConfig | undefined;
  setThemeId: (id: ThemeId) => Promise<void>;
  getThemeConfig: () => ThemeConfig;
  toggleSettingsModal: (open?: boolean) => void;
  toggleServerModal: (open?: boolean, serverId?: string | null) => void;
  toggleSftpDrawer: (open?: boolean) => void;
  toggleAiPanel: (open?: boolean) => void;
  toggleServerSidebar: (open?: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setAiPanelWidth: (width: number) => void;
  setTerminalFontSize: (size: number) => void;
}

const defaultProvider: AiProviderConfig = {
  id: 'default-provider',
  name: 'DeepSeek 官方',
  provider: 'DeepSeek',
  base_url: 'https://api.deepseek.com/v1',
  api_key: '',
  model: 'deepseek-chat',
};

const defaultSettings: AiSettings = {
  providers: [defaultProvider],
  active_provider_id: defaultProvider.id,
  ai_provider: defaultProvider.provider,
  ai_base_url: defaultProvider.base_url,
  ai_api_key: defaultProvider.api_key,
  ai_model: defaultProvider.model,
  danger_level: 'high',
  permission_mode: 'ask',
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: defaultSettings,
  themeId: 'aliyun',
  isSettingsModalOpen: false,
  isServerModalOpen: false,
  isSftpDrawerOpen: false,
  isAiPanelOpen: true,
  isServerSidebarOpen: true,
  sidebarWidth: 240,
  aiPanelWidth: 360,
  terminalFontSize: 14,
  editingServerId: null,

  getActiveProviderConfig: () => {
    const { settings } = get();
    return (
      settings.providers?.find((p) => p.id === settings.active_provider_id) ||
      settings.providers?.[0]
    );
  },

  fetchSettings: async () => {
    try {
      const savedSidebarOpen = localStorage.getItem('tini_terminal_sidebar_open') ?? localStorage.getItem('ai_terminal_sidebar_open');
      const savedSidebarWidth = localStorage.getItem('tini_terminal_sidebar_width') ?? localStorage.getItem('ai_terminal_sidebar_width');
      const savedAiWidth = localStorage.getItem('tini_terminal_ai_width') ?? localStorage.getItem('ai_terminal_ai_width');
      const savedFontSize = localStorage.getItem('tini_terminal_font_size') ?? localStorage.getItem('ai_terminal_font_size');
      if (savedSidebarOpen !== null) set({ isServerSidebarOpen: savedSidebarOpen === 'true' });
      if (savedSidebarWidth) set({ sidebarWidth: Number(savedSidebarWidth) });
      if (savedAiWidth) set({ aiPanelWidth: Number(savedAiWidth) });
      if (savedFontSize) set({ terminalFontSize: Number(savedFontSize) });

      if (window.__TAURI_INTERNALS__) {
        const raw = await invoke<Record<string, string>>('get_settings');
        if (raw && Object.keys(raw).length > 0) {
          const permMode = (raw.permission_mode as PermissionMode) || defaultSettings.permission_mode;

          let providers: AiProviderConfig[] = [];
          if (raw.ai_providers_json) {
            try {
              const parsed = JSON.parse(raw.ai_providers_json);
              if (Array.isArray(parsed) && parsed.length > 0) {
                providers = parsed;
              }
            } catch (e) {
              console.error('解析模型提供商配置失败:', e);
            }
          }

          if (providers.length === 0) {
            providers = [
              {
                id: 'provider-default',
                name: (raw.ai_provider || defaultSettings.ai_provider) + ' 默认',
                provider: raw.ai_provider || defaultSettings.ai_provider,
                base_url: raw.ai_base_url || defaultSettings.ai_base_url,
                api_key: raw.ai_api_key || defaultSettings.ai_api_key,
                model: raw.ai_model || defaultSettings.ai_model,
              },
            ];
          }

          let activeId = raw.active_provider_id || providers[0].id;
          if (!providers.some((p) => p.id === activeId)) {
            activeId = providers[0].id;
          }
          const activeProvider = providers.find((p) => p.id === activeId) || providers[0];

          set({
            settings: {
              providers,
              active_provider_id: activeId,
              ai_provider: activeProvider.provider,
              ai_base_url: activeProvider.base_url,
              ai_api_key: activeProvider.api_key,
              ai_model: activeProvider.model,
              danger_level: (raw.danger_level as 'high' | 'medium' | 'low') || defaultSettings.danger_level,
              permission_mode: permMode,
            },
            themeId: (raw.theme_id as ThemeId) || 'aliyun',
          });
          if (permMode) {
            useAgentStore.getState().setPermissionMode(permMode);
          }
        }
      } else {
        const local = localStorage.getItem('tini_terminal_settings') || localStorage.getItem('ai_terminal_settings');
        const localTheme = (localStorage.getItem('tini_terminal_theme') || localStorage.getItem('ai_terminal_theme')) as ThemeId;
        if (local) {
          try {
            const parsed = JSON.parse(local);
            let providers: AiProviderConfig[] = parsed.providers || [];
            if (!Array.isArray(providers) || providers.length === 0) {
              providers = [
                {
                  id: 'provider-default',
                  name: (parsed.ai_provider || defaultSettings.ai_provider) + ' 默认',
                  provider: parsed.ai_provider || defaultSettings.ai_provider,
                  base_url: parsed.ai_base_url || defaultSettings.ai_base_url,
                  api_key: parsed.ai_api_key || defaultSettings.ai_api_key,
                  model: parsed.ai_model || defaultSettings.ai_model,
                },
              ];
            }
            let activeId = parsed.active_provider_id || providers[0].id;
            if (!providers.some((p) => p.id === activeId)) {
              activeId = providers[0].id;
            }
            const activeProvider = providers.find((p) => p.id === activeId) || providers[0];

            set({
              settings: {
                ...defaultSettings,
                ...parsed,
                providers,
                active_provider_id: activeId,
                ai_provider: activeProvider.provider,
                ai_base_url: activeProvider.base_url,
                ai_api_key: activeProvider.api_key,
                ai_model: activeProvider.model,
              },
            });
            if (parsed.permission_mode) {
              useAgentStore.getState().setPermissionMode(parsed.permission_mode as PermissionMode);
            }
          } catch (e) {
            console.error('解析本地系统设置失败:', e);
          }
        }
        if (localTheme && BUILTIN_THEMES[localTheme]) {
          set({ themeId: localTheme });
        }
      }
    } catch (e) {
      console.error('获取系统设置失败:', e);
    }
  },

  saveSettings: async (partial: Partial<AiSettings>) => {
    const current = get().settings;
    const updated = { ...current, ...partial };

    if (!updated.providers || updated.providers.length === 0) {
      updated.providers = current.providers || [defaultProvider];
    }
    if (!updated.active_provider_id || !updated.providers.some((p) => p.id === updated.active_provider_id)) {
      updated.active_provider_id = updated.providers[0]?.id || defaultProvider.id;
    }

    const active = updated.providers.find((p) => p.id === updated.active_provider_id) || updated.providers[0];
    if (active) {
      updated.ai_provider = active.provider;
      updated.ai_base_url = active.base_url;
      updated.ai_api_key = active.api_key;
      updated.ai_model = active.model;
    }

    set({ settings: updated });
    try {
      if (window.__TAURI_INTERNALS__) {
        const payload: Record<string, string> = {
          ai_providers_json: JSON.stringify(updated.providers),
          active_provider_id: updated.active_provider_id,
          ai_provider: updated.ai_provider || '',
          ai_base_url: updated.ai_base_url || '',
          ai_api_key: updated.ai_api_key || '',
          ai_model: updated.ai_model || '',
          danger_level: updated.danger_level || 'high',
          permission_mode: updated.permission_mode || 'ask',
          theme_id: get().themeId,
        };
        await invoke('save_settings', {
          settings: payload,
        });
      } else {
        localStorage.setItem('tini_terminal_settings', JSON.stringify(updated));
      }
    } catch (e) {
      console.error('保存系统设置失败:', e);
      throw e;
    }
  },

  setThemeId: async (id: ThemeId) => {
    const targetTheme = BUILTIN_THEMES[id];
    if (!targetTheme) return;
    set({ themeId: id });
    try {
      if (window.__TAURI_INTERNALS__) {
        invoke('set_window_theme', { isDark: targetTheme.isDark }).catch(() => {});
        await invoke('save_settings', {
          settings: {
            ...get().settings,
            theme_id: id,
          },
        });
      } else {
        localStorage.setItem('tini_terminal_theme', id);
      }
    } catch (e) {
      console.error('保存主题设置失败:', e);
    }
  },

  getThemeConfig: () => {
    const id = get().themeId;
    return BUILTIN_THEMES[id] || BUILTIN_THEMES.aliyun;
  },

  toggleSettingsModal: (open?: boolean) => {
    set((state) => ({
      isSettingsModalOpen: open !== undefined ? open : !state.isSettingsModalOpen,
    }));
  },

  toggleServerModal: (open?: boolean, serverId: string | null = null) => {
    set((state) => ({
      isServerModalOpen: open !== undefined ? open : !state.isServerModalOpen,
      editingServerId: serverId,
    }));
  },

  toggleSftpDrawer: (open?: boolean) => {
    set((state) => ({
      isSftpDrawerOpen: open !== undefined ? open : !state.isSftpDrawerOpen,
    }));
  },

  toggleAiPanel: (open?: boolean) => {
    set((state) => {
      const next = open !== undefined ? open : !state.isAiPanelOpen;
      return { isAiPanelOpen: next };
    });
  },

  toggleServerSidebar: (open?: boolean) => {
    set((state) => {
      const next = open !== undefined ? open : !state.isServerSidebarOpen;
      localStorage.setItem('tini_terminal_sidebar_open', String(next));
      return { isServerSidebarOpen: next };
    });
  },

  setSidebarWidth: (width: number) => {
    const maxWidth = typeof window !== 'undefined' ? Math.max(480, Math.min(640, window.innerWidth - 400)) : 480;
    const clamped = Math.max(160, Math.min(maxWidth, width));
    set({ sidebarWidth: clamped });
    localStorage.setItem('tini_terminal_sidebar_width', String(clamped));
  },

  setAiPanelWidth: (width: number) => {
    const maxWidth = typeof window !== 'undefined' ? Math.max(640, window.innerWidth - 300) : 1800;
    const clamped = Math.max(260, Math.min(maxWidth, width));
    set({ aiPanelWidth: clamped });
    localStorage.setItem('tini_terminal_ai_width', String(clamped));
  },

  setTerminalFontSize: (size: number) => {
    const clamped = Math.max(11, Math.min(22, size));
    set({ terminalFontSize: clamped });
    localStorage.setItem('tini_terminal_font_size', String(clamped));
  },
}));
