/**
 * H1 ruling 1b — `rewritePrivateBundleUrls` unit matrix.
 *
 *   - OSS passthrough: no presigner ⇒ the item is returned unchanged
 *     (identity, not a clone) — the self-hosted same-origin story.
 *   - Private explicit `bundleUrl` / `styleUrl` / `typesUrl` values
 *     (containing `/bundles/private/`) are rewritten via the injected
 *     presigner.
 *   - Public explicit URLs and bundleHost-composed entries are
 *     untouched even with a presigner wired.
 *   - `deriveRenderMeta` over the rewritten item emits the presigned
 *     URL on both the iframe gadget registration AND the CSP
 *     `script-src` allowlist — the two consumers can't drift because
 *     the rewrite happens on the descriptor sidecar they both read.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentGguiSession, GadgetDescriptor } from '@ggui-ai/protocol';
import {
  deriveRenderMeta,
  PRIVATE_BUNDLE_PREFIX,
  rewritePrivateBundleUrls,
} from './slice-meta-derivation.js';

const NOW_MS = 1_760_000_000_000;

function componentItem(
  over: Partial<ComponentGguiSession> = {},
): ComponentGguiSession {
  return {
    id: 'page-1',
    appId: 'app-test',
    type: 'component',
    componentCode: 'export default () => null;',
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
    ...over,
  };
}

function descriptor(fields: {
  package: string;
  bundleUrl?: string;
  styleUrl?: string;
  typesUrl?: string;
  bundleHost?: string;
  bundleSri?: string;
}): GadgetDescriptor {
  const { package: pkg, ...transport } = fields;
  return {
    package: pkg,
    version: '1.0.0',
    exports: [
      {
        hook: 'useProbe',
        description: 'probe',
        usage: 'const v = useProbe();',
        example: { props: {} },
      },
    ],
    ...transport,
  };
}

const PRIVATE_BUNDLE =
  'https://registry.ggui.ai/bundles/private/@acme/secret/1.0.0/bundle.js';
const PRIVATE_STYLE =
  'https://registry.ggui.ai/bundles/private/@acme/secret/1.0.0/style.css';
const PRIVATE_TYPES =
  'https://registry.ggui.ai/bundles/private/@acme/secret/1.0.0/types.d.ts';
const PUBLIC_BUNDLE =
  'https://registry.ggui.ai/bundles/public/@acme/open/1.0.0/bundle.js';

/** Deterministic fake presigner — records inputs, tags outputs. */
function fakePresigner(): {
  presign: (url: string) => Promise<string>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    presign: async (url: string) => {
      calls.push(url);
      const { pathname } = new URL(url);
      return `https://bucket.s3.test${pathname}?X-Amz-Expires=60&X-Amz-Signature=stub`;
    },
  };
}

