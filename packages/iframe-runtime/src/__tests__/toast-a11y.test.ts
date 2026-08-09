/**
 * Assistive-technology surface of the iframe runtime's transient
 * feedback (ggui#447).
 *
 * The runtime has exactly two transient surfaces a user can be told
 * something through: the shared toast primitive (every dispatch state —
 * pending, the doorbell's action-required notice, the relay-incapability
 * notice, the post-self-heal recovery toast, terminal errors) and the
 * relay dead-zone cue (ggui#442). Both were purely visual: the toast was
 * a bare `<div>` with no live-region semantics, and the cue is an
 * opacity animation on somebody else's control. A screen-reader user
 * pressing a button got nothing back from either.
 *
 * What these specs pin, in the order the bug actually bites:
 *
 *   1. The live regions EXIST, empty, before any message can land in
 *      them. This is the classic live-region defect — a region created
 *      in the same tick as its first content was never registered with
 *      the screen reader, so the first announcement (the one confirming
 *      the user's first gesture) is silently dropped. Pinning it needs
 *      node IDENTITY: the region that receives the text must be the
 *      same object that already existed.
 *   2. Politeness is routed, not swapped — informational states speak
 *      through a `role="status"` region, failures and action-required
 *      notices through a `role="alert"` one, and only one carries text
 *      at a time.
 *   3. The visible toast stays out of the accessibility tree (it is a
 *      visual duplicate of the announcement) EXCEPT when it is the
 *      action-required notice, which is the one toast the user has to
 *      operate — and therefore needs a role, a name and a tab stop.
 *   4. Hiding is total: no stale announcement, no orphan tab stop, no
 *      invisible click target left over the render.
 *
 * Assertions are on roles and attributes, never on styling or DOM
 * shape beyond what the semantics require.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import {
  __resetAppForTest,
  __resetRelayNoticeForTest,
  bootSequence,
  ensureToastAnnouncer,
  routeDispatch,
  setCurrentApp,
} from '../runtime.js';
import {
  __resetHostCapabilitiesForTest,
  setHostCapabilities,
} from '../host-capabilities.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

const ANNOUNCER_ID = '__ggui-toast-announcer__';
const TOAST_ID = '__ggui-action-toast__';
const CUE_CLASS = 'ggui-relay-cue-pulse';
const CUE_STYLE_ID = 'ggui-relay-cue-style';

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;
let transport: MockTransport;
let app: App;

beforeEach(async () => {
  postMessageSpy = vi.fn();
  originalPostMessage = window.parent.postMessage;
  Object.defineProperty(window.parent, 'postMessage', {
    value: postMessageSpy,
    configurable: true,
    writable: true,
  });

  __resetHostCapabilitiesForTest();
  __resetRelayNoticeForTest();
  document.getElementById(ANNOUNCER_ID)?.remove();
  document.getElementById(TOAST_ID)?.remove();
  document.getElementById(CUE_STYLE_ID)?.remove();
  document.querySelector('[data-ggui-session-root]')?.remove();

  const harness = buildBootHarness();
  transport = harness.transport;
  app = harness.app;
  await app.connect(transport);
  setCurrentApp(app);
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window.parent, 'postMessage', {
    value: originalPostMessage,
    configurable: true,
    writable: true,
  });
  __resetAppForTest();
});

function toastEl(): HTMLElement | null {
  return document.getElementById(TOAST_ID);
}

function region(politeness: 'polite' | 'assertive'): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `#${ANNOUNCER_ID} [data-ggui-toast-announce="${politeness}"]`,
  );
}

function fireGesture(actionName = 'archive'): void {
  routeDispatch({
    actionName,
    data: {},
    meta: { sessionId: 'sess_1', appId: 'app_1' },
    dispatchToolName: 'ggui_runtime_submit_action',
  });
}

/** A session root holding one focusable control, as a render would. */
function mountSessionRoot(): HTMLButtonElement {
  const root = document.createElement('ul');
  root.setAttribute('data-ggui-session-root', '');
  const btn = document.createElement('button');
  root.appendChild(btn);
  document.body.appendChild(root);
  return btn;
}

