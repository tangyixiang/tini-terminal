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
  isActiveRef.current = isActive;

  const tabRef = useRef(tab);
  tabRef.current = tab;

  const setTabConnected = useTerminalStore((state) => state.setTabConnected);
  const themeId = useSettingsStore((state) => state.themeId);
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const isSftpDrawerOpen = useSettingsStore((state) => state.isSftpDrawerOpen);
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const focusTerminal = () => {
    if (!termRef.current) return;
    try {
      termRef.current.focus();
      if (termRef.current.textarea) {
        termRef.current.textarea.focus({ preventScroll: true });
      }
    } catch {}
  };

  // 1. 初始化终端实例
  useEffect(() => {
    if (!containerRef.current) return;

    const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);
    const terminalFontFamily = isWindows
      ? "'Cascadia Mono', Consolas, 'Microsoft YaHei', monospace"
      : "Menlo, Monaco, 'PingFang SC', monospace";

    const initialTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

    const term = new Terminal({
      fontFamily: terminalFontFamily,
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
                sessionId: tabRef.current.sessionId,
                isSsh: tabRef.current.isSsh,
                data: chunk,
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('发送终端输入超时')), 3000)
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
              sessionId: tabRef.current.sessionId,
              isSsh: tabRef.current.isSsh,
              cols,
              rows,
            }).catch(() => {});
          }
        } catch {}
      };

      resize();
      focusTerminal();

      const rAF = requestAnimationFrame(() => {
        resize();
        focusTerminal();
      });

      const t1 = setTimeout(() => {
        resize();
        focusTerminal();
      }, 50);

      const t2 = setTimeout(() => {
        resize();
        focusTerminal();
      }, 150);

      return () => {
        cancelAnimationFrame(rAF);
        clearTimeout(t1);
        clearTimeout(t2);
      };
    } else if (!isActive && termRef.current) {
      termRef.current.blur();
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
      setTimeout(() => {
        if (isActiveRef.current) {
          focusTerminal();
        }
      }, 20);
    };
    window.addEventListener('terminal:refocus', handleRefocus);
    window.addEventListener('focus', handleRefocus);
    return () => {
      window.removeEventListener('terminal:refocus', handleRefocus);
      window.removeEventListener('focus', handleRefocus);
    };
  }, [tab.id]);

  // 全局快捷输入兜底：当终端处于激活状态时，非输入框区域的按键自动聚焦终端，杜绝按键丢失
  useEffect(() => {
    if (!isActive) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // 忽略单独按下的控制修饰键
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl === termRef.current?.textarea) return;

      // 如果当前焦点位于页面的其他有效输入控件内（如 AI 对话输入框、弹窗等），绝不抢占
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.isContentEditable ||
          activeEl.closest('[role="dialog"]') ||
          activeEl.closest('input') ||
          activeEl.closest('textarea'))
      ) {
        return;
      }

      focusTerminal();
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
    };
  }, [isActive]);

  // 监听字体加载就绪，自动重新计算排版布局
  useEffect(() => {
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (fitAddonRef.current && termRef.current) {
          try {
            fitAddonRef.current.fit();
            termRef.current.refresh(0, termRef.current.rows - 1);
          } catch {}
        }
      });
    }
  }, []);

  // 容器点击与鼠标按下时确保直接穿透聚焦到 xterm 内部输入组件
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleContainerFocus = () => {
      if (isActiveRef.current) {
        focusTerminal();
      }
    };
    el.addEventListener('mousedown', handleContainerFocus);
    el.addEventListener('click', handleContainerFocus);
    el.addEventListener('pointerdown', handleContainerFocus);
    return () => {
      el.removeEventListener('mousedown', handleContainerFocus);
      el.removeEventListener('click', handleContainerFocus);
      el.removeEventListener('pointerdown', handleContainerFocus);
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
      className="flex-1 w-full h-full overflow-hidden transition-colors duration-200 cursor-text relative"
      style={{ backgroundColor: currentTheme.ui.terminalBg }}
      onClick={() => {
        if (isActive) {
          focusTerminal();
        }
      }}
      onMouseDown={() => {
        if (isActive) {
          focusTerminal();
        }
      }}
    >
      <div
        ref={containerRef}
        className="w-full h-full p-2 overflow-hidden"
        style={{ backgroundColor: currentTheme.ui.terminalBg }}
      />
    </div>
  );
};
