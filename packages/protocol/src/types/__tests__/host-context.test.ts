/**
 * Tests for HostContextProjection projector + equality helper. The
 * projector is defensive against malformed inputs (host emits weird
 * shapes during fuzz testing, future spec extensions, hosts under
 * load) — this suite pins exact behavior for every drop / accept
 * decision.
 */
import { describe, expect, it } from 'vitest';
import {
  hostContextProjectionsEqual,
  projectHostContext,
} from '../host-context';

describe('projectHostContext', () => {
  it('returns undefined for non-object input', () => {
    expect(projectHostContext(null)).toBeUndefined();
    expect(projectHostContext(undefined)).toBeUndefined();
    expect(projectHostContext(42)).toBeUndefined();
    expect(projectHostContext('inline')).toBeUndefined();
    expect(projectHostContext(true)).toBeUndefined();
    expect(projectHostContext([])).toBeUndefined();
    expect(projectHostContext(['fullscreen'])).toBeUndefined();
  });

  it('returns empty object for object-with-no-recognized-fields', () => {
    expect(projectHostContext({})).toEqual({});
    // Unknown fields are silently dropped (forward-compat for future
    // spec additions ggui hasn't projected yet).
    expect(projectHostContext({ futureUnknown: 'foo', weirdShape: 42 })).toEqual({});
  });

  it('projects valid currentDisplayMode', () => {
    expect(projectHostContext({ displayMode: 'fullscreen' })).toEqual({
      currentDisplayMode: 'fullscreen',
    });
    expect(projectHostContext({ displayMode: 'pip' })).toEqual({
      currentDisplayMode: 'pip',
    });
    expect(projectHostContext({ displayMode: 'inline' })).toEqual({
      currentDisplayMode: 'inline',
    });
  });

  it('drops invalid displayMode silently', () => {
    expect(projectHostContext({ displayMode: 'sidebar' })).toEqual({});
    expect(projectHostContext({ displayMode: 42 })).toEqual({});
    expect(projectHostContext({ displayMode: null })).toEqual({});
    expect(projectHostContext({ displayMode: '' })).toEqual({});
  });

  it('projects availableDisplayModes and filters invalid entries', () => {
    expect(
      projectHostContext({
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      }),
    ).toEqual({ availableDisplayModes: ['inline', 'fullscreen', 'pip'] });

    // Filters out unrecognized values, keeps the valid ones.
    expect(
      projectHostContext({
        availableDisplayModes: ['inline', 'sidebar', 'fullscreen', 42, null],
      }),
    ).toEqual({ availableDisplayModes: ['inline', 'fullscreen'] });

    // Empty after filtering ⇒ field omitted entirely.
    expect(
      projectHostContext({
        availableDisplayModes: ['sidebar', 'modal'],
      }),
    ).toEqual({});

    // Non-array drops the whole field.
    expect(projectHostContext({ availableDisplayModes: 'inline' })).toEqual({});
  });

  it('projects containerDimensions (any subset of fields)', () => {
    expect(
      projectHostContext({
        containerDimensions: { width: 400, height: 800 },
      }),
    ).toEqual({ containerDimensions: { width: 400, height: 800 } });

    expect(
      projectHostContext({
        containerDimensions: { maxWidth: 1200 },
      }),
    ).toEqual({ containerDimensions: { maxWidth: 1200 } });

    expect(
      projectHostContext({
        containerDimensions: { width: 400, maxHeight: 800 },
      }),
    ).toEqual({ containerDimensions: { width: 400, maxHeight: 800 } });
  });

  it('drops malformed containerDimensions (non-numeric values)', () => {
    expect(
      projectHostContext({
        containerDimensions: { width: 'wide', height: null },
      }),
    ).toEqual({});

    // Mixed valid + invalid: valid fields kept, invalid dropped.
    expect(
      projectHostContext({
        containerDimensions: { width: 400, maxHeight: 'tall' },
      }),
    ).toEqual({ containerDimensions: { width: 400 } });

    expect(projectHostContext({ containerDimensions: 'large' })).toEqual({});
    expect(projectHostContext({ containerDimensions: null })).toEqual({});
  });

  it('projects platform literal', () => {
    expect(projectHostContext({ platform: 'desktop' })).toEqual({
      platform: 'desktop',
    });
    expect(projectHostContext({ platform: 'mobile' })).toEqual({
      platform: 'mobile',
    });
    expect(projectHostContext({ platform: 'web' })).toEqual({
      platform: 'web',
    });
    // Unknown platform → dropped silently.
    expect(projectHostContext({ platform: 'tv' })).toEqual({});
    expect(projectHostContext({ platform: 42 })).toEqual({});
  });

  it('projects deviceCapabilities (touch / hover)', () => {
    expect(
      projectHostContext({ deviceCapabilities: { touch: true } }),
    ).toEqual({ deviceCapabilities: { touch: true } });
    expect(
      projectHostContext({ deviceCapabilities: { hover: false } }),
    ).toEqual({ deviceCapabilities: { hover: false } });
    expect(
      projectHostContext({
        deviceCapabilities: { touch: true, hover: true },
      }),
    ).toEqual({ deviceCapabilities: { touch: true, hover: true } });

    // Non-boolean dropped per field.
    expect(
      projectHostContext({
        deviceCapabilities: { touch: 1, hover: 'maybe' },
      }),
    ).toEqual({});
    // All invalid ⇒ field omitted.
    expect(
      projectHostContext({ deviceCapabilities: { other: true } }),
    ).toEqual({});
  });

  it('projects non-empty locale and timeZone strings', () => {
    expect(projectHostContext({ locale: 'en-US' })).toEqual({ locale: 'en-US' });
    expect(projectHostContext({ timeZone: 'America/Los_Angeles' })).toEqual({
      timeZone: 'America/Los_Angeles',
    });

    // Empty strings dropped (treated as "field absent").
    expect(projectHostContext({ locale: '' })).toEqual({});
    expect(projectHostContext({ timeZone: '' })).toEqual({});
    expect(projectHostContext({ locale: 42 })).toEqual({});
  });

  it('projects a fully-populated McpUiHostContext correctly', () => {
    const result = projectHostContext({
      displayMode: 'fullscreen',
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      containerDimensions: { width: 1280, height: 800 },
      platform: 'desktop',
      deviceCapabilities: { touch: false, hover: true },
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
      // Fields excluded from the projection — must not appear in output.
      theme: 'light',
      styles: { variables: {} },
      userAgent: 'Claude Desktop/1.2.3',
      toolInfo: { id: 'req-1', tool: { name: 'ggui_push' } },
    });
    expect(result).toEqual({
      currentDisplayMode: 'fullscreen',
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      containerDimensions: { width: 1280, height: 800 },
      platform: 'desktop',
      deviceCapabilities: { touch: false, hover: true },
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
    });
  });
});