describe('toast announcer — the region exists before the content', () => {
  it('mounts both live regions, empty, with fixed politeness', () => {
    const regions = ensureToastAnnouncer(document);

    expect(regions).not.toBeNull();
    const polite = region('polite');
    const assertive = region('assertive');
    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();

    // Informational region: status/polite. Failure region: alert/
    // assertive. Both atomic — a toast is one sentence that only means
    // anything whole, so the region is read, not the diff.
    expect(polite?.getAttribute('role')).toBe('status');
    expect(polite?.getAttribute('aria-live')).toBe('polite');
    expect(polite?.getAttribute('aria-atomic')).toBe('true');
    expect(assertive?.getAttribute('role')).toBe('alert');
    expect(assertive?.getAttribute('aria-live')).toBe('assertive');
    expect(assertive?.getAttribute('aria-atomic')).toBe('true');

    // Empty at mount — this is the whole point. A region that arrives
    // carrying its first message was never registered in time to
    // announce it.
    expect(polite?.textContent).toBe('');
    expect(assertive?.textContent).toBe('');
  });

  it('is visually hidden without leaving the accessibility tree', () => {
    ensureToastAnnouncer(document);
    const host = document.getElementById(ANNOUNCER_ID);

    // `display:none` / `visibility:hidden` would remove the regions
    // from the accessibility tree entirely, and content added to a
    // region that is not rendered is never announced. Clipping is the
    // technique that keeps them live.
    expect(host?.style.display).not.toBe('none');
    expect(host?.style.visibility).not.toBe('hidden');
    expect(host?.style.overflow).toBe('hidden');
    expect(host?.style.height).toBe('1px');
    // (`clip` / `clip-path` are asserted through the style attribute —
    // jsdom's CSSOM does not model either property.)
    expect(host?.getAttribute('style')).toContain('clip');
    expect(host?.getAttribute('aria-hidden')).toBeNull();
  });

  it('is idempotent — a second ensure reuses the same region nodes', () => {
    const first = ensureToastAnnouncer(document);
    const second = ensureToastAnnouncer(document);

    expect(second?.polite).toBe(first?.polite);
    expect(second?.assertive).toBe(first?.assertive);
    expect(document.querySelectorAll(`#${ANNOUNCER_ID}`)).toHaveLength(1);
  });

  it('the boot path mounts the regions before it does any IO', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const harness = buildBootHarness();
    const bootPromise = bootSequence({
      doc: dom,
      app: harness.app,
      transport: harness.transport,
      connectFn: async () => {
        throw new Error('unreachable — this boot never resolves meta');
      },
      notifyParent: vi.fn(),
      toolResultTimeoutMs: 10,
    });

    // Synchronously, before a single await has been yielded to: the
    // regions are already up. Every toast is at minimum a user gesture
    // away from here, so nothing can beat them into the document.
    const politeAtBoot = dom.querySelector(
      `#${ANNOUNCER_ID} [data-ggui-toast-announce="polite"]`,
    );
    expect(politeAtBoot).not.toBeNull();
    expect(politeAtBoot?.textContent).toBe('');

    await bootPromise;
  });

  it('announces into the very node that already existed', async () => {
    // Identity, not presence: a passing "the region has text" assertion
    // is satisfied just as well by a region created alongside its
    // content, which is the bug.
    const before = ensureToastAnnouncer(document);
    expect(before?.polite.textContent).toBe('');

    fireGesture();

    expect(region('polite')).toBe(before?.polite);
    expect(before?.polite.textContent).toBe('→ archive');
    await tick();
  });
});

