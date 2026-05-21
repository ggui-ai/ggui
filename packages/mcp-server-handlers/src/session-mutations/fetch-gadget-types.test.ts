// Slice GG.7.C — unit tests for `fetchGadgetTypes`. The handler
// parallel-fetches every non-stdlib gadget's `.d.ts`, SRI-verifies
// it, and returns a `package → content` map for the code-gen sandbox.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { GadgetDescriptor } from '@ggui-ai/protocol';
import {
  fetchGadgetTypes,
  GadgetTypesFetchError,
} from './fetch-gadget-types';

const DTS = 'export declare function useLeafletMap(): unknown;\n';

function sri(content: string): string {
  return `sha384-${createHash('sha384').update(content).digest('base64')}`;
}

/** Minimal fetch stub returning canned bodies keyed by URL. */
function stubFetch(
  bodies: Record<string, { body: string; status?: number }>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = bodies[url];
    if (entry === undefined) {
      return { ok: false, status: 404 } as Response;
    }
    const status = entry.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () =>
        new TextEncoder().encode(entry.body).buffer as ArrayBuffer,
    } as Response;
  }) as typeof fetch;
}

// GG.8.1 — a `GadgetDescriptor` is a PACKAGE bundling `exports[]`.
// `over` carries package-level overrides; `hook` names the single
// hook export (it moved off the descriptor onto `exports[*]`).
function descriptor(
  over: Partial<GadgetDescriptor> & { hook?: string } = {},
): GadgetDescriptor {
  const { hook = 'useLeafletMap', ...packageOver } = over;
  return {
    package: '@my-org/leaflet',
    version: '0.0.1',
    exports: [
      {
        hook,
        description: 'Leaflet map.',
        usage: 'Mount for maps.',
        example: { call: 'useLeafletMap()' },
      },
    ],
    ...packageOver,
  };
}

describe('fetchGadgetTypes', () => {
  it('returns an empty object for an empty descriptor list', async () => {
    expect(await fetchGadgetTypes([], stubFetch({}))).toEqual({});
  });

  it('skips the stdlib package (sandbox already has its types)', async () => {
    const result = await fetchGadgetTypes(
      [
        descriptor({
          hook: 'useGeolocation',
          package: '@ggui-ai/gadgets',
          version: '0.1.0-rc.1',
          typesUrl: 'https://registry.ggui.ai/types/stdlib.d.ts',
        }),
      ],
      stubFetch({}),
    );
    expect(result).toEqual({});
  });

  it('skips descriptors without a typesUrl', async () => {
    const result = await fetchGadgetTypes([descriptor()], stubFetch({}));
    expect(result).toEqual({});
  });

  it('fetches a non-stdlib descriptor and keys the result by package', async () => {
    const url = 'https://registry.ggui.ai/types/leaflet/0.0.1/index.d.ts';
    const result = await fetchGadgetTypes(
      [descriptor({ typesUrl: url })],
      stubFetch({ [url]: { body: DTS } }),
    );
    expect(result).toEqual({ '@my-org/leaflet': DTS });
  });

  it('accepts a matching SHA-384 typesSri', async () => {
    const url = 'https://registry.ggui.ai/types/leaflet/0.0.1/index.d.ts';
    const result = await fetchGadgetTypes(
      [descriptor({ typesUrl: url, typesSri: sri(DTS) })],
      stubFetch({ [url]: { body: DTS } }),
    );
    expect(result['@my-org/leaflet']).toBe(DTS);
  });

  it('throws GadgetTypesFetchError on a typesSri mismatch', async () => {
    const url = 'https://registry.ggui.ai/types/leaflet/0.0.1/index.d.ts';
    await expect(
      fetchGadgetTypes(
        [descriptor({ typesUrl: url, typesSri: sri('different content') })],
        stubFetch({ [url]: { body: DTS } }),
      ),
    ).rejects.toThrow(GadgetTypesFetchError);
  });

  it('throws GadgetTypesFetchError on an HTTP error', async () => {
    const url = 'https://registry.ggui.ai/types/missing.d.ts';
    await expect(
      fetchGadgetTypes(
        [descriptor({ typesUrl: url })],
        stubFetch({ [url]: { body: '', status: 500 } }),
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('deduplicates a typesUrl shared by two descriptors (one fetch)', async () => {
    const url = 'https://registry.ggui.ai/types/maps/1.0.0/index.d.ts';
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          new TextEncoder().encode(DTS).buffer as ArrayBuffer,
      } as Response;
    }) as typeof fetch;
    const result = await fetchGadgetTypes(
      [
        descriptor({ hook: 'useMapA', package: '@my-org/maps', typesUrl: url }),
        descriptor({ hook: 'useMapB', package: '@my-org/maps', typesUrl: url }),
      ],
      counting,
    );
    expect(calls).toBe(1);
    expect(result['@my-org/maps']).toBe(DTS);
  });

  it('reports every failure in one error, not just the first', async () => {
    const a = 'https://registry.ggui.ai/types/a.d.ts';
    const b = 'https://registry.ggui.ai/types/b.d.ts';
    try {
      await fetchGadgetTypes(
        [
          descriptor({ package: '@my-org/a', typesUrl: a }),
          descriptor({ package: '@my-org/b', typesUrl: b }),
        ],
        stubFetch({
          [a]: { body: '', status: 404 },
          [b]: { body: '', status: 503 },
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GadgetTypesFetchError);
      expect((err as GadgetTypesFetchError).failures).toHaveLength(2);
    }
  });
});
