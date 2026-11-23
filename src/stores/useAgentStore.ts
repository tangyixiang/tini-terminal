import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  AgentExecutionMode,
  ChatMessage,
  PermissionMode,
  SessionAgentState,
  ToolCallItem,
} from '../types';

const EXEC_MODE_KEY = 'tini_terminal_agent_exec_mode';
const ATTACH_CTX_KEY = 'tini_terminal_agent_attach_ctx';

function readExecMode(): AgentExecutionMode {
  if (typeof localStorage === 'undefined') return 'isolated';
  const v = localStorage.getItem(EXEC_MODE_KEY);
  return v === 'pty' ? 'pty' : 'isolated';
}

function readAttachCtx(): boolean {
  if (typeof localStorage === 'undefined') return true;
  const v = localStorage.getItem(ATTACH_CTX_KEY);
  return v === null ? true : v === 'true';
}

export const createDefaultSessionState = (): SessionAgentState => ({
  messages: [],
  isThinking: false,
  pendingToolCall: null,
  approvalResolver: null,
});

interface AgentState {
  permissionMode: PermissionMode;
  executionMode: AgentExecutionMode;
  attachTerminalContext: boolean;
  sessions: Record<string, SessionAgentState>;
  loadedKeys: Record<string, boolean>;

  setPermissionMode: (mode: PermissionMode) => void;
  setExecutionMode: (mode: AgentExecutionMode) => void;
  setAttachTerminalContext: (enabled: boolean) => void;
  getSessionState: (tabId: string) => SessionAgentState;
  addMessage: (tabId: string, msg: ChatMessage) => void;
  updateLastMessage: (tabId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  setIsThinking: (tabId: string, thinking: boolean) => void;
  setPendingApproval: (
    tabId: string,
    toolCall: ToolCallItem | null,
    resolver: ((allowed: boolean) => void) | null
  ) => void;
  respondApproval: (tabId: string, allowed: boolean) => void;
  clearMessages: (tabId: string, persistKey?: string) => void;
  removeSession: (tabId: string) => void;
  loadHistory: (tabId: string, persistKey: string) => Promise<void>;
  persistHistory: (tabId: string, persistKey: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  permissionMode: 'ask',
  executionMode: readExecMode(),
  attachTerminalContext: readAttachCtx(),
  sessions: {},
  loadedKeys: {},

  setPermissionMode: (mode: PermissionMode) => {
    set({ permissionMode: mode });
  },

  setExecutionMode: (mode: AgentExecutionMode) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(EXEC_MODE_KEY, mode);
    }
    set({ executionMode: mode });
  },

  setAttachTerminalContext: (enabled: boolean) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ATTACH_CTX_KEY, String(enabled));
    }
    set({ attachTerminalContext: enabled });
  },

  getSessionState: (tabId: string): SessionAgentState => {
    return get().sessions[tabId] || createDefaultSessionState();
  },

  addMessage: (tabId: string, msg: ChatMessage) => {
    set((state) => {
      const prev = state.sessions[tabId] || createDefaultSessionState();
      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...prev,
            messages: [...prev.messages, msg],
          },
        },
      };
    });
  },

  updateLastMessage: (tabId: string, updater: (msg: ChatMessage) => ChatMessage) => {
    set((state) => {
      const prev = state.sessions[tabId];
      if (!prev || prev.messages.length === 0) return state;
      const updated = [...prev.messages];
      const lastIndex = updated.length - 1;
      updated[lastIndex] = updater(updated[lastIndex]);
      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...prev,
            messages: updated,
          },
        },
      };
    });
  },

  setIsThinking: (tabId: string, thinking: boolean) => {
    set((state) => {
      const prev = state.sessions[tabId] || createDefaultSessionState();
      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...prev,
            isThinking: thinking,
          },
        },
      };
    });
  },

  setPendingApproval: (tabId, toolCall, resolver) => {
    set((state) => {
      const prev = state.sessions[tabId] || createDefaultSessionState();
      if (prev.approvalResolver && prev.approvalResolver !== resolver) {
        prev.approvalResolver(false);
      }
      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...prev,
            pendingToolCall: toolCall,
            approvalResolver: resolver,
          },
        },
      };
    });
  },

  respondApproval: (tabId: string, allowed: boolean) => {
    const session = get().sessions[tabId];
    if (session?.approvalResolver) {
      session.approvalResolver(allowed);
    }
    set((state) => {
      const prev = state.sessions[tabId];
      if (!prev) return state;
      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...prev,
            pendingToolCall: null,
            approvalResolver: null,
          },
        },
      };
    });
  },

  clearMessages: (tabId: string, persistKey?: string) => {
    set((state) => {
      const prev = state.sessions[tabId];
      if (!prev) return state;
      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...prev,
            messages: [],
            pendingToolCall: null,
            approvalResolver: null,
          },
        },
      };
    });
    if (persistKey && window.__TAURI_INTERNALS__) {
      invoke('clear_chat_history', { sessionKey: persistKey }).catch(() => {});
    }
  },

  removeSession: (tabId: string) => {
    set((state) => {
      if (!state.sessions[tabId]) return state;
      const { [tabId]: _, ...rest } = state.sessions;
      const { [tabId]: __, ...restLoaded } = state.loadedKeys;
      return { sessions: rest, loadedKeys: restLoaded };
    });
  },

  loadHistory: async (tabId: string, persistKey: string) => {
    if (!window.__TAURI_INTERNALS__ || !persistKey) return;
    if (get().loadedKeys[tabId]) return;
    set((state) => ({ loadedKeys: { ...state.loadedKeys, [tabId]: true } }));
    try {
      const rows = await invoke<string[]>('load_chat_history', {
        sessionKey: persistKey,
        limit: 40,
      });
      if (!rows || rows.length === 0) return;
      const parsed: ChatMessage[] = [];
      for (const raw of rows) {
        try {
          const msg = JSON.parse(raw) as ChatMessage;
          if (msg && msg.id && msg.role) parsed.push(msg);
        } catch {}
      }
      if (parsed.length === 0) return;
      set((state) => {
        const prev = state.sessions[tabId] || createDefaultSessionState();
        if (prev.messages.length > 0) return state;
        return {
          sessions: {
            ...state.sessions,
            [tabId]: {
              ...prev,
              messages: parsed,
            },
          },
        };
      });
    } catch {}
  },

  persistHistory: async (tabId: string, persistKey: string) => {
    if (!window.__TAURI_INTERNALS__ || !persistKey) return;
    const session = get().sessions[tabId];
    if (!session) return;
    const recent = session.messages.slice(-40).map((m) => ({
      id: m.id,
      session_key: persistKey,
      payload_json: JSON.stringify(m),
      created_at: m.timestamp || Date.now(),
    }));
    try {
      await invoke('save_chat_history', {
        sessionKey: persistKey,
        messages: recent,
      });
    } catch {}
  },
}));