describe('toast primitive — spoken and visual halves', () => {
  it('routes an informational state to the polite region', async () => {
    fireGesture();

    expect(region('polite')?.textContent).toBe('→ archive');
    expect(region('assertive')?.textContent).toBe('');
    await tick();
  });

  it('keeps the visible toast out of the accessibility tree', async () => {
    fireGesture();

    // The element carries the same sentence the region just announced.
    // Left in the tree it would be read a second time, and it is not a
    // control, so there is nothing else it contributes.
    expect(toastEl()?.getAttribute('aria-hidden')).toBe('true');
    expect(toastEl()?.getAttribute('role')).toBeNull();
    expect(toastEl()?.getAttribute('tabindex')).toBeNull();
    // Nor is it a click target: it sits fixed over the render at the
    // top of the z-order for the rest of the session.
    expect(toastEl()?.style.pointerEvents).toBe('none');
    await tick();
  });

  it('routes a terminal failure to the assertive region and clears the polite one', async () => {
    setHostCapabilities({ serverTools: {}, message: {} });
    transport.queueResponse('tools/call', {
      error: { code: -32000, message: 'relay exploded' },
    });

    fireGesture();
    // The pending state spoke first, politely.
    expect(region('polite')?.textContent).toBe('→ archive');
    await tick();
    await tick();

    // The failure interrupts, and the superseded pending message does
    // not stay behind for a user who navigates to the announcer.
    expect(region('assertive')?.textContent).toMatch(
      /could not reach the agent/i,
    );
    expect(region('polite')?.textContent).toBe('');
  });

  it('clears the announcement when the toast auto-dismisses', async () => {
    setHostCapabilities({ serverTools: {}, message: {} });
    transport.queueResponse('tools/call', {
      error: { code: -32000, message: 'relay exploded' },
    });
    // Fake timers BEFORE the gesture: the auto-dismiss timer is armed
    // inside it, and a timer scheduled on the real clock is not one the
    // fake clock can advance.
    vi.useFakeTimers();
    fireGesture();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(region('assertive')?.textContent).not.toBe('');

    await vi.advanceTimersByTimeAsync(3_000);

    // Spoken and visual halves go away together — the announcer must
    // not keep describing a toast that is no longer on screen.
    expect(toastEl()?.style.opacity).toBe('0');
    expect(region('assertive')?.textContent).toBe('');
    expect(region('polite')?.textContent).toBe('');
  });

  it('suppresses both halves under the operator override', async () => {
    Reflect.set(window, '__GGUI_TOAST_DISABLED__', true);
    try {
      ensureToastAnnouncer(document);
      fireGesture();

      // A host rendering its own toast chrome opted out of ours. It
      // must not get an invisible spoken copy of the surface it
      // replaced.
      expect(toastEl()).toBeNull();
      expect(region('polite')?.textContent).toBe('');
      expect(region('assertive')?.textContent).toBe('');
      await tick();
    } finally {
      Reflect.deleteProperty(window, '__GGUI_TOAST_DISABLED__');
    }
  });
});

describe('action-required notice — the one toast the user must operate', () => {
  /**
   * Drive the doorbell's action-required notice: the relay succeeded
   * but no `ggui_consume` long-poll is listening, so the gesture needs
   * a user follow-up in chat and the notice stands until dismissed.
   */
  async function showActionRequired(): Promise<HTMLElement> {
    setHostCapabilities({ serverTools: {}, message: {} });
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: false } },
    });
    fireGesture();
    await tick();
    await tick();
    const el = toastEl();
    expect(el).not.toBeNull();
    expect(el?.textContent).toMatch(/agent not listening/i);
    return el as HTMLElement;
  }

  it('is a named, focusable button — not a mouse-only div', async () => {
    const el = await showActionRequired();

    // This notice persists until the user closes it. A dismissal that
    // only a pointer can reach is a dismissal some users cannot
    // perform at all.
    expect(el.getAttribute('aria-hidden')).toBeNull();
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.style.pointerEvents).toBe('auto');
    // The name says what activating it DOES, not just what happened.
    const label = el.getAttribute('aria-label') ?? '';
    expect(label).toContain('agent not listening');
    expect(label).toMatch(/dismiss/i);
    // The message itself still interrupts — it asks for an action.
    expect(region('assertive')?.textContent).toMatch(/agent not listening/i);
  });

  it('dismisses on Enter and on Space, leaving nothing behind', async () => {
    for (const key of ['Enter', ' ']) {
      const el = await showActionRequired();

      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

      expect(el.style.opacity).toBe('0');
      // Hidden means hidden on every axis: no announcement, no tab
      // stop, no role, no click target.
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.getAttribute('role')).toBeNull();
      expect(el.getAttribute('tabindex')).toBeNull();
      expect(el.style.pointerEvents).toBe('none');
      expect(region('assertive')?.textContent).toBe('');
      expect(region('polite')?.textContent).toBe('');
    }
  });

  it('does not leave an ordinary toast wearing the notice’s control semantics', async () => {
    const el = await showActionRequired();
    expect(el.getAttribute('role')).toBe('button');

    // The primitive reuses ONE element for every state, so a later
    // pending toast inherits whatever the notice left on it unless the
    // control posture is reset on every show.
    fireGesture();

    expect(toastEl()?.getAttribute('role')).toBeNull();
    expect(toastEl()?.getAttribute('tabindex')).toBeNull();
    expect(toastEl()?.getAttribute('aria-label')).toBeNull();
    expect(toastEl()?.getAttribute('aria-hidden')).toBe('true');
    await tick();
  });
});

