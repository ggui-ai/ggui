/**
 * Pin (ggui#1103): a mount that paints NOTHING is never silent.
 *
 * `wrapped` is `null` whenever the renderer holds no component, so the scope
 * element carries only its `<style>` — height 0, no text — and the error
 * boundary never engages, because it wraps a null child. That is the blank
 * hello ir measured on 1 of 8 Mosaic takes (scope div at height 0 inside a
 * session-root `ul` at 0). Before this cut the two empty-code paths reported
 * on NO channel and the update-eval-failure path wrote no console line, so a
 * blank card could not be told apart from a card whose module threw.
 *
 * Every one of the four null paths now reports on three channels: an
 * operator-visible console line, the caller's `onError`, and the host's
 * observability seam (`component-empty { where, reason }`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { mountReactRoot } from '../react-renderer.js';

interface PostedEvent {
  readonly kind?: string;
  readonly where?: string;
  readonly reason?: string;
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function flush(fn: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

/** The observability seam posts to the parent window; capture what it sends. */
function captureObservability(): { readonly events: PostedEvent[]; restore: () => void } {
  const events: PostedEvent[] = [];
  const original = window.parent.postMessage.bind(window.parent);
  const spy = vi.spyOn(window.parent, 'postMessage').mockImplementation((message: unknown) => {
    const m = message as { type?: string; event?: PostedEvent };
    const event = m?.event;
    if (event !== undefined) events.push(event);
  });
  return { events, restore: () => { spy.mockRestore(); void original; } };
}

describe('a mount that paints nothing reports on every channel (ggui#1103)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('mount with NO component code: a console warning + component-empty { mount, no-code } — the scope div really is empty, and onError stays the "something threw" channel', async () => {
    const seam = captureObservability();
    const onError = vi.fn();
    const container = makeContainer();
    await flush(async () => {
      await mountReactRoot(container, { render: { componentCode: '   ' }, onError });
    });
    const scope = container.querySelector('div[class^="ggui-rcr-"]');
    expect(scope).not.toBeNull();
    // The artefact this row exists for: only the stylesheet, no text.
    expect(scope!.querySelectorAll(':scope > *')).toHaveLength(1);
    expect(scope!.querySelector(':scope > style')).not.toBeNull();
    // Nothing outside the stylesheet: the card shows no text at all.
    const styleText = scope!.querySelector(':scope > style')?.textContent ?? '';
    expect((scope!.textContent ?? '').replace(styleText, '').replace(/\s/g, '')).toBe('');

    // Nothing threw, so `onError` is NOT called — a host that paints an error
    // panel must not paint one for a payload that simply carried no code.
    expect(onError).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/painted nothing \(no-code\) — mount carried no component code/);
    expect(seam.events.filter((e) => e.kind === 'component-empty')).toEqual([
      { kind: 'component-empty', where: 'mount', reason: 'no-code' },
    ]);
    seam.restore();
  });

  it('mount whose module throws: the same three channels with reason eval-failed', async () => {
    const seam = captureObservability();
    const onError = vi.fn();
    const container = makeContainer();
    await flush(async () => {
      await mountReactRoot(container, { render: { componentCode: 'throw new Error("boom");' }, onError });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]![0])).toMatch(/painted nothing \(eval-failed\)/);
    expect(seam.events.filter((e) => e.kind === 'component-empty')).toEqual([
      { kind: 'component-empty', where: 'mount', reason: 'eval-failed' },
    ]);
    seam.restore();
  });

  it('an UPDATE that carries no code reports where: update (it was silent on every channel before)', async () => {
    const seam = captureObservability();
    const onError = vi.fn();
    const container = makeContainer();
    let handle: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      handle = await mountReactRoot(container, { render: { componentCode: 'throw new Error("first");' }, onError });
    });
    seam.events.length = 0;
    errorSpy.mockClear();
    warnSpy.mockClear();
    onError.mockClear();
    await flush(async () => {
      await handle!.update({ render: { componentCode: '' }, onError });
    });
    expect(seam.events.filter((e) => e.kind === 'component-empty')).toEqual([
      { kind: 'component-empty', where: 'update', reason: 'no-code' },
    ]);
    expect(onError).not.toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/the update painted nothing \(no-code\)/);
    seam.restore();
  });
});
