/**
 * Resolution-conformance catalog — accept cases for gadget bundle-URL
 * resolution (SPEC §7.7.2 — `resolveGadgetUrls`).
 *
 * ## Why this is a pure-function catalog
 *
 * Given a gadget descriptor's transport fields, the server computes
 * the bundle + style URLs the iframe sees in
 * `_meta.ggui.bootstrap.gadgets[*]`. That computation is a pure,
 * deterministic function — no session, transport, or wire frame — so
 * it gets the same treatment as the wire schema (`../schema-conformance`)
 * and the registry gate (`../registration-conformance`): a catalog of
 * cases graded against a caller-supplied resolver.
 *
 * Every case here is an "accept"-shaped check — the resolver always
 * produces *some* result; the obligation is which URLs (or none).
 *
 * ## Polyglot, decoupled
 *
 * Each case ships as raw JSON under `./cases/`.
 * {@link runResolutionConformance} takes the resolver as a callback —
 * the kit never imports a concrete resolver here, so adopters drive
 * their OWN. The reference binding (`./resolution-conformance.test.ts`)
 * uses a faithful in-test resolver built from `@ggui-ai/protocol`'s
 * `DEFAULT_BUNDLE_HOST` + `bundleHostScheme` primitives.
 */
import resolveBundleHostComputed from './cases/resolve-bundle-host-computed.json' with { type: 'json' };
import resolveDefaultHost from './cases/resolve-default-host.json' with { type: 'json' };
import resolveExplicitBundleAndStyleUrl from './cases/resolve-explicit-bundle-and-style-url.json' with { type: 'json' };
import resolveExplicitBundleUrl from './cases/resolve-explicit-bundle-url.json' with { type: 'json' };
import resolveLoopbackHostHttpScheme from './cases/resolve-loopback-host-http-scheme.json' with { type: 'json' };
import resolvePackageOnlyNoVersion from './cases/resolve-package-only-no-version.json' with { type: 'json' };
import resolveStdlibNoUrls from './cases/resolve-stdlib-no-urls.json' with { type: 'json' };

/**
 * The transport-relevant subset of a gadget descriptor the resolver
 * reads. Authored loose — every field optional — because the resolver
 * is defined to defensively handle incomplete entries (a `package`
 * with no `version`, etc.). Decoupled from `@ggui-ai/protocol`'s
 * `GadgetDescriptor` on purpose: this is the kit's authored vocabulary.
 */
export interface GadgetUrlEntry {
  readonly package?: string;
  readonly version?: string;
  readonly bundleUrl?: string;
  readonly bundleHost?: string;
  readonly styleUrl?: string;
}

/**
 * What the resolver produces — the bundle + style URLs (either may be
 * absent: an escape-hatched bundle synthesizes no style, a stdlib or
 * version-less entry resolves to neither).
 */
export interface ResolvedGadgetUrls {
  readonly bundleUrl?: string;
  readonly styleUrl?: string;
}

/**
 * One resolution-conformance case. Authored as JSON under `./cases/`,
 * consumed via {@link gadgetResolutionCases}, graded by
 * {@link runResolutionConformance}.
 *
 * The shape IS the public API — additive changes only.
 */
export interface ResolutionConformanceCase {
  /** Unique case name. MUST match the JSON filename without `.json`. */
  readonly name: string;
  /** Which resolution obligation this case proves. */
  readonly description: string;
  /** The descriptor transport fields fed to the resolver. */
  readonly entry: GadgetUrlEntry;
  /** The URLs a spec-conformant resolver MUST produce. */
  readonly expect: ResolvedGadgetUrls;
}

/**
 * Every gadget URL-resolution case the kit ships, in deterministic
 * order — explicit-URL cases, then host-computed, then the
 * no-resolution edges.
 */
export const gadgetResolutionCases: readonly ResolutionConformanceCase[] = [
  resolveExplicitBundleUrl as ResolutionConformanceCase,
  resolveExplicitBundleAndStyleUrl as ResolutionConformanceCase,
  resolveBundleHostComputed as ResolutionConformanceCase,
  resolveDefaultHost as ResolutionConformanceCase,
  resolveLoopbackHostHttpScheme as ResolutionConformanceCase,
  resolveStdlibNoUrls as ResolutionConformanceCase,
  resolvePackageOnlyNoVersion as ResolutionConformanceCase,
];

/** One case the resolver under test graded wrong. */
export interface ResolutionConformanceMismatch {
  readonly name: string;
  /** The URLs the catalog says a conformant resolver MUST produce. */
  readonly expected: ResolvedGadgetUrls;
  /** The URLs the resolver under test actually produced. */
  readonly actual: ResolvedGadgetUrls;
}

/** Outcome of grading a resolver against the catalog. */
export interface ResolutionConformanceResult {
  /** Names of cases the resolver graded correctly. */
  readonly passed: readonly string[];
  /** Cases the resolver graded wrong — empty iff fully conformant. */
  readonly failed: readonly ResolutionConformanceMismatch[];
}

function resolvedUrlsEqual(a: ResolvedGadgetUrls, b: ResolvedGadgetUrls): boolean {
  return a.bundleUrl === b.bundleUrl && a.styleUrl === b.styleUrl;
}

/**
 * Grade a gadget URL resolver against the catalog.
 *
 * `resolve` MUST be a pure computation of `(entry) → {bundleUrl?,
 * styleUrl?}`. The kit deliberately does NOT import a concrete
 * resolver — adopters pass their own (the reference binding uses a
 * faithful in-test resolver; see `./resolution-conformance.test.ts`).
 * A conformant resolver produces an empty `failed` array.
 *
 * `resolve` is invoked exactly once per case, in
 * {@link gadgetResolutionCases} order; it MUST be pure and MUST NOT
 * throw.
 */
export function runResolutionConformance(
  resolve: (entry: GadgetUrlEntry) => ResolvedGadgetUrls,
): ResolutionConformanceResult {
  const passed: string[] = [];
  const failed: ResolutionConformanceMismatch[] = [];
  for (const testCase of gadgetResolutionCases) {
    const actual = resolve(testCase.entry);
    if (resolvedUrlsEqual(actual, testCase.expect)) {
      passed.push(testCase.name);
    } else {
      failed.push({
        name: testCase.name,
        expected: testCase.expect,
        actual,
      });
    }
  }
  return { passed, failed };
}
