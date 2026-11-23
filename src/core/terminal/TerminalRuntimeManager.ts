import type { ITheme } from '@xterm/xterm';
import type { ISearchOptions } from '@xterm/addon-search';
import type { TerminalTab } from '../../types';
import { BUILTIN_THEMES, type ThemeId } from '../../types/theme';
import { isWindowsPlatform } from '../../lib/platform';
import { registerPtyBridge, unregisterPtyBridge } from '../../lib/terminal/ptyBridge';
import { TerminalView } from '../../components/terminal/TerminalView';
import { TerminalSession } from '../../components/terminal/TerminalSession';
import { TerminalInput } from '../../components/terminal/TerminalInput';
import { TerminalResize } from '../../components/terminal/TerminalResize';
import { TerminalFocus } from '../../components/terminal/TerminalFocus';

export interface TerminalUiCallbacks {
  onOpenSearch?: () => void;
  onMultiLinePaste?: (text: string) => void;
  onZoomFont?: (delta: number) => void;
  onConnectedChange?: (tabId: string, connected: boolean) => void;
  onLatencyChange?: (tabId: string, latencyMs: number | null) => void;
  onConnectedOnce?: () => void;
  onInputError?: (err: Error) => void;
}

export interface TerminalController {
  focus: (force?: boolean) => void;
  clear: () => void;
  copyAll: () => void;
  retry: () => Promise<void>;
  findNext: (term: string, options?: ISearchOptions) => boolean;
  findPrevious: (term: string, options?: ISearchOptions) => boolean;
  clearSearch: () => void;
  getSelection: () => string;
  clearSelection: () => void;
  paste: (text: string) => void;
  triggerSafePaste: (text: string) => void;
  getRecentBufferText: (maxLines?: number) => string;
  syncResize: (force?: boolean) => void;
  hasConnectedOnce: () => boolean;
}

interface RuntimeInstance {
  tab: TerminalTab;
  hostEl: HTMLDivElement;
  view: TerminalView;
  session: TerminalSession;
  input: TerminalInput;
  resize: TerminalResize;
  focus: TerminalFocus;
  isActive: boolean;
  hasOpened: boolean;
  hasConnectedOnce: boolean;
  isDisposed: boolean;
  uiCallbacks: TerminalUiCallbacks;
  layoutTimers: Array<ReturnType<typeof setTimeout>>;
}

export class TerminalRuntimeManager {
  private instances = new Map<string, RuntimeInstance>();

  public ensureInstance(
    tab: TerminalTab,
    options: { themeId: ThemeId; fontSize: number; isActive: boolean },
    callbacks: TerminalUiCallbacks
  ): TerminalController {
    const existing = this.instances.get(tab.sessionId);
    if (existing && !existing.isDisposed) {
      existing.tab = tab;
      existing.isActive = options.isActive;
      existing.uiCallbacks = callbacks;
      existing.session.updateTab(tab);
      existing.focus.updateTabId(tab.id);
      return this.createController(existing);
    }

    const theme = BUILTIN_THEMES[options.themeId] || BUILTIN_THEMES.aliyun;
    const hostEl = document.createElement('div');
    hostEl.className = 'w-full h-full overflow-hidden';
    hostEl.style.backgroundColor = theme.ui.terminalBg;

    const view = new TerminalView({
      fontSize: options.fontSize || 14,
      theme: theme.terminal,
      enableWebgl: true,
    });

    const instance: RuntimeInstance = {
      tab,
      hostEl,
      view,
      session: null as unknown as TerminalSession,
      input: null as unknown as TerminalInput,
      resize: null as unknown as TerminalResize,
      focus: null as unknown as TerminalFocus,
      isActive: options.isActive,
      hasOpened: false,
      hasConnectedOnce: false,
      isDisposed: false,
      uiCallbacks: callbacks,
      layoutTimers: [],
    };

    const session = new TerminalSession({
      tab,
      onOutput: (data) => {
        view.write(data);
      },
      onConnectedChange: (connected) => {
        if (connected && !instance.hasConnectedOnce) {
          instance.hasConnectedOnce = true;
          instance.uiCallbacks.onConnectedOnce?.();
        }
        instance.uiCallbacks.onConnectedChange?.(instance.tab.id, connected);
      },
      onLatencyChange: (latencyMs) => {
        instance.uiCallbacks.onLatencyChange?.(instance.tab.id, latencyMs);
      },
      onInputError: (err) => {
        instance.uiCallbacks.onInputError?.(err);
      },
    });

    const input = new TerminalInput({
      view,
      session,
      getIsActive: () => instance.isActive,
      onOpenSearch: () => instance.uiCallbacks.onOpenSearch?.(),
      onMultiLinePaste: (text) => instance.uiCallbacks.onMultiLinePaste?.(text),
      onZoomFont: (delta) => instance.uiCallbacks.onZoomFont?.(delta),
    });

    const resize = new TerminalResize({
      container: hostEl,
      view,
      session,
      getIsActive: () => instance.isActive,
    });

    const focus = new TerminalFocus({
      tabId: tab.id,
      sessionId: tab.sessionId,
      view,
      container: hostEl,
      getIsActive: () => instance.isActive,
    });

    instance.session = session;
    instance.input = input;
    instance.resize = resize;
    instance.focus = focus;

    this.instances.set(tab.sessionId, instance);

    registerPtyBridge(tab.sessionId, {
      sendInput: (data: string) => session.send(data),
      getRecentScreenText: (maxLines = 45) => view.getRecentBufferText(maxLines),
      subscribeOutput: (listener) => session.subscribeOutput(listener),
      isWindowsLocal: !tab.isSsh && isWindowsPlatform(),
    });

    return this.createController(instance);
  }

