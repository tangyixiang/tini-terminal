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
