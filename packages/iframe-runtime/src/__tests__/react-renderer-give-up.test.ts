/**
 * ggui#1679 — the boundary's give-up is NAMED to the mount's caller.
 *
 * `RcrErrorBoundary` retries a throwing component once (`AUTO_RETRY_LIMIT`)
 * and then fires `onError`. That hook carries the error alone; nothing says
 * WHEN the card failed (its first paint, or a later re-render) or how many
 * catches it took, so no caller could report the failure in the server's
 * terms (`ggui_runtime_report_render_failure`: phase + catches). These specs
 * pin the new `onRenderFailure` hook beside `onError`:
 *
 *   - a component that throws on every render → one `onRenderFailure` with
 *     `{ phase: 'mount', catches: 2 }` and the thrown error;
 *   - a component that throws once and paints on the retry → no call (the
 *     control: a recovered card is not a failed one);
 *   - a painted card whose props update makes it throw → `{ phase: 'update' }`.
 *
 * Real timers: the boundary's retry is a 500 ms `setTimeout`; each spec waits
 * it out inside `act` rather than faking the clock under React's scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { mountReactRoot } from '../react-renderer.js';

const RETRY_WAIT_MS = 650;

// A card that throws in a concurrent render and then paints on React's own
// synchronous re-render is a "recoverable error": React reports it through
// `reportError`, which in this environment is a cancelable `ErrorEvent` on
// `window`. Captured here so the run stays clean — and so the controls can
// show the card did throw.
const recovered: unknown[] = [];
const captureRecoverable = (event: ErrorEvent): void => {
  if (String(event.message).includes('able to recover')) {
    recovered.push(event.error);
    event.preventDefault();
  }
};
beforeEach(() => {
  recovered.length = 0;
  window.addEventListener('error', captureRecoverable);
});
afterEach(() => {
  window.removeEventListener('error', captureRecoverable);
});

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

/** Waits past the boundary's auto-retry inside `act`, so the retried render commits. */
async function pastTheRetry(): Promise<void> {
  await flush(() => new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS)));
}

const ALWAYS_THROWS = 'export default () => { throw new RangeError("boom"); }';
// Throws on its first TWO renders: React's own synchronous re-render absorbs a
// single throw before any boundary sees it (a "recoverable error"), so a card
// that reaches the boundary once and paints on the boundary's retry is the
// one that throws twice.
const RECOVERS_ON_RETRY = 'let n = 0; export default () => { if (n++ < 2) throw new Error("twice"); return null; }';
const THROWS_ON_PROP = 'export default (props) => { if (props.boom) throw new TypeError("later"); return null; }';

describe('mountReactRoot — the boundary names its give-up (ggui#1679)', () => {
  it('a component that throws on every render: one onRenderFailure with phase mount, catches 2, and the thrown error', async () => {
    const container = makeContainer();
    const onRenderFailure = vi.fn();
    const onError = vi.fn();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'give_up_mount', componentCode: ALWAYS_THROWS },
        onError,
        onRenderFailure,
      });
    });
    await pastTheRetry();

    expect(onRenderFailure).toHaveBeenCalledTimes(1);
    const failure = onRenderFailure.mock.calls[0]?.[0] as { error: unknown; phase: string; catches: number };
    expect(failure.phase).toBe('mount');
    expect(failure.catches).toBe(2);
    // The card's module evaluates in the document's realm (a jsdom VM context
    // here), so the thrown value is read by name, not by `instanceof`.
    expect(failure.error).toMatchObject({ name: 'RangeError', message: 'boom' });
    // The existing hook still fires: the host's `onError` path is unchanged.
    expect(onError).toHaveBeenCalledTimes(1);
    mount!.unmount();
  });

  it('control: a component the boundary catches once and that paints on the retry is not a failure', async () => {
    const container = makeContainer();
    const onRenderFailure = vi.fn();
    const onError = vi.fn();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'give_up_recovers', componentCode: RECOVERS_ON_RETRY },
        onError,
        onRenderFailure,
      });
    });
    await pastTheRetry();

    expect(onRenderFailure).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    // The card did throw: React reported the recovery.
    expect(recovered.length).toBeGreaterThan(0);
    mount!.unmount();
  });

  it('a painted card whose props update makes it throw: phase update', async () => {
    const container = makeContainer();
    const onRenderFailure = vi.fn();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'give_up_update', componentCode: THROWS_ON_PROP, props: { boom: false } },
        onRenderFailure,
      });
    });
    expect(onRenderFailure).not.toHaveBeenCalled();

    await flush(async () => {
      await mount!.update({
        render: { id: 'give_up_update', componentCode: THROWS_ON_PROP, props: { boom: true } },
        onRenderFailure,
      });
    });
    await pastTheRetry();

    expect(onRenderFailure).toHaveBeenCalledTimes(1);
    const failure = onRenderFailure.mock.calls[0]?.[0] as { error: unknown; phase: string; catches: number };
    expect(failure.phase).toBe('update');
    expect(failure.catches).toBe(2);
    expect(failure.error).toMatchObject({ name: 'TypeError', message: 'later' });
    mount!.unmount();
  });
});
