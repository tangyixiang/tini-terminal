import { create } from 'zustand';
import type { ChatMessage, PermissionMode, ToolCallItem, SessionAgentState } from '../types';

export const createDefaultSessionState = (): SessionAgentState => ({
  messages: [],
  isThinking: false,
  pendingToolCall: null,
  approvalResolver: null,
});

interface AgentState {
  permissionMode: PermissionMode;
  sessions: Record<string, SessionAgentState>;

  setPermissionMode: (mode: PermissionMode) => void;
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
  clearMessages: (tabId: string) => void;
  removeSession: (tabId: string) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  permissionMode: 'ask',
  sessions: {},

  setPermissionMode: (mode: PermissionMode) => {
    set({ permissionMode: mode });
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

  setPendingApproval: (
    tabId: string,
    toolCall: ToolCallItem | null,
    resolver: ((allowed: boolean) => void) | null
  ) => {
    set((state) => {
      const prev = state.sessions[tabId] || createDefaultSessionState();
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

  clearMessages: (tabId: string) => {
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
  },

  removeSession: (tabId: string) => {
    set((state) => {
      if (!state.sessions[tabId]) return state;
      const { [tabId]: _, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },
}));
