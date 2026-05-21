/**
 * Conformance gate tests. Mirrors the cloud handler's coverage for the
 * pure `checkConformance` function so the lift to registry-core is
 * verifiable.
 */
import { describe, expect, it } from 'vitest';
import { checkConformance, MAX_BLUEPRINT_SOURCE_BYTES } from './conformance.js';

const VALID_GADGET_MANIFEST = {
  kind: 'gadget' as const,
  scope: '@my-org',
  name: 'weather-card',
  version: '1.0.0',
  bundle: 'src/index.ts',
  visibility: 'public' as const,
  description: 'Weather card gadget for testing',
  exports: [
    {
      hook: 'useWeatherCard',
      description: 'Weather card gadget for testing',
      usage: 'Renders current weather conditions for a city',
      example: { city: 'San Francisco' },
    },
  ],
};

const VALID_BUNDLE = `
import { useState } from 'react';
import { jsx } from 'react/jsx-runtime';
import { getPublicEnv } from '@ggui-ai/gadgets';

export function useWeatherCard() {
  const [city, setCity] = useState('');
  return { city, setCity, key: getPublicEnv('GGUI_PUBLIC_APP_WEATHER_KEY') };
}
`;

const VALID_BLUEPRINT_MANIFEST = {
  kind: 'blueprint' as const,
  scope: '@my-org',
  name: 'login-form',
  version: '1.0.0',
  visibility: 'public' as const,
  source: 'export default function Login(){ return <div>Login</div>; }',
  variance: {
    persona: 'casual-shopper',
    seedPrompt: 'A friendly login form',
  },
};

