import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { invoke, Channel } from '@tauri-apps/api/core';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import type { TerminalTab } from '../../types';

interface XTerminalProps {
  tab: TerminalTab;
  isActive?: boolean;
}

export const XTerminal: React.FC<XTerminalProps> = ({ tab, isActive = true }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const setupConnectionRef = useRef<(() => Promise<void>) | null>(null);
  const isActiveRef = useRef(isActive);
  const setTabConnected = useTerminalStore((state) => state.setTabConnected);
  const themeId = useSettingsStore((state) => state.themeId);
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const isSftpDrawerOpen = useSettingsStore((state) => state.isSftpDrawerOpen);
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // 1. 初始化终端实例
  useEffect(() => {
    if (!containerRef.current) return;

    const initialTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

    const term = new Terminal({
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: terminalFontSize || 14,
      lineHeight: 1.42,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: true,
      scrollback: 10000,
      theme: initialTheme.terminal,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    fitAddon.fit();

    // 2. 键盘输入队列顺序投递与批处理，杜绝并发竞争与按键丢失
    let inputQueue: string[] = [];
    let isSending = false;

    const flushInputQueue = async () => {
      if (isSending || inputQueue.length === 0) return;
      isSending = true;
      try {
        while (inputQueue.length > 0) {
          const chunk = inputQueue.join('');
          inputQueue = [];
          if (window.__TAURI_INTERNALS__) {
            await Promise.race([
              invoke('send_terminal_input', {
                sessionId: tab.sessionId,
                isSsh: tab.isSsh,
                data: chunk,
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('发送终端输入超时')), 5000)
              ),
            ]);
          }
        }
      } catch (err) {
        console.error('发送终端输入异常:', err);
      } finally {
        isSending = false;
        if (inputQueue.length > 0) {
          setTimeout(flushInputQueue, 10);
        }
      }
    };

    const onDataDisposable = term.onData((data) => {
      // 只有当前终端标签处于激活状态时才处理并向后端发送按键输入，杜绝后台隐藏标签按键串扰
      if (!isActiveRef.current) return;
      inputQueue.push(data);
      flushInputQueue();
    });

    // 3. 建立会话流式通道
    const setupConnection = async () => {
      if (!window.__TAURI_INTERNALS__) {
        term.writeln('\x1b[32m[本地预览模式]\x1b[0m 正在模拟终端连接至 ' + tab.title);
        term.writeln('ANSI 颜色支持测试:');
        term.writeln(
          '  \x1b[31m[错误 Red]\x1b[0m  \x1b[32m[成功 Green]\x1b[0m  \x1b[33m[警告 Yellow]\x1b[0m  \x1b[34m[路径 Blue]\x1b[0m  \x1b[35m[标量 Magenta]\x1b[0m  \x1b[36m[信息 Cyan]\x1b[0m'
        );
        term.write('\r\n\x1b[32mroot@' + (tab.server?.name || 'local') + '\x1b[0m:\x1b[34m~\x1b[0m# ');

        term.onData((d) => {
          if (d === '\r') {
            term.write('\r\n\x1b[32mroot@' + (tab.server?.name || 'local') + '\x1b[0m:\x1b[34m~\x1b[0m# ');
          } else if (d === '\u007f') {
            term.write('\b \b');
          } else {
            term.write(d);
          }
        });
        setTabConnected(tab.id, true);
        return;
      }

      const channel = new Channel<{ session_id: string; data: string }>();
      channel.onmessage = (payload) => {
        term.write(payload.data);
      };

      try {
        if (tab.isSsh && tab.server) {
          term.writeln(`\x1b[90m正在建立 SSH 连接 ${tab.server.host}:${tab.server.port} (${tab.server.username})...\x1b[0m`);
          await invoke('connect_ssh_terminal', {
            sessionId: tab.sessionId,
            options: {
              host: tab.server.host,
              port: tab.server.port,
              username: tab.server.username,
              auth_type: tab.server.auth_type,
              credential: tab.server.credential || null,
              passphrase: tab.server.passphrase || null,
              cols: term.cols,
              rows: term.rows,
            },
            channel,
          });
          setTabConnected(tab.id, true);
        } else {
          await invoke('start_local_terminal', {
            sessionId: tab.sessionId,
            cols: term.cols,
            rows: term.rows,
            channel,
          });
          setTabConnected(tab.id, true);
        }
      } catch (err: any) {
        term.writeln(`\r\n\x1b[31m[连接失败] ${err?.message || err}\x1b[0m\r\n`);
        setTabConnected(tab.id, false);
      }
    };

    setupConnectionRef.current = setupConnection;
    setupConnection();
    setTimeout(() => {
      term.focus();
    }, 80);

    // 4. 监听容器尺寸调整
    const handleResize = () => {
      if (!containerRef.current || !termRef.current || !fitAddonRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      // 只有容器具有实际可见宽高时才进行排版和后端同步，防止非可视状态下被计算为异常极小尺寸
      if (clientWidth < 120 || clientHeight < 60) return;

      try {
        fitAddonRef.current.fit();
        const cols = termRef.current.cols;
        const rows = termRef.current.rows;
        if (cols >= 20 && rows >= 5 && window.__TAURI_INTERNALS__) {
          invoke('resize_terminal', {
            sessionId: tab.sessionId,
            isSsh: tab.isSsh,
            cols,
            rows,
          }).catch(() => {});
        }
      } catch {}
    };

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    resizeObserver.observe(containerRef.current);

    setTimeout(() => {
      handleResize();
    }, 80);
    setTimeout(() => {
      handleResize();
    }, 200);

    return () => {
      setupConnectionRef.current = null;
      onDataDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [tab.id]);

  // 动态响应当前标签激活，自动聚焦并全面重新排版与同步远端 PTY
  useEffect(() => {
    if (isActive && termRef.current) {
      if (termRef.current.textarea) {
        termRef.current.textarea.tabIndex = 0;
      }

      const focusActiveTerminal = () => {
        if (!termRef.current || !isActiveRef.current) return;
        termRef.current.focus();
        if (termRef.current.textarea) {
          termRef.current.textarea.tabIndex = 0;
          termRef.current.textarea.focus({ preventScroll: true });
        }
      };

      const resize = () => {
        if (!containerRef.current || !termRef.current || !fitAddonRef.current) return;
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth < 120 || clientHeight < 60) return;
        try {
          fitAddonRef.current.fit();
          const cols = termRef.current.cols;
          const rows = termRef.current.rows;
          if (cols >= 20 && rows >= 5 && window.__TAURI_INTERNALS__) {
            invoke('resize_terminal', {
              sessionId: tab.sessionId,
              isSsh: tab.isSsh,
              cols,
              rows,
            }).catch(() => {});
          }
        } catch {}
      };

      resize();
      focusActiveTerminal();

      const rAF = requestAnimationFrame(() => {
        resize();
        focusActiveTerminal();
      });

      const t1 = setTimeout(() => {
        resize();
        focusActiveTerminal();
      }, 50);

      const t2 = setTimeout(() => {
        resize();
        focusActiveTerminal();
      }, 150);

      return () => {
        cancelAnimationFrame(rAF);
        clearTimeout(t1);
        clearTimeout(t2);
      };
    } else if (!isActive && termRef.current) {
      termRef.current.blur();
      if (termRef.current.textarea) {
        termRef.current.textarea.tabIndex = -1;
        termRef.current.textarea.blur();
      }
    }
  }, [isActive, tab.sessionId, tab.isSsh]);

  // 动态响应主题切换，即时刷新 xterm 配色与文字类型颜色
  useEffect(() => {
    if (termRef.current) {
      const theme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;
      termRef.current.options.theme = theme.terminal;
    }
  }, [themeId]);

  // 动态响应字体大小变更并重新自适应排版
  useEffect(() => {
    if (termRef.current && terminalFontSize) {
      termRef.current.options.fontSize = terminalFontSize;
      if (containerRef.current && fitAddonRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth >= 120 && clientHeight >= 60) {
          try {
            fitAddonRef.current.fit();
            const cols = termRef.current.cols;
            const rows = termRef.current.rows;
            if (cols >= 20 && rows >= 5 && window.__TAURI_INTERNALS__) {
              invoke('resize_terminal', {
                sessionId: tab.sessionId,
                isSsh: tab.isSsh,
                cols,
                rows,
              }).catch(() => {});
            }
          } catch {}
        }
      }
    }
  }, [terminalFontSize, tab.sessionId, tab.isSsh]);

  // 响应 SFTP 侧抽屉关闭或标签激活，自动聚焦并重新校准尺寸
  useEffect(() => {
    if (isActive && termRef.current) {
      const syncSize = () => {
        if (!containerRef.current || !termRef.current || !fitAddonRef.current) return;
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth < 120 || clientHeight < 60) return;
        try {
          fitAddonRef.current.fit();
          const cols = termRef.current.cols;
          const rows = termRef.current.rows;
          if (cols >= 20 && rows >= 5 && window.__TAURI_INTERNALS__) {
            invoke('resize_terminal', {
              sessionId: tab.sessionId,
              isSsh: tab.isSsh,
              cols,
              rows,
            }).catch(() => {});
          }
        } catch {}
      };

      syncSize();
      const timer = setTimeout(() => {
        syncSize();
        termRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isSftpDrawerOpen, isActive, tab.sessionId, tab.isSsh]);

  // 监听窗口尺寸调整
  useEffect(() => {
    const handleWinResize = () => {
      if (isActive && containerRef.current && termRef.current && fitAddonRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth < 120 || clientHeight < 60) return;
        try {
          fitAddonRef.current.fit();
          const cols = termRef.current.cols;
          const rows = termRef.current.rows;
          if (cols >= 20 && rows >= 5 && window.__TAURI_INTERNALS__) {
            invoke('resize_terminal', {
              sessionId: tab.sessionId,
              isSsh: tab.isSsh,
              cols,
              rows,
            }).catch(() => {});
          }
        } catch {}
      }
    };
    window.addEventListener('resize', handleWinResize);
    return () => window.removeEventListener('resize', handleWinResize);
  }, [isActive, tab.sessionId, tab.isSsh]);

  // 监听全局聚焦与重聚焦指令事件
  useEffect(() => {
    const handleRefocus = (e?: Event) => {
      const customEvent = e as CustomEvent<{ tabId?: string }> | undefined;
      if (customEvent?.detail?.tabId && customEvent.detail.tabId !== tab.id) {
        return;
      }
      if (isActive && termRef.current) {
        termRef.current.focus();
        if (termRef.current.textarea) {
          termRef.current.textarea.tabIndex = 0;
          termRef.current.textarea.focus({ preventScroll: true });
        }
      }
    };
    window.addEventListener('terminal:refocus', handleRefocus);
    window.addEventListener('focus', handleRefocus);
    return () => {
      window.removeEventListener('terminal:refocus', handleRefocus);
      window.removeEventListener('focus', handleRefocus);
    };
  }, [isActive, tab.id]);

  // 容器点击时确保直接穿透聚焦到 xterm 内部输入组件
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const focusTerm = () => {
      if (isActiveRef.current && termRef.current) {
        termRef.current.focus();
        if (termRef.current.textarea) {
          termRef.current.textarea.tabIndex = 0;
          termRef.current.textarea.focus({ preventScroll: true });
        }
      }
    };
    el.addEventListener('mousedown', focusTerm);
    el.addEventListener('click', focusTerm);
    return () => {
      el.removeEventListener('mousedown', focusTerm);
      el.removeEventListener('click', focusTerm);
    };
  }, []);

  // 响应来自二级工作条的清屏、复制与重试动作
  useEffect(() => {
    const onClear = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId: string }>;
      if (!customEvent.detail?.tabId || customEvent.detail.tabId === tab.id) {
        termRef.current?.clear();
      }
    };
    const onCopy = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId: string }>;
      if (!customEvent.detail?.tabId || customEvent.detail.tabId === tab.id) {
        termRef.current?.selectAll();
        const text = termRef.current?.getSelection();
        if (text) {
          navigator.clipboard.writeText(text);
          termRef.current?.clearSelection();
        }
      }
    };
    const onRetry = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId: string }>;
      if (!customEvent.detail?.tabId || customEvent.detail.tabId === tab.id) {
        if (termRef.current) {
          termRef.current.clear();
          setupConnectionRef.current?.();
        }
      }
    };

    window.addEventListener('terminal:clear', onClear);
    window.addEventListener('terminal:copy-all', onCopy);
    window.addEventListener('terminal:retry', onRetry);

    return () => {
      window.removeEventListener('terminal:clear', onClear);
      window.removeEventListener('terminal:copy-all', onCopy);
      window.removeEventListener('terminal:retry', onRetry);
    };
  }, [tab.id]);

  return (
    <div
      className="flex-1 w-full h-full overflow-hidden transition-colors duration-200 cursor-text"
      style={{ backgroundColor: currentTheme.ui.terminalBg }}
      onClick={() => {
        if (isActive) {
          termRef.current?.focus();
          if (termRef.current?.textarea) {
            termRef.current.textarea.tabIndex = 0;
            termRef.current.textarea.focus({ preventScroll: true });
          }
        }
      }}
      onMouseDown={() => {
        if (isActive) {
          termRef.current?.focus();
          if (termRef.current?.textarea) {
            termRef.current.textarea.tabIndex = 0;
            termRef.current.textarea.focus({ preventScroll: true });
          }
        }
      }}
    >
      <div
        ref={containerRef}
        className="w-full h-full p-2 overflow-hidden select-text"
        style={{ backgroundColor: currentTheme.ui.terminalBg }}
      />
    </div>
  );
};
