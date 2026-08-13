/**
 * In-iframe UI-feedback chrome (ggui#244) — gate + envelope + payload
 * semantics.
 *
 * Covers the three obligations of the affordance:
 *
 *   1. Sink-reachability gate — mounts ONLY when a parent window
 *      exists (`win.parent !== win`); a top-level tab (the
 *      `/r/<shortCode>` share-link viewer) gets NO affordance, per
 *      the never-render-a-dead-affordance rule.
 *   2. Envelope shape — interaction emits through the observability
 *      seam; the default emitter posts
 *      `{type:'ggui:observe', event:{kind:'ui-feedback',…}}` to
 *      `window.parent`.
 *   3. Payload semantics — mirrors the host-chrome `UiFeedback` twin
 *      (`@ggui-ai/mcp-apps-react`): trimmed comment only on `verdict:'other'`,
 *      whitespace-only comments omitted, context stamps present
 *      exactly when supplied, dismissal emits nothing.
 *
 * The gate is driven through the injectable `win` seam (fake windows)
 * — no jsdom `window.parent` mutation; the envelope test reuses the
 * `vi.spyOn(window.parent, 'postMessage')` idiom from
 * `observability.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { fireEvent } from '@testing-library/react';
import {
  mountUiFeedbackChrome,
  type UiFeedbackChromeHandle,
} from '../ui-feedback-chrome.js';
import {
  postObservabilityToParent,
  type ObservabilityEvent,
  type ObservabilityMessage,
} from '../observability.js';

/** Fake window with a distinct parent — passes the gate. */
function framedWindow(): Window {
  return { parent: {} as Window } as Window;
}

/** Fake window that IS its own parent — top-level tab, gate fails. */
function topLevelWindow(): Window {
  const win = {} as { parent?: Window };
  win.parent = win as Window;
  return win as Window;
}

function eventSink() {
  return vi.fn<(event: ObservabilityEvent) => void>();
}

/** Strict querySelector — throws instead of returning null. */
function q(selector: string): Element {
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`expected element matching ${selector}`);
  return el;
}

const handles: UiFeedbackChromeHandle[] = [];

async function mount(
  opts: Omit<Parameters<typeof mountUiFeedbackChrome>[1], 'win'> & {
    win?: Window;
  },
): Promise<UiFeedbackChromeHandle | null> {
  let handle: UiFeedbackChromeHandle | null = null;
  await act(async () => {
    handle = await mountUiFeedbackChrome(document, {
      win: framedWindow(),
      ...opts,
    });
  });
  if (handle !== null) handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    act(() => {
      handle.unmount();
    });
  }
  document
    .querySelectorAll('[data-ggui-ui-feedback-chrome]')
    .forEach((el) => el.remove());
});

// =============================================================================
// 1. Sink-reachability gate
// =============================================================================

