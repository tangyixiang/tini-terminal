import { create } from 'zustand';
import type { ChatMessage, PermissionMode, ToolCallItem } from '../types';

interface AgentState {
  permissionMode: PermissionMode;
  messages: ChatMessage[];
  isThinking: boolean;
  pendingToolCall: ToolCallItem | null;
  approvalResolver: ((allowed: boolean) => void) | null;
  setPermissionMode: (mode: PermissionMode) => void;
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (updater: (msg: ChatMessage) => ChatMessage) => void;
  setIsThinking: (thinking: boolean) => void;
  setPendingApproval: (
    toolCall: ToolCallItem | null,
    resolver: ((allowed: boolean) => void) | null
  ) => void;
  respondApproval: (allowed: boolean) => void;
  clearMessages: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  permissionMode: 'ask',
  messages: [],
  isThinking: false,
  pendingToolCall: null,
  approvalResolver: null,

  setPermissionMode: (mode: PermissionMode) => {
    set({ permissionMode: mode });
  },

  addMessage: (msg: ChatMessage) => {
    set((state) => ({ messages: [...state.messages, msg] }));
  },

  updateLastMessage: (updater: (msg: ChatMessage) => ChatMessage) => {
    set((state) => {
      if (state.messages.length === 0) return state;
      const updated = [...state.messages];
      const lastIndex = updated.length - 1;
      updated[lastIndex] = updater(updated[lastIndex]);
      return { messages: updated };
    });
  },

  setIsThinking: (thinking: boolean) => {
    set({ isThinking: thinking });
  },

  setPendingApproval: (
    toolCall: ToolCallItem | null,
    resolver: ((allowed: boolean) => void) | null
  ) => {
    set({
      pendingToolCall: toolCall,
      approvalResolver: resolver,
    });
  },

  respondApproval: (allowed: boolean) => {
    const { approvalResolver } = get();
    if (approvalResolver) {
      approvalResolver(allowed);
    }
    set({
      pendingToolCall: null,
      approvalResolver: null,
    });
  },

  clearMessages: () => {
    set({ messages: [] });
  },
}));
