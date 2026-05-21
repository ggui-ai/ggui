/**
 * Tests for the display-mode escalation policy (Slice G, 2026-05-17).
 *
 * Pure functions, value-in / value-out. The matrix is small enough to
 * cover exhaustively; we do.
 */
import { describe, expect, it } from 'vitest';
import {
  pickContentStateMode,
  pickEmptyStateMode,
  reconcileDisplayMode,
} from '../display-mode-policy.js';

describe('pickEmptyStateMode', () => {
  it('returns inline when available is undefined', () => {
    expect(pickEmptyStateMode(undefined)).toBe('inline');
  });

  it('returns inline when available is empty', () => {
    expect(pickEmptyStateMode([])).toBe('inline');
  });

  it('returns inline when only inline is available', () => {
    expect(pickEmptyStateMode(['inline'])).toBe('inline');
  });

  it('returns pip when pip is available', () => {
    expect(pickEmptyStateMode(['inline', 'pip'])).toBe('pip');
    expect(pickEmptyStateMode(['pip'])).toBe('pip');
  });

  it('NEVER returns fullscreen — empty canvas + fullscreen is hostile UX', () => {
    expect(pickEmptyStateMode(['inline', 'fullscreen'])).toBe('inline');
    expect(pickEmptyStateMode(['fullscreen'])).toBe('inline');
    expect(pickEmptyStateMode(['inline', 'fullscreen', 'pip'])).toBe('pip');
  });
});

describe('pickContentStateMode', () => {
  it('returns inline when available is undefined', () => {
    expect(pickContentStateMode(undefined)).toBe('inline');
  });

  it('returns inline when available is empty', () => {
    expect(pickContentStateMode([])).toBe('inline');
  });

  it('returns inline when only inline is available', () => {
    expect(pickContentStateMode(['inline'])).toBe('inline');
  });

  it('returns fullscreen when fullscreen is available (preferred)', () => {
    expect(pickContentStateMode(['inline', 'fullscreen'])).toBe('fullscreen');
    expect(pickContentStateMode(['fullscreen'])).toBe('fullscreen');
    expect(pickContentStateMode(['inline', 'fullscreen', 'pip'])).toBe(
      'fullscreen',
    );
  });

  it('falls back to pip when fullscreen is unavailable but pip is', () => {
    expect(pickContentStateMode(['inline', 'pip'])).toBe('pip');
    expect(pickContentStateMode(['pip'])).toBe('pip');
  });
});

describe('reconcileDisplayMode', () => {
  describe('noop branch (current already matches target)', () => {
    it('empty + already inline + inline-only host → noop', () => {
      expect(
        reconcileDisplayMode({
          available: ['inline'],
          current: 'inline',
          contentState: 'empty',
        }),
      ).toEqual({ kind: 'noop' });
    });

    it('content + already fullscreen → noop', () => {
      expect(
        reconcileDisplayMode({
          available: ['inline', 'fullscreen'],
          current: 'fullscreen',
          contentState: 'has-content',
        }),
      ).toEqual({ kind: 'noop' });
    });

    it('empty + already pip + pip-supporting host → noop', () => {
      expect(
        reconcileDisplayMode({
          available: ['inline', 'pip'],
          current: 'pip',
          contentState: 'empty',
        }),
      ).toEqual({ kind: 'noop' });
    });
  });

  describe('request branch (current diverges from target)', () => {
    it('empty + current inline + pip available → request pip', () => {
      expect(
        reconcileDisplayMode({
          available: ['inline', 'pip', 'fullscreen'],
          current: 'inline',
          contentState: 'empty',
        }),
      ).toEqual({ kind: 'request', mode: 'pip' });
    });

    it('content + current inline + fullscreen available → request fullscreen', () => {
      expect(
        reconcileDisplayMode({
          available: ['inline', 'fullscreen'],
          current: 'inline',
          contentState: 'has-content',
        }),
      ).toEqual({ kind: 'request', mode: 'fullscreen' });
    });

    it('content + current pip + fullscreen available → request fullscreen', () => {
      // Escalation: user has content; we want the most prominent
      // presentation the host supports.
      expect(
        reconcileDisplayMode({
          available: ['inline', 'pip', 'fullscreen'],
          current: 'pip',
          contentState: 'has-content',
        }),
      ).toEqual({ kind: 'request', mode: 'fullscreen' });
    });

    it('empty + current fullscreen + pip available → request pip', () => {
      // De-escalation: user popped everything; pip is the right
      // resting state.
      expect(
        reconcileDisplayMode({
          available: ['inline', 'pip', 'fullscreen'],
          current: 'fullscreen',
          contentState: 'empty',
        }),
      ).toEqual({ kind: 'request', mode: 'pip' });
    });

    it('empty + current fullscreen + no pip → request inline', () => {
      // De-escalation without pip: drop to inline.
      expect(
        reconcileDisplayMode({
          available: ['inline', 'fullscreen'],
          current: 'fullscreen',
          contentState: 'empty',
        }),
      ).toEqual({ kind: 'request', mode: 'inline' });
    });
  });

  describe('current undefined (host did not report)', () => {
    it('treats undefined as inline (worst-case)', () => {
      // empty + pip-supporting host + no current → request pip
      expect(
        reconcileDisplayMode({
          available: ['inline', 'pip'],
          current: undefined,
          contentState: 'empty',
        }),
      ).toEqual({ kind: 'request', mode: 'pip' });

      // If the target IS inline, the assumed-inline current matches → noop
      expect(
        reconcileDisplayMode({
          available: ['inline'],
          current: undefined,
          contentState: 'empty',
        }),
      ).toEqual({ kind: 'noop' });
    });
  });

  describe('available undefined (non-spec host)', () => {
    it('always returns inline target; noop when current is undefined', () => {
      // Non-spec host. Treat as inline-only. Empty + content both
      // collapse to inline targets — never escalate.
      expect(
        reconcileDisplayMode({
          available: undefined,
          current: undefined,
          contentState: 'empty',
        }),
      ).toEqual({ kind: 'noop' });
      expect(
        reconcileDisplayMode({
          available: undefined,
          current: undefined,
          contentState: 'has-content',
        }),
      ).toEqual({ kind: 'noop' });
    });
  });
});
