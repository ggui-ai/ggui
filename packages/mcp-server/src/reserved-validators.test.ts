/**
 * Unit tests for the reserved-channel validator composer (Item 4).
 *
 * Covers:
 *   - `composePreviewReservedValidator` returns a single-entry map
 *     keyed on PREVIEW_CHANNEL.
 *   - The bound validator accepts canonical A2UI messages, rejects
 *     malformed payloads, and tolerates the channel-close sentinel.
 *   - `mergeReservedValidators` layers two maps with caller-override
 *     semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_CHANNEL,
  validateStreamData,
  type ReservedChannelValidator,
} from '@ggui-ai/protocol';
import {
  composePreviewReservedValidator,
  mergeReservedValidators,
} from './reserved-validators.js';

const EMPTY_STREAM_SPEC = {};

describe('composePreviewReservedValidator', () => {
  it('returns a single-entry map keyed on PREVIEW_CHANNEL', () => {
    const map = composePreviewReservedValidator();
    expect(map.size).toBe(1);
    expect(map.has(PREVIEW_CHANNEL)).toBe(true);
  });

  it('accepts a canonical createSurface payload', () => {
    const map = composePreviewReservedValidator();
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      {
        version: 'v0.9',
        createSurface: { surfaceId: 's-1', catalogId: 'ggui.preview.v1' },
      },
      EMPTY_STREAM_SPEC,
      map,
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('accepts a canonical updateComponents payload', () => {
    const map = composePreviewReservedValidator();
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 's-1',
          components: [
            {
              id: 'root',
              component: 'Text',
              text: 'hi',
            },
          ],
        },
      },
      EMPTY_STREAM_SPEC,
      map,
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a canonical deleteSurface payload', () => {
    const map = composePreviewReservedValidator();
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      { version: 'v0.9', deleteSurface: { surfaceId: 's-1' } },
      EMPTY_STREAM_SPEC,
      map,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a malformed payload (missing version field)', () => {
    const map = composePreviewReservedValidator();
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      { deleteSurface: { surfaceId: 's-1' } },
      EMPTY_STREAM_SPEC,
      map,
    );
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].expected).toContain('A2UI ServerMessage');
  });

  it('rejects a malformed payload (wrong version literal)', () => {
    const map = composePreviewReservedValidator();
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      { version: 'v1.0', deleteSurface: { surfaceId: 's-1' } },
      EMPTY_STREAM_SPEC,
      map,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a payload that is not one of the V1 write-path messages', () => {
    const map = composePreviewReservedValidator();
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      { version: 'v0.9', updateDataModel: { model: {} } },
      EMPTY_STREAM_SPEC,
      map,
    );
    expect(result.valid).toBe(false);
  });

  it('accepts the channel-close sentinel (null payload)', () => {
    // The preview runner's `finalizePreviewChannel` emits
    // `{payload: null, complete: true}` on every exit path. This is
    // a live-channel transport marker, not an A2UI message — the
    // adapter MUST accept it so teardown frames fan out cleanly.
    const map = composePreviewReservedValidator();
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      null,
      EMPTY_STREAM_SPEC,
      map,
    );
    expect(result.valid).toBe(true);
  });

  it('accepts undefined payload as channel-close sentinel', () => {
    const map = composePreviewReservedValidator();
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      undefined,
      EMPTY_STREAM_SPEC,
      map,
    );
    expect(result.valid).toBe(true);
  });
});

describe('mergeReservedValidators', () => {
  const rejectAll: ReservedChannelValidator = () => ({
    valid: false,
    violations: [
      { field: 'x', message: 'override fired', expected: 'x', received: 'x' },
    ],
  });

  it('returns undefined when both inputs are undefined', () => {
    expect(mergeReservedValidators(undefined, undefined)).toBeUndefined();
  });

  it('returns the non-empty input when one side is undefined', () => {
    const base = new Map([[PREVIEW_CHANNEL, rejectAll]]);
    expect(mergeReservedValidators(base, undefined)).toBe(base);
    expect(mergeReservedValidators(undefined, base)).toBe(base);
  });

  it('merges two maps with override winning on key conflict', () => {
    const base = composePreviewReservedValidator();
    const override = new Map([[PREVIEW_CHANNEL, rejectAll]]);
    const merged = mergeReservedValidators(base, override);
    expect(merged).toBeDefined();
    // Override wins — A2UI default is replaced by the rejection stub.
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      { version: 'v0.9', deleteSurface: { surfaceId: 's-1' } },
      EMPTY_STREAM_SPEC,
      merged,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].message).toBe('override fired');
  });

  it('preserves non-overlapping keys from both inputs', () => {
    const base = composePreviewReservedValidator();
    // Keying on a hypothetical future reserved channel (not actually
    // recognized, but the merge still threads it through — the
    // validator would only run if KNOWN_RESERVED_CHANNELS contained
    // the name).
    const override = new Map<string, ReservedChannelValidator>([
      ['_ggui:hypothetical', rejectAll],
    ]);
    const merged = mergeReservedValidators(base, override);
    expect(merged?.size).toBe(2);
    expect(merged?.has(PREVIEW_CHANNEL)).toBe(true);
    expect(merged?.has('_ggui:hypothetical')).toBe(true);
  });

  it('returns a map that does not share mutation identity with inputs', () => {
    const base = composePreviewReservedValidator();
    const override = new Map([['_ggui:hypothetical', rejectAll]]);
    const merged = mergeReservedValidators(base, override);
    // Merging two non-empty inputs yields a NEW map.
    expect(merged).not.toBe(base);
    expect(merged).not.toBe(override);
  });
});
