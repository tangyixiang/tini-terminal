import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { getPrimaryButtonStyle, type ThemeConfig } from '../../types/theme';

interface DisconnectBannerProps {
  visible: boolean;
  message?: string;
  theme: ThemeConfig;
  onReconnect: () => void;
}

export const DisconnectBanner: React.FC<DisconnectBannerProps> = ({
  visible,
  message = 'SSH 会话已断开',
  theme,
  onReconnect,
}) => {
  if (!visible) return null;

  return (
    <div
      data-terminal-overlay
      className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 px-3 py-1.5 rounded-lg border shadow-lg text-xs select-none"
      style={{
        backgroundColor: theme.ui.cardBg,
        borderColor: '#f59e0b',
        color: theme.ui.text,
      }}
    >
      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
      <span>{message}</span>
      <button
        type="button"
        onClick={onReconnect}
        className="px-2 py-0.5 rounded font-semibold flex items-center gap-1 cursor-pointer hover:opacity-90"
        style={getPrimaryButtonStyle(theme)}
      >
        <RefreshCw className="w-3 h-3" />
        重新连接
      </button>
    </div>
  );
};
