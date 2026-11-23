import type { RemoteFileInfo } from '../../types';

export type DialogType = 'new_folder' | 'new_file' | 'rename' | 'delete' | 'chmod' | null;
export type SortField = 'name' | 'size' | 'mtime';

export interface SftpContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  item: RemoteFileInfo | null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatPermissions(perm: number): string {
  if (!perm) return '---------';
  const mode = perm & 0o777;
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const chars = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
  const rwx = bits.map((b, i) => ((mode & b) !== 0 ? chars[i] : '-')).join('');
  return `${rwx} (${mode.toString(8).padStart(3, '0')})`;
}

export function formatMtime(sec: number): string {
  if (!sec) return '-';
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
