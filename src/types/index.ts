export type AuthType = 'password' | 'key' | 'agent';

export interface ServerRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  credential?: string;
  passphrase?: string;
  group_name?: string;
  tags?: string;
  jump_host_id?: string;
  created_at: number;
}

export interface TerminalTab {
  id: string;
  sessionId: string;
  title: string;
  isSsh: boolean;
  server?: ServerRecord;
  connected: boolean;
  cols?: number;
  rows?: number;
}

export interface AiProviderConfig {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
}

export interface AiSettings {
  providers?: AiProviderConfig[];
  active_provider_id?: string;
  ai_provider: string;
  ai_base_url: string;
  ai_api_key: string;
  ai_model: string;
  danger_level: 'high' | 'medium' | 'low';
  permission_mode?: PermissionMode;
}

export type PermissionMode = 'read_only' | 'ask' | 'full';

export interface ToolCallItem {
  id: string;
  name: string;
  args: Record<string, any>;
  status: 'pending' | 'executing' | 'success' | 'rejected' | 'failed';
  riskLevel: 'safe' | 'warning' | 'dangerous';
  warningMessage?: string;
  result?: string;
  durationMs?: number;
  hostId?: string;
  hostName?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  thinking?: string;
  thinkingTimeMs?: number;
  toolCalls?: ToolCallItem[];
}

export interface RemoteFileInfo {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  permissions: number;
  mtime: number;
}

export interface SftpListResult {
  current_dir: string;
  files: RemoteFileInfo[];
}

export interface SafetyCheckResult {
  is_dangerous: boolean;
  risk_level: 'safe' | 'warning' | 'dangerous';
  command: string;
  message: string;
}

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  host_ids: string[];
  created_at: number;
  updated_at: number;
}

export type TaskStatus =
  | 'Planning'
  | 'WaitingApproval'
  | 'Running'
  | 'Verifying'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

export interface TaskStep {
  id: string;
  host_id: string;
  host_name: string;
  command: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  stdout: string;
  stderr: string;
  exit_code?: number;
  duration_ms: number;
}

export interface TaskPlan {
  id: string;
  workspace_id: string;
  prompt: string;
  status: TaskStatus;
  steps: TaskStep[];
  summary?: string;
  created_at: number;
  updated_at: number;
}

export type AppPrimaryMode = 'terminal' | 'workspace';

export interface SessionAgentState {
  messages: ChatMessage[];
  isThinking: boolean;
  pendingToolCall: ToolCallItem | null;
  approvalResolver: ((allowed: boolean) => void) | null;
}

export interface WorkspaceAgentState {
  messages: ChatMessage[];
  isThinking: boolean;
  pendingToolCall: ToolCallItem | null;
  approvalResolver: ((allowed: boolean) => void) | null;
}


