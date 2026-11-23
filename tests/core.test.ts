import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FocusManager, isEditableElement } from '../src/core/focus/FocusManager.ts';
import { TerminalInputStream } from '../src/components/terminal/TerminalInputStream.ts';
import {
  formatBytes,
  formatPermissions,
  formatMtime,
} from '../src/components/sftp/sftpUtils.ts';
import { stripAnsi } from '../src/lib/agent/summary.ts';

describe('FocusManager', () => {
  it('allows terminal focus only when scope stack is at terminal', () => {
    const fm = new FocusManager();
    let focusCount = 0;
    fm.registerTerminal('s1', () => {
      focusCount++;
    });
    fm.setActiveTerminal('s1');

    assert.equal(fm.getActiveScope(), 'terminal');
    assert.equal(fm.requestTerminalFocus(), true);
    assert.equal(focusCount, 1);

    fm.pushScope('sftp-drawer', 'sftp');
    assert.equal(fm.getActiveScope(), 'sftp');
    assert.equal(fm.canTerminalFocus(), false);
    assert.equal(fm.requestTerminalFocus(), false);
    assert.equal(focusCount, 1);

    // Explicit force bypasses scope stack (e.g. direct canvas click)
    assert.equal(fm.requestTerminalFocus('s1', { force: true }), true);
    assert.equal(focusCount, 2);

    fm.popScope('sftp-drawer', false);
    assert.equal(fm.getActiveScope(), 'terminal');
    assert.equal(fm.requestTerminalFocus(), true);
    assert.equal(focusCount, 3);
  });

  it('maintains nested scopes and restores terminal scope only when all popped', () => {
    const fm = new FocusManager();
    fm.pushScope('sftp', 'sftp');
    fm.pushScope('modal', 'modal');
    assert.equal(fm.getActiveScope(), 'modal');

    fm.popScope('modal', false);
    assert.equal(fm.getActiveScope(), 'sftp');
    assert.equal(fm.canTerminalFocus(), false);

    fm.popScope('sftp', false);
    assert.equal(fm.getActiveScope(), 'terminal');
    assert.equal(fm.canTerminalFocus(), true);
  });

  it('distinguishes editable inputs from xterm-helper-textarea', () => {
    const normalInput = { tagName: 'INPUT', classList: { contains: () => false } } as unknown as Element;
    const xtermTextarea = {
      tagName: 'TEXTAREA',
      classList: { contains: (cls: string) => cls === 'xterm-helper-textarea' },
    } as unknown as Element;
    const plainDiv = { tagName: 'DIV', isContentEditable: false } as unknown as Element;

    assert.equal(isEditableElement(normalInput), true);
    assert.equal(isEditableElement(xtermTextarea), false);
    assert.equal(isEditableElement(plainDiv), false);
    assert.equal(isEditableElement(null), false);
  });
});

describe('TerminalInputStream', () => {
  it('flushes queued chunks in order and surfaces errors via onError', async () => {
    const received: string[] = [];
    const errors: string[] = [];
    const stream = new TerminalInputStream(
      async (chunk) => {
        if (chunk.includes('FAIL')) {
          throw new Error('session closed');
        }
        received.push(chunk);
      },
      (err) => errors.push(err.message)
    );

    stream.push('ls');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(received, ['ls']);

    stream.push('FAIL');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(errors, ['session closed']);
    stream.dispose();
  });
});

describe('sftpUtils & summary', () => {
  it('formats bytes, octal permissions, and timestamps', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
    assert.equal(formatPermissions(0o755), 'rwxr-xr-x (755)');
    assert.equal(formatPermissions(0o644), 'rw-r--r-- (644)');
    assert.equal(formatMtime(0), '-');
  });

  it('strips ANSI escape sequences cleanly', () => {
    assert.equal(stripAnsi('\x1b[32mhello\x1b[0m \x1b[1;31mworld\x1b[0m'), 'hello world');
  });
});
