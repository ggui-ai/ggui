/**
 * Resolution-conformance catalog meta-tests.
 *
 * Two jobs:
 *   1. Pin the published catalog shape (count, load-bearing
 *      `ResolutionConformanceCase` fields).
 *   2. Prove the catalog is internally coherent + the runner grades
 *      honestly: a faithful, spec-correct resolver passes every case;
 *      a deliberately wrong resolver fails the cases it should.
 *
 * ## Why a kit-local reference resolver, not the shipping one
 *
 * The shipping resolver — `resolveGadgetUrls` — lives in
 * `@ggui-ai/mcp-server-handlers`, a server implementation. A
 * vendor-neutral conformance kit MUST NOT depend on a specific
 * implementation. So this meta-test verifies the catalog against a
 * faithful resolver built here from SPEC §7.7.2, using the
 * `@ggui-ai/protocol` primitives `DEFAULT_BUNDLE_HOST` +
 * `bundleHostScheme` (the constants are the real ones; only the ~15-line
 * branching is restated). That proves the seven cases are satisfiable
 * by a spec-correct resolver.
 *
 * The drift-catch against the SHIPPING resolver belongs
 * implementation-side — a test in `@ggui-ai/mcp-server-handlers` that
 * grades its real `resolveGadgetUrls` via `runResolutionConformance`.
 */
import { bundleHostScheme, DEFAULT_BUNDLE_HOST } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

import {
  gadgetResolutionCases,
  runResolutionConformance,
  type GadgetUrlEntry,
  type ResolvedGadgetUrls,
} from './index.js';

/**
 * A faithful minimal implementation of SPEC §7.7.2 bundle-URL
 * resolution — independent of `@ggui-ai/mcp-server-handlers`. Mirrors
 * `resolveGadgetUrls`: explicit `bundleUrl` wins (no style auto-synth),
 * else compute from `bundleHost` or the default host; `@ggui-ai/gadgets`
 * stdlib resolves to no URLs.
 */
function referenceResolve(entry: GadgetUrlEntry): ResolvedGadgetUrls {
  const { bundleUrl, bundleHost, styleUrl, package: pkg, version } = entry;
  if (pkg === '@ggui-ai/gadgets') return {};

  const hasExplicitBundleUrl =
    typeof bundleUrl === 'string' && bundleUrl.length > 0;

  const computeFromHost = (
    file: 'bundle.js' | 'style.css',
  ): string | undefined => {
    if (typeof pkg !== 'string' || typeof version !== 'string') {
      return undefined;
    }
    const host =
      typeof bundleHost === 'string' && bundleHost.length > 0
        ? bundleHost
        : DEFAULT_BUNDLE_HOST;
    return `${bundleHostScheme(host)}://${host}/bundles/${pkg}/${version}/${file}`;
  };

  const resolvedBundle = hasExplicitBundleUrl
    ? bundleUrl
    : computeFromHost('bundle.js');
  const resolvedStyle =
    typeof styleUrl === 'string' && styleUrl.length > 0
      ? styleUrl
      : hasExplicitBundleUrl
        ? undefined
        : computeFromHost('style.css');

  return {
    ...(resolvedBundle !== undefined ? { bundleUrl: resolvedBundle } : {}),
    ...(resolvedStyle !== undefined ? { styleUrl: resolvedStyle } : {}),
  };
}

describe('gadget resolution-conformance catalog', () => {
  it('ships 7 cases', () => {
    expect(gadgetResolutionCases.length).toBe(7);
  });

  it('every case has the load-bearing ResolutionConformanceCase fields', () => {
    const names = new Set<string>();
    for (const testCase of gadgetResolutionCases) {
      expect(typeof testCase.name).toBe('string');
      expect(testCase.name.length).toBeGreaterThan(0);
      expect(names.has(testCase.name)).toBe(false); // unique
      names.add(testCase.name);
      expect(typeof testCase.description).toBe('string');
      expect(testCase.description.length).toBeGreaterThan(0);
      expect(typeof testCase.entry).toBe('object');
      expect(typeof testCase.expect).toBe('object');
    }
  });

  it('a spec-correct resolver passes every case (catalog is coherent)', () => {
    const result = runResolutionConformance(referenceResolve);
    // A faithful §7.7.2 resolver produces zero mismatches. A non-empty
    // `failed` array means a case carries a mis-authored `expect`.
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(gadgetResolutionCases.length);
  });

  it('a no-op resolver fails every case that expects URLs (runner grades)', () => {
    // A resolver that always returns `{}` must fail exactly the cases
    // whose `expect` carries a URL — proves the runner grades, and
    // passes the genuine no-resolution cases (stdlib, no-version).
    const result = runResolutionConformance(() => ({}));
    const urlCases = gadgetResolutionCases.filter(
      (c) => c.expect.bundleUrl !== undefined || c.expect.styleUrl !== undefined,
    );
    expect(result.failed.length).toBe(urlCases.length);
    expect(result.failed.map((f) => f.name).sort()).toEqual(
      urlCases.map((c) => c.name).sort(),
    );
  });
});
