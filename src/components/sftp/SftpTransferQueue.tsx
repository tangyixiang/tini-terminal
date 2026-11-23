import React from 'react';
import { StopCircle } from 'lucide-react';
import type { TransferItem } from '../../types';
import type { ThemeConfig } from '../../types/theme';
import { formatBytes } from './sftpUtils';

interface SftpTransferQueueProps {
  theme: ThemeConfig;
  transfers: TransferItem[];
  onClearFinished: () => void;
  onCancel: (item: TransferItem) => void;
}

export const SftpTransferQueue: React.FC<SftpTransferQueueProps> = ({
  theme,
  transfers,
  onClearFinished,
  onCancel,
}) => {
  if (transfers.length === 0) return null;

  return (
    <div
      className="border-t px-3 py-2 max-h-36 overflow-y-auto space-y-1.5 shrink-0 text-[11px]"
      style={{
        backgroundColor: theme.ui.sidebarBg,
        borderColor: theme.ui.border,
      }}
    >
      <div className="flex items-center justify-between text-[10px]" style={{ color: theme.ui.textMuted }}>
        <span>传输队列 ({transfers.length})</span>
        <button type="button" onClick={onClearFinished} className="hover:underline cursor-pointer">
          清理已完成
        </button>
      </div>
      {transfers.map((item) => {
        const pct =
          item.total > 0
            ? Math.min(100, Math.round((item.transferred / item.total) * 100))
            : item.status === 'done'
              ? 100
              : 0;
        return (
          <div key={item.id} className="space-y-0.5">
            <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
              <span className="truncate">
                {item.type === 'upload' ? '[上传]' : '[下载]'} {item.fileName}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span style={{ color: theme.ui.textMuted }}>
                  {item.status === 'running'
                    ? `${pct}% (${formatBytes(item.transferred)}${item.total ? ` / ${formatBytes(item.total)}` : ''})`
                    : item.status === 'done'
                      ? '完成'
                      : item.status === 'cancelled'
                        ? '已取消'
                        : '失败'}
                </span>
                {item.status === 'running' && (
                  <button
                    type="button"
                    onClick={() => onCancel(item)}
                    className="text-red-400 hover:text-red-300 cursor-pointer"
                    title="取消传输"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="w-full h-1 rounded overflow-hidden bg-white/10">
              <div
                className="h-full transition-all duration-150"
                style={{
                  width: `${pct}%`,
                  backgroundColor:
                    item.status === 'failed'
                      ? '#ef4444'
                      : item.status === 'cancelled'
                        ? '#a1a1aa'
                        : theme.ui.accent,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
