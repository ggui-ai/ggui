import { describe, it, expect } from 'vitest';

import {
  THREAD_STATE_ACTIONS,
  isThreadStateAction,
  isThreadStreamEvent,
  type Thread,
  type ThreadMessage,
} from '../thread';

describe('ThreadStateAction', () => {
  it('enumerates the 9 actions the cloud adapter already supports', () => {
    expect(THREAD_STATE_ACTIONS).toEqual([
      'pin',
      'unpin',
      'mute',
      'unmute',
      'archive',
      'unarchive',
      'mark_read',
      'request_delete',
      'restore',
    ]);
  });

  it('guards by string membership', () => {
    expect(isThreadStateAction('pin')).toBe(true);
    expect(isThreadStateAction('mark_read')).toBe(true);
    expect(isThreadStateAction('restore')).toBe(true);
    // Not-yet-defined actions must not pass — keeps future additions
    // honest (they have to update the const list, not just the guard).
    expect(isThreadStateAction('snooze')).toBe(false);
    expect(isThreadStateAction('')).toBe(false);
    expect(isThreadStateAction(42)).toBe(false);
    expect(isThreadStateAction(null)).toBe(false);
    expect(isThreadStateAction(undefined)).toBe(false);
  });
});

describe('isThreadStreamEvent', () => {
  it('accepts well-formed thread-message events', () => {
    const event = {
      type: 'thread-message',
      message: {
        threadId: 't1',
        key: 'k1',
        seq: 1,
        at: '2026-04-20T00:00:00.000Z',
        authorRole: 'user',
        kind: 'text',
        blocks: [],
        textPreview: 'hi',
      },
    };
    expect(isThreadStreamEvent(event)).toBe(true);
  });

  it('rejects malformed events', () => {
    // Wrong discriminator — forward-compatibility means clients MUST
    // reject unknown types rather than mis-parse them.
    expect(isThreadStreamEvent({ type: 'session-event', message: {} })).toBe(false);
    expect(isThreadStreamEvent({ type: 'thread-message' })).toBe(false);
    expect(isThreadStreamEvent({ message: {} })).toBe(false);
    expect(isThreadStreamEvent(null)).toBe(false);
    expect(isThreadStreamEvent(42)).toBe(false);
    expect(isThreadStreamEvent('thread-message')).toBe(false);
  });
});

describe('Thread / ThreadMessage shape assertions', () => {
  // These are type-only assertions — they fail at typecheck time, not
  // at runtime, if the shape drifts. Keeps future refactors from
  // silently dropping required fields.

  it('Thread carries the required state + sequencing fields', () => {
    const t: Thread = {
      id: 'thr_1',
      appId: 'app_1',
      ownerId: 'cognito_abc',
      lastSeq: 0,
      unreadCount: 0,
      pinned: false,
      muted: false,
      status: 'active',
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    };
    expect(t.status).toBe('active');
  });

  it('ThreadMessage requires key + seq + author + kind + blocks + textPreview', () => {
    const m: ThreadMessage = {
      threadId: 'thr_1',
      key: 'client-key-1',
      seq: 1,
      at: '2026-04-20T00:00:00.000Z',
      authorRole: 'user',
      kind: 'text',
      blocks: [{ type: 'text', text: 'hi' }],
      textPreview: 'hi',
    };
    expect(m.seq).toBe(1);
    expect(m.textPreview).toBe('hi');
  });
});
