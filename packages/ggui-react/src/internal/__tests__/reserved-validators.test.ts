/**
 * Unit tests for the client-side A2UI preview-channel validator
 * composer (Item 4).
 *
 * Mirror of the server-side composer tests in
 * `@ggui-ai/mcp-server::reserved-validators.test.ts`. Ensures the
 * client wires the same adapter behavior (channel-close sentinel
 * tolerance + A2UI ServerMessage rejection on malformed payloads).
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
} from '../reserved-validators';

const EMPTY_SPEC = {};

describe('composePreviewReservedValidator (client)', () => {
  it('returns a single-entry map keyed on PREVIEW_CHANNEL', () => {
    const map = composePreviewReservedValidator();
    expect(map.size).toBe(1);
    expect(map.has(PREVIEW_CHANNEL)).toBe(true);
  });

  it('accepts a canonical createSurface payload', () => {
    const map = composePreviewReservedValidator();
    const r = validateStreamData(
      PREVIEW_CHANNEL,
      {
        version: 'v0.9',
        createSurface: { surfaceId: 's', catalogId: 'ggui.preview.v1' },
      },
      EMPTY_SPEC,
      map,
    );
    expect(r.valid).toBe(true);
  });

  it('rejects a malformed payload missing version', () => {
    const map = composePreviewReservedValidator();
    const r = validateStreamData(
      PREVIEW_CHANNEL,
      { deleteSurface: { surfaceId: 's' } },
      EMPTY_SPEC,
      map,
    );
    expect(r.valid).toBe(false);
  });

  it('accepts null as channel-close sentinel', () => {
    const map = composePreviewReservedValidator();
    const r = validateStreamData(PREVIEW_CHANNEL, null, EMPTY_SPEC, map);
    expect(r.valid).toBe(true);
  });

  it('accepts undefined as channel-close sentinel', () => {
    const map = composePreviewReservedValidator();
    const r = validateStreamData(PREVIEW_CHANNEL, undefined, EMPTY_SPEC, map);
    expect(r.valid).toBe(true);
  });
});

describe('mergeReservedValidators (client)', () => {
  const rejectAll: ReservedChannelValidator = () => ({
    valid: false,
    violations: [{ field: 'x', message: 'override', expected: 'x', received: 'x' }],
  });

  it('returns undefined when both inputs are undefined', () => {
    expect(mergeReservedValidators(undefined, undefined)).toBeUndefined();
  });

  it('override WINS on key conflict', () => {
    const base = composePreviewReservedValidator();
    const override = new Map([[PREVIEW_CHANNEL, rejectAll]]);
    const merged = mergeReservedValidators(base, override);
    const r = validateStreamData(
      PREVIEW_CHANNEL,
      { version: 'v0.9', deleteSurface: { surfaceId: 's' } },
      EMPTY_SPEC,
      merged,
    );
    expect(r.valid).toBe(false);
    expect(r.violations[0].message).toBe('override');
  });

  it('preserves non-overlapping keys from both maps', () => {
    const base = composePreviewReservedValidator();
    const override = new Map<string, ReservedChannelValidator>([
      ['_ggui:hypothetical', rejectAll],
    ]);
    const merged = mergeReservedValidators(base, override);
    expect(merged?.size).toBe(2);
  });
});