describe('checkConformance', () => {
  it('accepts a valid gadget manifest + bundle with only allowlisted imports', () => {
    expect(checkConformance({ manifest: VALID_GADGET_MANIFEST, bundle: VALID_BUNDLE })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('accepts a valid blueprint manifest with a TSX source that compiles cleanly', () => {
    expect(checkConformance({ manifest: VALID_BLUEPRINT_MANIFEST })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('rejects a manifest missing a required field with code=manifest_invalid', () => {
    const result = checkConformance({
      manifest: { ...VALID_GADGET_MANIFEST, name: undefined },
      bundle: VALID_BUNDLE,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('manifest_invalid');
  });

  it('rejects a gadget submission missing the bundle field', () => {
    const result = checkConformance({ manifest: VALID_GADGET_MANIFEST });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('bundle_parse_error');
  });

  it('rejects a bundle with a disallowed import', () => {
    const result = checkConformance({
      manifest: VALID_GADGET_MANIFEST,
      bundle: `import { wow } from 'evil-pkg'; export function useWeatherCard(){ return wow; }`,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('disallowed_import');
  });

  it('rejects a bundle that lacks the manifest-declared hook + default export', () => {
    const result = checkConformance({
      manifest: VALID_GADGET_MANIFEST,
      bundle: `export function useDifferentName(){ return null; }`,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('missing_default_export');
  });

  it('allows peerDeps imports', () => {
    const result = checkConformance({
      manifest: { ...VALID_GADGET_MANIFEST, peerDeps: { 'mapbox-gl': '^3.0.0' } },
      bundle: `import mapboxgl from 'mapbox-gl'; export function useWeatherCard(){ return mapboxgl; }`,
    });
    expect(result.ok).toBe(true);
  });

  // ── Bucket B' (2026-05-18): blueprint gates ─────────────────────────

  describe('blueprint gates', () => {
    it('rejects a blueprint whose source exceeds MAX_BLUEPRINT_SOURCE_BYTES', () => {
      // Build a string just over the cap. Use a repeating ASCII payload so
      // UTF-8 byte length matches the JS-string length.
      const padding = 'a'.repeat(MAX_BLUEPRINT_SOURCE_BYTES + 1);
      const result = checkConformance({
        manifest: { ...VALID_BLUEPRINT_MANIFEST, source: padding },
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe('blueprint_source_too_large');
      expect(result.errors[0]?.detail).toMatchObject({
        maxBytes: MAX_BLUEPRINT_SOURCE_BYTES,
      });
    });

    it('rejects TSX source with a syntax error via esbuild', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: 'export default function Broken() { return <div', // unterminated JSX
        },
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe('blueprint_compile_error');
    });

    it('rejects a blueprint that imports a package outside the always-allowlist', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: `import evil from 'evil-pkg'; export default function X(){ return null; }`,
        },
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'blueprint_disallowed_import')).toBe(true);
    });

    // ── B'-NewGap-2 (2026-05-18): dynamic-import allow-list coverage ─
    //
    // The allow-list gate walks BOTH static and dynamic imports — a
    // blueprint can't bypass via `await import('...')`. Non-literal
    // import expressions are rejected outright because the gate
    // cannot statically resolve the target.

    it('rejects a blueprint that dynamic-imports a disallowed package', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: `
            export default async function X() {
              const evil = await import('evil-pkg');
              return null;
            }
          `,
        },
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'blueprint_disallowed_import')).toBe(true);
    });

    it('accepts a blueprint that dynamic-imports an allow-listed package', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: `
            export default async function X() {
              const r = await import('react');
              return null;
            }
          `,
        },
      });
      expect(result.ok).toBe(true);
    });

    it('rejects a blueprint with a non-literal dynamic-import expression', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: `
            const pkg = 'react';
            export default async function X() {
              const r = await import(pkg);
              return null;
            }
          `,
        },
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'blueprint_disallowed_import')).toBe(true);
    });

    it('accepts a blueprint that imports from each always-allowlisted source', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: `
            import { useState } from 'react';
            import { jsx } from 'react/jsx-runtime';
            import { useTodos } from '@ggui-ai/gadgets';
            export default function X(){ const [s] = useState(0); useTodos(); return null; }
          `,
        },
      });
      expect(result.ok).toBe(true);
    });

    it('rejects a blueprint that has no default export', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: `export function NamedOnly(){ return null; }`,
        },
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'blueprint_missing_default_export')).toBe(true);
    });

    it('passes fixture-shape gate when only fixtureProps is set (no propsSpec)', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          fixtureProps: { anything: 'goes', no: 'spec' },
        },
      });
      expect(result.ok).toBe(true);
    });

    it('passes fixture-shape gate when only propsSpec is set (no fixtureProps)', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          contract: {
            propsSpec: {
              properties: {
                city: { schema: { type: 'string' }, required: true },
              },
            },
          },
        },
      });
      expect(result.ok).toBe(true);
    });

    it('rejects fixtureProps missing a required propsSpec key', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          fixtureProps: { unrelated: true },
          contract: {
            propsSpec: {
              properties: {
                city: { schema: { type: 'string' }, required: true },
                tempF: { schema: { type: 'number' }, required: true },
              },
            },
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe('fixture_props_shape_mismatch');
      expect(result.errors[0]?.detail).toMatchObject({
        missingKeys: ['city', 'tempF'],
      });
    });

    it('accepts fixtureProps that satisfies every required propsSpec key', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          fixtureProps: { city: 'Tokyo', tempF: 68 },
          contract: {
            propsSpec: {
              properties: {
                city: { schema: { type: 'string' }, required: true },
                tempF: { schema: { type: 'number' }, required: true },
              },
            },
          },
        },
      });
      expect(result.ok).toBe(true);
    });

    it('rejects fixtureProps that is not a JSON object', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          fixtureProps: ['not', 'an', 'object'],
          contract: {
            propsSpec: { properties: {} },
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe('fixture_props_shape_mismatch');
      expect(result.errors[0]?.detail).toMatchObject({ received: 'array' });
    });

    // ── B'-A13: source-size boundary ─────────────────────────────────
    //
    // The size cap is measured in UTF-8 bytes via `TextEncoder.encode`,
    // not JS-string `.length`. Pin both edges of the boundary
    // (`=== MAX` passes, `=== MAX + 1` already covered above) and the
    // multi-byte case where `.length` materially diverges from byte
    // length.

    it('accepts a blueprint whose source is EXACTLY MAX_BLUEPRINT_SOURCE_BYTES bytes', () => {
      // Boilerplate that compiles + has a default export. Padding goes
      // inside a /* … */ block so esbuild + oxc-parser still accept the
      // source; the block is also pure ASCII so JS-string length and
      // UTF-8 byte length match exactly.
      const head = `/*`;
      const tail = `*/export default function X(){return null;}`;
      const headBytes = new TextEncoder().encode(head).byteLength;
      const tailBytes = new TextEncoder().encode(tail).byteLength;
      const padBytes = MAX_BLUEPRINT_SOURCE_BYTES - headBytes - tailBytes;
      const source = head + ' '.repeat(padBytes) + tail;
      const encodedBytes = new TextEncoder().encode(source).byteLength;
      // Pin the construction so a future refactor of head/tail can't
      // silently slip the byte count off the boundary.
      expect(encodedBytes).toBe(MAX_BLUEPRINT_SOURCE_BYTES);

      const result = checkConformance({
        manifest: { ...VALID_BLUEPRINT_MANIFEST, source },
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('uses UTF-8 bytes not JS-string `.length` for the size gate (under-cap with multi-byte chars)', () => {
      // Build a source whose JS-string `.length` is well under the cap
      // but whose UTF-8 byte length is still under the cap. Each `😀`
      // is 4 UTF-8 bytes vs 2 JS-string chars — so a string of N copies
      // has byte length 4N + boilerplate.
      const head = `/*`;
      const tail = `*/export default function X(){return null;}`;
      const headBytes = new TextEncoder().encode(head).byteLength;
      const tailBytes = new TextEncoder().encode(tail).byteLength;
      // Pad to MAX - 4 bytes (one emoji short of the cap) using emoji.
      const emojiCount = Math.floor(
        (MAX_BLUEPRINT_SOURCE_BYTES - headBytes - tailBytes - 4) / 4,
      );
      const source = head + '😀'.repeat(emojiCount) + tail;
      const encodedBytes = new TextEncoder().encode(source).byteLength;
      // JS-string `.length` should be materially smaller than byte
      // length — pin the divergence so a regression that swaps the
      // metric is visible here.
      expect(source.length).toBeLessThan(encodedBytes);
      expect(encodedBytes).toBeLessThanOrEqual(MAX_BLUEPRINT_SOURCE_BYTES);

      const result = checkConformance({
        manifest: { ...VALID_BLUEPRINT_MANIFEST, source },
      });
      expect(result.ok).toBe(true);
    });

    it('uses UTF-8 bytes not JS-string `.length` for the size gate (over-cap with multi-byte chars)', () => {
      // JS-string `.length` stays comfortably under the cap, but the
      // UTF-8 byte length spills over because each emoji counts for 4
      // bytes. Confirms the gate computes on bytes.
      const head = `/*`;
      const tail = `*/export default function X(){return null;}`;
      // (MAX / 4) + 1 emojis is just over the cap in bytes but only
      // half the cap in JS-string `.length`.
      const emojiCount = Math.floor(MAX_BLUEPRINT_SOURCE_BYTES / 4) + 1;
      const source = head + '😀'.repeat(emojiCount) + tail;
      const encodedBytes = new TextEncoder().encode(source).byteLength;
      expect(source.length).toBeLessThan(MAX_BLUEPRINT_SOURCE_BYTES);
      expect(encodedBytes).toBeGreaterThan(MAX_BLUEPRINT_SOURCE_BYTES);

      const result = checkConformance({
        manifest: { ...VALID_BLUEPRINT_MANIFEST, source },
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe('blueprint_source_too_large');
    });

    // ── B'-A14: `export { X as default }` alias-form default exports ──
    //
    // oxc-parser reports the alias form as `kind: 'Name'` with
    // `name: 'default'` (not `kind: 'Default'`). `hasDefaultExport`
    // now handles both shapes (B'-A14 closeout, 2026-05-18).

    it('accepts the `export { X as default }` alias-form as a valid default export', () => {
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: `
            function Aliased() { return null; }
            export { Aliased as default };
          `,
        },
      });
      expect(result.ok).toBe(true);
      expect(
        result.errors.some((e) => e.code === 'blueprint_missing_default_export'),
      ).toBe(false);
    });

    it('rejects a named-only re-export (`export { X }`) as missing default', () => {
      // Negative control for the alias-form test above — a re-export
      // without `as default` must still trip the gate.
      const result = checkConformance({
        manifest: {
          ...VALID_BLUEPRINT_MANIFEST,
          source: `
            function Aliased() { return null; }
            export { Aliased };
          `,
        },
      });
      expect(result.ok).toBe(false);
      expect(
        result.errors.some((e) => e.code === 'blueprint_missing_default_export'),
      ).toBe(true);
    });
  });
});
