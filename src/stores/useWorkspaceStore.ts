import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace, TaskPlan, ChatMessage, PermissionMode, ToolCallItem, WorkspaceAgentState } from '../types';

export const createDefaultWorkspaceAgentState = (): WorkspaceAgentState => ({
  messages: [],
  isThinking: false,
  pendingToolCall: null,
  approvalResolver: null,
});

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  selectedHostIds: string[];
  tasks: TaskPlan[];
  isLoading: boolean;
  isExecutingTask: boolean;

  // Workspace Agent 状态
  permissionMode: PermissionMode;
  workspaceStates: Record<string, WorkspaceAgentState>;

  setPermissionMode: (mode: PermissionMode) => void;
  getAgentState: (wsId?: string) => WorkspaceAgentState;
  addMessage: (wsId: string, msg: ChatMessage) => void;
  updateLastMessage: (wsId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  setIsThinking: (wsId: string, thinking: boolean) => void;
  setPendingApproval: (
    wsId: string,
    toolCall: ToolCallItem | null,
    resolver: ((allowed: boolean) => void) | null
  ) => void;
  respondApproval: (wsId: string, allowed: boolean) => void;
  clearMessages: (wsId: string) => void;

  fetchWorkspaces: () => Promise<void>;
  setActiveWorkspaceId: (id: string) => void;
  toggleHostSelection: (hostId: string) => void;
  selectAllHosts: (hostIds: string[]) => void;
  deselectAllHosts: () => void;
  createWorkspace: (name: string, description?: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  saveWorkspaceHosts: (workspaceId: string, hostIds: string[]) => Promise<void>;
  fetchTasks: (workspaceId?: string) => Promise<void>;
  runTask: (
    workspaceId: string,
    prompt: string,
    targetHostIds: string[],
    command: string
  ) => Promise<TaskPlan>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  selectedHostIds: [],
  tasks: [],
  isLoading: false,
  isExecutingTask: false,
  permissionMode: 'ask',
  workspaceStates: {},

  setPermissionMode: (mode: PermissionMode) => {
    set({ permissionMode: mode });
  },

  getAgentState: (wsId?: string): WorkspaceAgentState => {
    const id = wsId || get().activeWorkspaceId || 'default';
    return get().workspaceStates[id] || createDefaultWorkspaceAgentState();
  },

  addMessage: (wsId: string, msg: ChatMessage) => {
    const id = wsId || get().activeWorkspaceId || 'default';
    set((state) => {
      const prev = state.workspaceStates[id] || createDefaultWorkspaceAgentState();
      return {
        workspaceStates: {
          ...state.workspaceStates,
          [id]: {
            ...prev,
            messages: [...prev.messages, msg],
          },
        },
      };
    });
  },

  updateLastMessage: (wsId: string, updater: (msg: ChatMessage) => ChatMessage) => {
    const id = wsId || get().activeWorkspaceId || 'default';
    set((state) => {
      const prev = state.workspaceStates[id];
      if (!prev || prev.messages.length === 0) return state;
      const updated = [...prev.messages];
      const lastIndex = updated.length - 1;
      updated[lastIndex] = updater(updated[lastIndex]);
      return {
        workspaceStates: {
          ...state.workspaceStates,
          [id]: {
            ...prev,
            messages: updated,
          },
        },
      };
    });
  },

  setIsThinking: (wsId: string, thinking: boolean) => {
    const id = wsId || get().activeWorkspaceId || 'default';
    set((state) => {
      const prev = state.workspaceStates[id] || createDefaultWorkspaceAgentState();
      return {
        workspaceStates: {
          ...state.workspaceStates,
          [id]: {
            ...prev,
            isThinking: thinking,
          },
        },
      };
    });
  },

  setPendingApproval: (
    wsId: string,
    toolCall: ToolCallItem | null,
    resolver: ((allowed: boolean) => void) | null
  ) => {
    const id = wsId || get().activeWorkspaceId || 'default';
    set((state) => {
      const prev = state.workspaceStates[id] || createDefaultWorkspaceAgentState();
      return {
        workspaceStates: {
          ...state.workspaceStates,
          [id]: {
            ...prev,
            pendingToolCall: toolCall,
            approvalResolver: resolver,
          },
        },
      };
    });
  },

  respondApproval: (wsId: string, allowed: boolean) => {
    const id = wsId || get().activeWorkspaceId || 'default';
    const current = get().workspaceStates[id];
    if (current?.approvalResolver) {
      current.approvalResolver(allowed);
    }
    set((state) => {
      const prev = state.workspaceStates[id];
      if (!prev) return state;
      return {
        workspaceStates: {
          ...state.workspaceStates,
          [id]: {
            ...prev,
            pendingToolCall: null,
            approvalResolver: null,
          },
        },
      };
    });
  },

  clearMessages: (wsId: string) => {
    const id = wsId || get().activeWorkspaceId || 'default';
    set((state) => {
      const prev = state.workspaceStates[id];
      if (!prev) return state;
      return {
        workspaceStates: {
          ...state.workspaceStates,
          [id]: {
            ...prev,
            messages: [],
            pendingToolCall: null,
            approvalResolver: null,
          },
        },
      };
    });
  },

  fetchWorkspaces: async () => {
    try {
      set({ isLoading: true });
      if (window.__TAURI_INTERNALS__) {
        const list = await invoke<Workspace[]>('list_workspaces');
        const activeId = get().activeWorkspaceId;
        const validActive = list.some((w) => w.id === activeId)
          ? activeId
          : list[0]?.id || null;

        let selected = get().selectedHostIds;
        if (validActive && selected.length === 0) {
          const currentWs = list.find((w) => w.id === validActive);
          if (currentWs) {
            selected = [...currentWs.host_ids];
          }
        }

        set({
          workspaces: list,
          activeWorkspaceId: validActive,
          selectedHostIds: selected,
          isLoading: false,
        });

        if (validActive) {
          get().fetchTasks(validActive);
        }
      }
    } catch (err) {
      console.error('[WorkspaceStore] 获取工作区失败:', err);
      set({ isLoading: false });
    }
  },

  setActiveWorkspaceId: (id: string) => {
    const ws = get().workspaces.find((w) => w.id === id);
    set({
      activeWorkspaceId: id,
      selectedHostIds: ws ? [...ws.host_ids] : [],
    });
    get().fetchTasks(id);
  },

  toggleHostSelection: (hostId: string) => {
    const { selectedHostIds } = get();
    if (selectedHostIds.includes(hostId)) {
      set({ selectedHostIds: selectedHostIds.filter((id) => id !== hostId) });
    } else {
      set({ selectedHostIds: [...selectedHostIds, hostId] });
    }
  },

  selectAllHosts: (hostIds: string[]) => {
    set({ selectedHostIds: [...hostIds] });
  },

  deselectAllHosts: () => {
    set({ selectedHostIds: [] });
  },

  createWorkspace: async (name: string, description?: string) => {
    try {
      const id = 'ws-' + Date.now();
      const now = Date.now();
      const newWs: Workspace = {
        id,
        name,
        description,
        host_ids: [],
        created_at: now,
        updated_at: now,
      };
      if (window.__TAURI_INTERNALS__) {
        await invoke('save_workspace', { workspace: newWs });
      }
      await get().fetchWorkspaces();
      get().setActiveWorkspaceId(id);
    } catch (err) {
      console.error('[WorkspaceStore] 创建工作区失败:', err);
    }
  },

  deleteWorkspace: async (id: string) => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await invoke('delete_workspace', { id });
      }
      await get().fetchWorkspaces();
    } catch (err) {
      console.error('[WorkspaceStore] 删除工作区失败:', err);
    }
  },

  saveWorkspaceHosts: async (workspaceId: string, hostIds: string[]) => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await invoke('set_workspace_hosts', { workspaceId, hostIds });
      }
      await get().fetchWorkspaces();
    } catch (err) {
      console.error('[WorkspaceStore] 保存工作区主机映射失败:', err);
    }
  },

  fetchTasks: async (workspaceId?: string) => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const tasks = await invoke<TaskPlan[]>('list_workspace_tasks', {
          workspaceId: workspaceId || get().activeWorkspaceId,
        });
        set({ tasks });
      }
    } catch (err) {
      console.error('[WorkspaceStore] 获取任务记录失败:', err);
    }
  },

  runTask: async (
    workspaceId: string,
    prompt: string,
    targetHostIds: string[],
    command: string
  ): Promise<TaskPlan> => {
    set({ isExecutingTask: true });
    try {
      if (window.__TAURI_INTERNALS__) {
        const task = await invoke<TaskPlan>('run_workspace_task', {
          workspaceId,
          prompt,
          targetHostIds,
          command,
        });
        set((state) => ({
          tasks: [task, ...state.tasks.filter((t) => t.id !== task.id)],
          isExecutingTask: false,
        }));
        return task;
      } else {
        throw new Error('当前非 Tauri 环境，无法调度真实任务');
      }
    } catch (err) {
      set({ isExecutingTask: false });
      throw err;
    }
  },
}));