describe('mountUiFeedbackChrome — parent-window gate', () => {
  it('does not mount in a top-level tab (win.parent === win)', async () => {
    const emit = eventSink();
    const handle = await mount({ emit, win: topLevelWindow() });
    expect(handle).toBeNull();
    expect(document.querySelector('[data-ggui-ui-feedback-chrome]')).toBeNull();
    expect(document.querySelector('[data-ggui-ui-feedback]')).toBeNull();
  });

  it('mounts the affordance when a parent window exists', async () => {
    const emit = eventSink();
    const handle = await mount({ emit });
    expect(handle).not.toBeNull();
    const container = q('[data-ggui-ui-feedback-chrome]');
    expect(container.parentElement).toBe(document.body);
    expect(container.querySelector('[data-ggui-ui-feedback]')).not.toBeNull();
    expect(
      container.querySelector('[data-ggui-ui-feedback-verdict="love"]'),
    ).not.toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it('mounts adjacent to (after) the session root', async () => {
    const sessionRoot = document.createElement('ul');
    sessionRoot.setAttribute('data-ggui-session-root', '');
    document.body.appendChild(sessionRoot);
    try {
      await mount({ emit: eventSink() });
      const container = q('[data-ggui-ui-feedback-chrome]');
      // Chrome sits BELOW the rendered UI: session root precedes it.
      expect(
        sessionRoot.compareDocumentPosition(container) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      sessionRoot.remove();
    }
  });

  it('re-entrant mount replaces the previous container — never two affordances', async () => {
    await mount({ emit: eventSink() });
    await mount({ emit: eventSink() });
    expect(
      document.querySelectorAll('[data-ggui-ui-feedback-chrome]'),
    ).toHaveLength(1);
    expect(document.querySelectorAll('[data-ggui-ui-feedback]')).toHaveLength(1);
  });
});

// =============================================================================
// 2. Emitted envelope shape (default postMessage emitter)
// =============================================================================

describe('mountUiFeedbackChrome — ggui:observe envelope', () => {
  it('posts {type:"ggui:observe", event:{kind:"ui-feedback",…}} to window.parent', async () => {
    const posted: unknown[] = [];
    const spy = vi
      .spyOn(window.parent, 'postMessage')
      .mockImplementation((msg: unknown) => {
        posted.push(msg);
      });
    try {
      await mount({
        emit: postObservabilityToParent,
        sessionId: 'sess-envelope',
      });
      fireEvent.click(q('[data-ggui-ui-feedback-verdict="love"]'));
      expect(posted).toHaveLength(1);
      const msg = posted[0] as ObservabilityMessage;
      expect(msg.type).toBe('ggui:observe');
      expect(msg.event).toEqual({
        kind: 'ui-feedback',
        verdict: 'love',
        sessionId: 'sess-envelope',
      });
    } finally {
      spy.mockRestore();
    }
  });
});

// =============================================================================
// 3. Payload semantics — mirrors UiFeedback.test.tsx (@ggui-ai/mcp-apps-react)
// =============================================================================

describe('UiFeedbackCard — payload semantics', () => {
  it('emits a love verdict stamped with the supplied context', async () => {
    const emit = eventSink();
    await mount({ emit, sessionId: 'sess-1', toolName: 'ggui_render' });
    fireEvent.click(q('[data-ggui-ui-feedback-verdict="love"]'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toEqual({
      kind: 'ui-feedback',
      verdict: 'love',
      sessionId: 'sess-1',
      toolName: 'ggui_render',
    });
  });

  it('omits context fields the runtime did not supply', async () => {
    const emit = eventSink();
    await mount({ emit });
    fireEvent.click(q('[data-ggui-ui-feedback-verdict="dislike"]'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toEqual({
      kind: 'ui-feedback',
      verdict: 'dislike',
    });
  });

  it('opens the free-text flow on Other and sends the trimmed comment', async () => {
    const emit = eventSink();
    await mount({ emit, sessionId: 'sess-2' });
    fireEvent.click(q('[data-ggui-ui-feedback-verdict="other"]'));
    // Verdict buttons collapse into the comment form; nothing emitted yet.
    expect(emit).not.toHaveBeenCalled();
    fireEvent.change(q('[data-ggui-ui-feedback-comment]'), {
      target: { value: '  the chart ignored my data  ' },
    });
    fireEvent.submit(q('[data-ggui-ui-feedback-comment-form]'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toEqual({
      kind: 'ui-feedback',
      verdict: 'other',
      comment: 'the chart ignored my data',
      sessionId: 'sess-2',
    });
  });

  it('omits a whitespace-only comment from the event', async () => {
    const emit = eventSink();
    await mount({ emit });
    fireEvent.click(q('[data-ggui-ui-feedback-verdict="other"]'));
    fireEvent.change(q('[data-ggui-ui-feedback-comment]'), {
      target: { value: '   ' },
    });
    fireEvent.submit(q('[data-ggui-ui-feedback-comment-form]'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toEqual({
      kind: 'ui-feedback',
      verdict: 'other',
    });
  });

  it('collapses into an acknowledgement after a verdict', async () => {
    const emit = eventSink();
    await mount({ emit });
    fireEvent.click(q('[data-ggui-ui-feedback-verdict="dislike"]'));
    expect(
      document.querySelector('[data-ggui-ui-feedback-verdict="dislike"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-ggui-ui-feedback-thanks]'),
    ).not.toBeNull();
  });

  it('dismiss hides the affordance entirely without emitting', async () => {
    const emit = eventSink();
    await mount({ emit });
    fireEvent.click(q('[data-ggui-ui-feedback-dismiss]'));
    expect(document.querySelector('[data-ggui-ui-feedback]')).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});
