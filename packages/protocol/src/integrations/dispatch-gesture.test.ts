import { describe, expect, it } from 'vitest';
import { DISPATCH_GESTURE_LABEL_V1, dispatchGestureBytes } from './dispatch-gesture.js';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('dispatchGestureBytes (ggui#1519) — the canonical bytes of what a dispatch means', () => {
  it('is the label, a line feed, then the JCS form of {intent, actionData}', () => {
    expect(text(dispatchGestureBytes('submit', { b: 2, a: 1 }))).toBe(
      `${DISPATCH_GESTURE_LABEL_V1}\n{"actionData":{"a":1,"b":2},"intent":"submit"}`,
    );
  });

  it('does not depend on key order, and does on every value', () => {
    expect(dispatchGestureBytes('go', { x: [1, { q: 'r', p: true }], y: null })).toEqual(
      dispatchGestureBytes('go', { y: null, x: [1, { p: true, q: 'r' }] }),
    );
    expect(dispatchGestureBytes('go', { x: 1 })).not.toEqual(dispatchGestureBytes('go', { x: 2 }));
    expect(dispatchGestureBytes('go', { x: 1 })).not.toEqual(dispatchGestureBytes('stop', { x: 1 }));
  });

  it('reads an absent actionData as null, the envelope\'s own default', () => {
    expect(dispatchGestureBytes('go', undefined)).toEqual(dispatchGestureBytes('go', null));
  });

  it('formats numbers as JCS does, so 1 and 1.0 are one gesture', () => {
    expect(dispatchGestureBytes('go', { n: 1.0 })).toEqual(dispatchGestureBytes('go', { n: 1 }));
    expect(text(dispatchGestureBytes('go', { n: 1e21 }))).toContain('"n":1e+21');
  });
});
