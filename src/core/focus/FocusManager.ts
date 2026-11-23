export type FocusScope = 'terminal' | 'overlay' | 'sftp' | 'ai' | 'modal';

interface ScopeEntry {
  id: string;
  scope: FocusScope;
}

export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if ((el as HTMLElement).classList?.contains('xterm-helper-textarea')) {
      return false;
    }
    return true;
  }
  return (el as HTMLElement).isContentEditable === true;
}

export class FocusManager {
  private scopeStack: ScopeEntry[] = [];
  private terminalFocusers = new Map<string, () => void>();
  private activeSessionId: string | null = null;

  public pushScope(id: string, scope: FocusScope): void {
    this.scopeStack = this.scopeStack.filter((entry) => entry.id !== id);
    this.scopeStack.push({ id, scope });
  }

  public popScope(id: string, autoRefocus = true): void {
    const prevLen = this.scopeStack.length;
    this.scopeStack = this.scopeStack.filter((entry) => entry.id !== id);
    if (autoRefocus && prevLen !== this.scopeStack.length && this.canTerminalFocus()) {
      this.scheduleTerminalFocus();
    }
  }

  public hasScope(id: string): boolean {
    return this.scopeStack.some((entry) => entry.id === id);
  }

  public getActiveScope(): FocusScope {
    if (this.scopeStack.length === 0) return 'terminal';
    return this.scopeStack[this.scopeStack.length - 1].scope;
  }

  public canTerminalFocus(): boolean {
    return this.getActiveScope() === 'terminal';
  }

  public registerTerminal(sessionId: string, focusFn: () => void): () => void {
    this.terminalFocusers.set(sessionId, focusFn);
    return () => {
      if (this.terminalFocusers.get(sessionId) === focusFn) {
        this.terminalFocusers.delete(sessionId);
      }
    };
  }

  public setActiveTerminal(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  public getActiveTerminal(): string | null {
    return this.activeSessionId;
  }

  public requestTerminalFocus(
    sessionId?: string,
    options?: { force?: boolean }
  ): boolean {
    const force = options?.force === true;
    if (!force) {
      if (!this.canTerminalFocus()) return false;
      if (typeof document !== 'undefined' && isEditableElement(document.activeElement)) {
        return false;
      }
    }

    const targetId = sessionId ?? this.activeSessionId;
    if (!targetId) return false;

    const focusFn = this.terminalFocusers.get(targetId);
    if (!focusFn) return false;

    focusFn();
    return true;
  }

  public scheduleTerminalFocus(sessionId?: string, options?: { force?: boolean }): void {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        this.requestTerminalFocus(sessionId, options);
      });
    } else {
      setTimeout(() => {
        this.requestTerminalFocus(sessionId, options);
      }, 0);
    }
  }

  public reset(): void {
    this.scopeStack = [];
    this.terminalFocusers.clear();
    this.activeSessionId = null;
  }
}

const GLOBAL_KEY = '__TINI_FOCUS_MANAGER__';

function getOrCreateFocusManager(): FocusManager {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new FocusManager();
  }
  return g[GLOBAL_KEY] as FocusManager;
}

export const focusManager = getOrCreateFocusManager();
