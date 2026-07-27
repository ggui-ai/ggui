/**
 * Drift-catch: the SHIPPING gadget URL resolver ↔ the
 * `@ggui-ai/protocol-conformance` resolution-conformance catalog.
 *
 * Sibling to `assert-gadgets.conformance.test.ts`, which closes the
 * same loop for the registration gate trio. Same shape, same reason.
 *
 * The kit's own meta-test (`resolution-conformance.test.ts` in the kit)
 * grades a faithful in-test resolver built from SPEC §7.7.2 — that
 * proves the catalog itself is satisfiable, while keeping the
 * vendor-neutral kit free of any dependency on a server
 * implementation.
 *
 * THIS test closes the other half: it grades the real resolver every
 * bootstrap transport actually calls — {@link resolveGadgetUrls}, the
 * one that computes what lands in `_meta.ggui.bootstrap.gadgets[*]` and
 * in the CSP `script-src` / `style-src` allowlists. The dependency edge
 * points the right way (implementation → kit, a devDependency of this
 * package). If the shipping resolver ever drifts from the obligations
 * the catalog freezes — the `bundleUrl`-wins precedence inverted, the
 * loopback `http://` scheme dropped (mixed-content-blocking every local
 * registry workflow), a `styleUrl` auto-synthesized onto an
 * escape-hatched bundle (a 404 polluting `style-src`), or the
 * `@ggui-ai/gadgets` stdlib short-circuit removed — the failure
 * surfaces HERE, in the implementation package, not in the kit.
 */
import {
  gadgetResolutionCases,
  runResolutionConformance,
  type GadgetUrlEntry,
  type ResolvedGadgetUrls,
} from '@ggui-ai/protocol-conformance/resolution-conformance';
import { describe, expect, it } from 'vitest';

import { resolveGadgetUrls } from './slice-meta-derivation.js';

/**
 * Adapt the kit's authored entry vocabulary to the shipping resolver's
 * parameter. The two types are deliberately decoupled — the kit
 * authors `GadgetUrlEntry` (every field optional, because the resolver
 * is specified to defensively handle incomplete entries), while the
 * implementation reads a `Pick<GadgetDescriptor, …>` subset. The field
 * names and semantics are identical, so this adapter is a pass-through;
 * it exists so the decoupling stays a compile-time-checked seam rather
 * than an assumed one.
 */
function shippingResolve(entry: GadgetUrlEntry): ResolvedGadgetUrls {
  return resolveGadgetUrls(entry);
}

describe('the shipping gadget URL resolver conforms to the resolution-conformance catalog', () => {
  it('resolves every catalog case exactly as the SPEC requires', () => {
    const result = runResolutionConformance(shippingResolve);
    expect(
      result.failed,
      `the shipping resolveGadgetUrls drifted from the resolution-conformance catalog:\n${result.failed
        .map(
          (f) =>
            `  - ${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(
              f.actual,
            )}`,
        )
        .join('\n')}`,
    ).toEqual([]);
    // Sanity: the runner actually exercised the full catalog — a
    // resolver that graded zero cases would also report zero failures.
    expect(gadgetResolutionCases.length).toBeGreaterThan(0);
    expect(result.passed.length).toBe(gadgetResolutionCases.length);
  });
});