describe('hostContextProjectionsEqual', () => {
  it('returns true for identical references', () => {
    const p = { currentDisplayMode: 'fullscreen' as const };
    expect(hostContextProjectionsEqual(p, p)).toBe(true);
  });

  it('returns true for both undefined', () => {
    expect(hostContextProjectionsEqual(undefined, undefined)).toBe(true);
  });

  it('returns false when one side is undefined', () => {
    expect(hostContextProjectionsEqual({}, undefined)).toBe(false);
    expect(hostContextProjectionsEqual(undefined, {})).toBe(false);
  });

  it('returns true for structurally equal projections', () => {
    expect(
      hostContextProjectionsEqual(
        {
          availableDisplayModes: ['inline', 'fullscreen'],
          containerDimensions: { width: 400 },
        },
        {
          availableDisplayModes: ['inline', 'fullscreen'],
          containerDimensions: { width: 400 },
        },
      ),
    ).toBe(true);
  });

  it('returns false when array order differs', () => {
    // JSON.stringify-based equality is order-sensitive on arrays.
    // Matches the spec — availableDisplayModes is ordered by host
    // preference, so order changes are meaningful.
    expect(
      hostContextProjectionsEqual(
        { availableDisplayModes: ['inline', 'fullscreen'] },
        { availableDisplayModes: ['fullscreen', 'inline'] },
      ),
    ).toBe(false);
  });

  it('returns false on field value mismatch', () => {
    expect(
      hostContextProjectionsEqual(
        { currentDisplayMode: 'inline' },
        { currentDisplayMode: 'fullscreen' },
      ),
    ).toBe(false);
  });

  it('treats {} and undefined as different', () => {
    // Distinct: "host emitted context with no recognized fields" vs
    // "host didn't emit context at all".
    expect(hostContextProjectionsEqual({}, undefined)).toBe(false);
  });
});