describe('rewritePrivateBundleUrls', () => {
  it('is a passthrough without a presigner (OSS default) — same item identity', async () => {
    const item = componentItem({
      gadgetDescriptors: [descriptor({ package: '@acme/secret', bundleUrl: PRIVATE_BUNDLE })],
    });
    const out = await rewritePrivateBundleUrls(item, undefined);
    expect(out).toBe(item);
  });

  it('rewrites private bundleUrl + styleUrl + typesUrl via the presigner', async () => {
    const { presign, calls } = fakePresigner();
    const item = componentItem({
      gadgetDescriptors: [
        descriptor({
          package: '@acme/secret',
          bundleUrl: PRIVATE_BUNDLE,
          styleUrl: PRIVATE_STYLE,
          typesUrl: PRIVATE_TYPES,
        }),
      ],
    });
    const out = await rewritePrivateBundleUrls(item, presign);
    expect(out).not.toBe(item);
    if (out.type !== 'component') throw new Error('variant changed');
    const d = out.gadgetDescriptors?.[0];
    expect(d?.bundleUrl).toBe(
      'https://bucket.s3.test/bundles/private/@acme/secret/1.0.0/bundle.js?X-Amz-Expires=60&X-Amz-Signature=stub',
    );
    expect(d?.styleUrl).toContain('style.css?X-Amz-Expires=60');
    expect(d?.typesUrl).toContain('types.d.ts?X-Amz-Expires=60');
    expect(calls).toEqual([PRIVATE_BUNDLE, PRIVATE_STYLE, PRIVATE_TYPES]);
    // Non-mutating: the source item keeps the registry URLs.
    expect(item.gadgetDescriptors?.[0]?.bundleUrl).toBe(PRIVATE_BUNDLE);
  });

  it('leaves public explicit URLs and bundleHost-composed entries untouched', async () => {
    const { presign, calls } = fakePresigner();
    const item = componentItem({
      gadgetDescriptors: [
        descriptor({ package: '@acme/open', bundleUrl: PUBLIC_BUNDLE }),
        descriptor({ package: '@acme/hosted', bundleHost: 'cdn.example.com' }),
      ],
    });
    const out = await rewritePrivateBundleUrls(item, presign);
    // No private URLs anywhere ⇒ identity return, zero presign calls.
    expect(out).toBe(item);
    expect(calls).toEqual([]);
  });

  it('rewrites only the private entries in a mixed descriptor list', async () => {
    const { presign, calls } = fakePresigner();
    const item = componentItem({
      gadgetDescriptors: [
        descriptor({ package: '@acme/open', bundleUrl: PUBLIC_BUNDLE }),
        descriptor({ package: '@acme/secret', bundleUrl: PRIVATE_BUNDLE }),
      ],
    });
    const out = await rewritePrivateBundleUrls(item, presign);
    if (out.type !== 'component') throw new Error('variant changed');
    expect(out.gadgetDescriptors?.[0]?.bundleUrl).toBe(PUBLIC_BUNDLE);
    expect(out.gadgetDescriptors?.[1]?.bundleUrl).toContain('X-Amz-Signature=stub');
    expect(calls).toEqual([PRIVATE_BUNDLE]);
  });

  it('passes system and mcpApps variants through untouched', async () => {
    const { presign } = fakePresigner();
    const system = {
      id: 'page-1',
      appId: 'app-test',
      type: 'system',
      kind: 'no-credentials',
      eventSequence: 0,
      createdAt: NOW_MS,
      lastActivityAt: NOW_MS,
      expiresAt: NOW_MS + 60_000,
    } as const;
    expect(await rewritePrivateBundleUrls(system, presign)).toBe(system);
  });

  it('projects the presigned URL onto BOTH the gadget registration and the CSP allowlist', async () => {
    const { presign } = fakePresigner();
    const item = componentItem({
      gadgetDescriptors: [
        descriptor({
          package: '@acme/secret',
          bundleUrl: PRIVATE_BUNDLE,
          bundleSri: 'sha384-stub',
        }),
      ],
    });
    const view = deriveRenderMeta(await rewritePrivateBundleUrls(item, presign));
    const reg = view.gadgets?.find((g) => g.package === '@acme/secret');
    expect(reg?.bundleUrl).toContain('https://bucket.s3.test/bundles/private/');
    // SRI survives the rewrite — the presigned URL serves identical bytes.
    expect(reg?.bundleSri).toBe('sha384-stub');
    // The presigned ORIGIN (not the registry origin) lands in script-src,
    // so the iframe's fetch of the rewritten URL passes its own CSP.
    expect(view.contentSecurityPolicy).toContain('https://bucket.s3.test');
    expect(view.contentSecurityPolicy).not.toContain('https://registry.ggui.ai');
  });

  it('exports the dispatch marker the deployment presigners key on', () => {
    expect(PRIVATE_BUNDLE_PREFIX).toBe('/bundles/private/');
    expect(PRIVATE_BUNDLE.includes(PRIVATE_BUNDLE_PREFIX)).toBe(true);
    expect(PUBLIC_BUNDLE.includes(PRIVATE_BUNDLE_PREFIX)).toBe(false);
  });
});