describe('relay dead-zone cue — the pulse speaks (ggui#442 + ggui#447)', () => {
  /**
   * Latch the relay-incapability notice the only legitimate way (a
   * relay-shaped failure on a host that advertised nothing) and dismiss
   * it the only way a user can, which arms the per-gesture cue.
   */
  async function latchAndDismiss(): Promise<void> {
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    fireGesture();
    await tick();
    await tick();
    const el = toastEl();
    expect(el?.textContent).toMatch(/cannot relay/i);
    el?.click();
  }

  it('announces the pulse it cannot express any other way', async () => {
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();
    // The dismissal cleared the notice from both halves.
    expect(region('assertive')?.textContent).toBe('');

    fireGesture();

    // The pulse is an opacity animation on a control the runtime does
    // not own — nothing about it reaches assistive technology, and
    // nothing may be written onto that control to fix it.
    expect(btn.classList.contains(CUE_CLASS)).toBe(true);
    expect(btn.getAttribute('role')).toBeNull();
    expect(btn.getAttribute('aria-label')).toBeNull();
    // So the meaning is carried in the runtime's own region instead.
    expect(region('assertive')?.textContent).toMatch(
      /archive.*not delivered/i,
    );
  });

  it('throttles an IDENTICAL repeat while the pulse stays per-gesture', async () => {
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();

    vi.useFakeTimers();
    fireGesture();
    const spoken = region('assertive')?.textContent ?? '';
    expect(spoken).toMatch(/archive.*not delivered/i);

    // Past the pulse AND past the cue's own expiry, so the next gesture
    // is a real second cue and the region is empty because PRODUCTION
    // retracted it — a spec that hand-clears here is testing its own
    // cleanup, not the runtime's.
    vi.advanceTimersByTime(2_500);
    expect(btn.classList.contains(CUE_CLASS)).toBe(false);
    expect(region('assertive')?.textContent).toBe('');

    fireGesture();
    // Pulsed again — a flash costs a sighted user nothing to ignore…
    expect(btn.classList.contains(CUE_CLASS)).toBe(true);
    // …but the identical sentence read aloud again would bury whatever
    // else the screen reader was saying, and it carries no new
    // information.
    expect(region('assertive')?.textContent).toBe('');

    // Past the quiet period it speaks again.
    vi.advanceTimersByTime(5_000);
    fireGesture();
    expect(region('assertive')?.textContent).toBe(spoken);
  });

  it('never lets the quiet period leave the WRONG action standing', async () => {
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();

    vi.useFakeTimers();
    fireGesture('archive');
    expect(region('assertive')?.textContent).toMatch(/archive/i);

    // A second, DIFFERENT gesture inside the quiet period. Let the
    // first pulse finish so this is a real cue and not the in-flight
    // short circuit.
    vi.advanceTimersByTime(1_000);
    fireGesture('delete-permanently');

    // Throttling on the clock alone would suppress this one and leave
    // the region still naming `archive` — a confident, spoken answer
    // about an action the user did not just attempt. That is worse than
    // silence, so a changed intent always speaks.
    expect(btn.classList.contains(CUE_CLASS)).toBe(true);
    expect(region('assertive')?.textContent).toMatch(/delete-permanently/i);
    expect(region('assertive')?.textContent).not.toMatch(/archive/i);
  });

  it('retracts the spoken cue instead of leaving it standing forever', async () => {
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();

    vi.useFakeTimers();
    fireGesture();
    expect(region('assertive')?.textContent).toMatch(/not delivered/i);

    // The pulse is 400ms. A live region describes what is happening
    // NOW, so the sentence must not outlive the thing it describes for
    // the rest of the session.
    vi.advanceTimersByTime(2_500);
    expect(region('assertive')?.textContent).toBe('');
  });

  it('a superseded cue’s expiry does not silence the one that replaced it', async () => {
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();

    vi.useFakeTimers();
    fireGesture('archive');
    // Second cue lands 1s in, so the FIRST cue's retraction is still
    // pending and due before the second one's.
    vi.advanceTimersByTime(1_000);
    fireGesture('delete-permanently');
    expect(region('assertive')?.textContent).toMatch(/delete-permanently/i);

    // Past the first cue's original deadline. An uncancelled timer — or
    // one that cleared the region unconditionally — would retract a
    // message that is only 1.5s old and still describing a live pulse.
    vi.advanceTimersByTime(1_600);
    expect(region('assertive')?.textContent).toMatch(/delete-permanently/i);

    // It goes on its own schedule, not its predecessor's.
    vi.advanceTimersByTime(1_000);
    expect(region('assertive')?.textContent).toBe('');
  });

  it('a returning intent is not cut short by its own earlier expiry', async () => {
    // The case the text guard alone cannot catch: intent A, then B,
    // then A again. The first A's retraction is still pending and its
    // remembered sentence matches the one now standing, so it clears a
    // message that is 600ms old unless the timer was cancelled when B
    // superseded it.
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();

    vi.useFakeTimers();
    fireGesture('archive');
    vi.advanceTimersByTime(1_000);
    fireGesture('delete-permanently');
    vi.advanceTimersByTime(1_000);
    fireGesture('archive');
    expect(region('assertive')?.textContent).toMatch(/archive/i);

    // Past the FIRST archive cue's deadline, well inside the third's.
    vi.advanceTimersByTime(600);
    expect(region('assertive')?.textContent).toMatch(/archive/i);
  });

  it('a cue’s expiry does not silence a toast that is still on screen', async () => {
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();

    vi.useFakeTimers();
    fireGesture('archive');
    expect(region('assertive')?.textContent).toMatch(/archive/i);

    // Same dead zone, but nothing focused now, so this gesture takes
    // the other cue shape: a real micro-toast, with its own 2.5s life.
    btn.blur();
    vi.advanceTimersByTime(1_000);
    fireGesture('publish');
    expect(toastEl()?.textContent).toMatch(/publish/i);
    expect(region('assertive')?.textContent).toMatch(/publish/i);

    // The earlier cue's retraction comes due here. It must not tidy up
    // by clearing the region wholesale — the sentence in there now
    // belongs to a toast the user can still see.
    vi.advanceTimersByTime(1_600);
    expect(toastEl()?.style.opacity).toBe('1');
    expect(region('assertive')?.textContent).toMatch(/publish/i);
  });

  it('speaks through the toast primitive when there is nothing to pulse', async () => {
    await latchAndDismiss();
    // Nothing focused: jsdom reports `document.body`, the "no usable
    // target" case that falls back to the micro-toast.
    expect(document.activeElement).toBe(document.body);

    fireGesture();

    expect(toastEl()?.textContent).toMatch(/archive.*not delivered/i);
    expect(region('assertive')?.textContent).toMatch(
      /archive.*not delivered/i,
    );
  });
});
