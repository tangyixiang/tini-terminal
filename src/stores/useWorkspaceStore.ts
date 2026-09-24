import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace, TaskPlan } from '../types';

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  selectedHostIds: string[];
  tasks: TaskPlan[];
  isLoading: boolean;
  isExecutingTask: boolean;

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