  public attach(sessionId: string, mountEl: HTMLElement): void {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed) return;

    if (instance.hostEl.parentElement !== mountEl) {
      mountEl.appendChild(instance.hostEl);
    }

    if (!instance.hasOpened) {
      instance.hasOpened = true;
      instance.view.open(instance.hostEl);
      this.bootstrapConnect(instance);
    } else {
      instance.resize.sync(true);
      instance.view.refresh();
    }

    if (instance.isActive) {
      instance.focus.onActiveChange(true);
    }
  }

  public detach(sessionId: string, mountEl: HTMLElement): void {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed) return;
    if (instance.hostEl.parentElement === mountEl) {
      mountEl.removeChild(instance.hostEl);
    }
  }

  public setUiCallbacks(sessionId: string, callbacks: TerminalUiCallbacks): void {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed) return;
    instance.uiCallbacks = callbacks;
  }

  public updateTab(tab: TerminalTab): void {
    const instance = this.instances.get(tab.sessionId);
    if (!instance || instance.isDisposed) return;
    instance.tab = tab;
    instance.session.updateTab(tab);
    instance.focus.updateTabId(tab.id);
  }

  public setActive(sessionId: string, isActive: boolean): void {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed) return;
    instance.isActive = isActive;
    if (isActive) {
      instance.resize.sync();
      instance.focus.onActiveChange(true);
    } else {
      instance.focus.onActiveChange(false);
    }
  }

  public setTheme(sessionId: string, terminalTheme: ITheme, terminalBg: string): void {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed) return;
    instance.hostEl.style.backgroundColor = terminalBg;
    instance.view.setTheme(terminalTheme);
  }

  public setFontSize(sessionId: string, fontSize: number): void {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed) return;
    instance.view.setFontSize(fontSize);
    instance.resize.sync(true);
  }

  public syncResize(sessionId: string, force = false): void {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed) return;
    instance.resize.sync(force);
  }

  public onFontsReady(sessionId: string): void {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed || !instance.hasOpened) return;
    instance.view.applyIntegerLineHeight();
    instance.resize.sync(true);
    instance.view.refresh();
  }

  public getController(sessionId: string): TerminalController | null {
    const instance = this.instances.get(sessionId);
    if (!instance || instance.isDisposed) return null;
    return this.createController(instance);
  }

  public destroy(sessionId: string): void {
    const instance = this.instances.get(sessionId);
    if (!instance) return;

    instance.isDisposed = true;
    instance.layoutTimers.forEach(clearTimeout);
    instance.layoutTimers = [];

    unregisterPtyBridge(sessionId);
    instance.focus.dispose();
    instance.resize.dispose();
    instance.input.dispose();
    instance.session.dispose();
    instance.view.dispose();
    instance.hostEl.remove();

    this.instances.delete(sessionId);
  }

  private bootstrapConnect(instance: RuntimeInstance): void {
    const bootstrap = (attempt: number) => {
      if (instance.isDisposed) return;
      const initialSize = instance.resize.sync(true);
      if (initialSize) {
        instance.view.applyIntegerLineHeight();
        const size = instance.resize.sync(true) ?? initialSize;
        instance.session.connect(size.cols, size.rows).then(() => {
          if (instance.isDisposed) return;
          instance.resize.resetAppliedSize();
          instance.resize.sync(true);
          instance.view.refresh();
        });
        return;
      }
      if (attempt < 24) {
        requestAnimationFrame(() => bootstrap(attempt + 1));
        return;
      }
      instance.session.connect(instance.view.cols, instance.view.rows);
    };

    bootstrap(0);

    instance.layoutTimers = [80, 200].map((delay) =>
      setTimeout(() => {
        if (!instance.isDisposed) {
          instance.resize.sync();
        }
      }, delay)
    );
  }

  private createController(instance: RuntimeInstance): TerminalController {
    return {
      focus: (force = false) => instance.focus.focus(force),
      clear: () => instance.view.clear(),
      copyAll: () => {
        instance.view.selectAll();
        const text = instance.view.getSelection();
        if (text) {
          navigator.clipboard.writeText(text).catch(() => {});
          instance.view.clearSelection();
        }
      },
      retry: async () => {
        instance.view.clear();
        await instance.session.retry(instance.view.cols, instance.view.rows);
        instance.resize.resetAppliedSize();
        instance.resize.sync(true);
        instance.focus.focus();
      },
      findNext: (term, opts) => instance.view.findNext(term, opts),
      findPrevious: (term, opts) => instance.view.findPrevious(term, opts),
      clearSearch: () => instance.view.clearSearch(),
      getSelection: () => instance.view.getSelection(),
      clearSelection: () => instance.view.clearSelection(),
      paste: (text) => instance.view.paste(text),
      triggerSafePaste: (text) => instance.input.triggerSafePaste(text),
      getRecentBufferText: (maxLines = 45) => instance.view.getRecentBufferText(maxLines),
      syncResize: (force = false) => {
        instance.resize.sync(force);
      },
      hasConnectedOnce: () => instance.hasConnectedOnce,
    };
  }
}

const GLOBAL_KEY = '__TINI_TERMINAL_RUNTIME__';

function getOrCreateRuntimeManager(): TerminalRuntimeManager {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new TerminalRuntimeManager();
  }
  return g[GLOBAL_KEY] as TerminalRuntimeManager;
}

export const terminalRuntimeManager = getOrCreateRuntimeManager();
