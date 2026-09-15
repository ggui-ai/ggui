/**
 * Pin (ggui#1109): the card FORWARDS the dismiss gesture and never acts on it.
 *
 * The row exists because an iframe swallows keys: a user who has just clicked
 * the card — the exact moment they press Escape — presses it into a document
 * the surrounding page cannot hear. The runtime had no keydown listener at all,
 * so a host could add a perfect one and still never learn of the gesture.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MCP_APP_DISMISS_TYPE, isMcpAppDismissMessage } from '@ggui-ai/protocol/integrations/mcp-apps';
import { installDismissIntentListener, removeDismissIntentListener } from '../dismiss-intent.js';

interface Posted { readonly type?: string; readonly reason?: string }

function capture(): { readonly posted: Posted[]; restore: () => void } {
  const posted: Posted[] = [];
  const spy = vi.spyOn(window.parent, 'postMessage').mockImplementation((message: unknown) => {
    posted.push(message as Posted);
  });
  return { posted, restore: () => spy.mockRestore() };
}

const press = (init: KeyboardEventInit): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(ev);
  return ev;
};

describe('the dismiss intent (ggui#1109)', () => {
  beforeEach(() => installDismissIntentListener(document));
  afterEach(() => removeDismissIntentListener(document));

  it('Escape inside the card posts ONE intent the host recognises', () => {
    const seam = capture();
    press({ key: 'Escape' });
    expect(seam.posted).toEqual([{ type: MCP_APP_DISMISS_TYPE, reason: 'escape' }]);
    expect(isMcpAppDismissMessage(seam.posted[0])).toBe(true);
    seam.restore();
  });

  it('does NOT consume the gesture — no preventDefault, no stopPropagation — so the card and the host both keep hearing it', () => {
    const seam = capture();
    const ev = press({ key: 'Escape' });
    expect(ev.defaultPrevented).toBe(false);
    seam.restore();
  });

  it('a held key auto-repeating is ONE gesture: repeats are skipped', () => {
    const seam = capture();
    press({ key: 'Escape' });
    press({ key: 'Escape', repeat: true });
    press({ key: 'Escape', repeat: true });
    expect(seam.posted).toHaveLength(1);
    seam.restore();
  });

  it('other keys say nothing, and the listener is idempotent (a re-boot cannot double-post)', () => {
    const seam = capture();
    press({ key: 'Enter' });
    press({ key: 'a' });
    expect(seam.posted).toEqual([]);
    installDismissIntentListener(document); // second boot in the same document
    press({ key: 'Escape' });
    expect(seam.posted).toHaveLength(1);
    seam.restore();
  });

  it('removing the listener stops the forwarding (teardown leaves no stray handler)', () => {
    const seam = capture();
    removeDismissIntentListener(document);
    press({ key: 'Escape' });
    expect(seam.posted).toEqual([]);
    seam.restore();
  });
});
