/**
 * `fetchGadgetTypes` — handler-side parallel fetch of every
 * registered gadget's `.d.ts` declaration file. Runs at render time,
 * after `filterDescriptorsToContract` has resolved the descriptor
 * sidecar.
 *
 * Why handler-side: keeps `@ggui-ai/ui-gen` network-free. The handler
 * owns the I/O boundary; the generator consumes pre-fetched content.
 * The fetched `.d.ts` rides into the generator on
 * `UiGenerateInput.gadgetTypes` (a `package → dtsContent` map), where
 * the code-gen sandbox loads it into the type-checker VFS so generated
 * component code typechecks against the wrapper's real hook signature.
 *
 * Behavior:
 *   - Stdlib (`@ggui-ai/gadgets`) is skipped — the sandbox VFS already
 *     carries its types directly.
 *   - Descriptors without a `typesUrl` are skipped (pre-launch the
 *     `registeredGadgetDescriptorSchema` makes `typesUrl` required for
 *     non-stdlib, so this only spares a stdlib / hand-authored ref).
 *   - Unique `typesUrl`s are fetched in parallel (`Promise.all`).
 *   - Each fetched body is SHA-384-verified against the descriptor's
 *     `typesSri` when present — a CDN-compromise defense symmetric
 *     with `bundleSri`.
 *   - Throws {@link GadgetTypesFetchError} on any fetch failure or SRI
 *     mismatch. No silent degradation — a missing `.d.ts` means the
 *     sandbox can't typecheck against the wrapper, so the render fails
 *     loud and the agent retries.
 */

import { createHash } from 'node:crypto';
import type { GadgetDescriptor } from '@ggui-ai/protocol';
import { STDLIB_GADGETS_PACKAGE } from '@ggui-ai/protocol';

/**
 * Thrown when a gadget `.d.ts` cannot be fetched or fails SRI
 * verification. Carries the offending package + reason so the render
 * handler can surface an actionable error to the agent.
 */
export class GadgetTypesFetchError extends Error {
  readonly code = 'gadget_types_fetch_failed' as const;
  readonly failures: ReadonlyArray<{
    readonly package: string;
    readonly typesUrl: string;
    readonly reason: string;
  }>;
  constructor(
    failures: ReadonlyArray<{
      readonly package: string;
      readonly typesUrl: string;
      readonly reason: string;
    }>,
  ) {
    const lines = failures.map(
      (f) => `  - ${f.package} (${f.typesUrl}): ${f.reason}`,
    );
    super(
      `gadget_types_fetch_failed: could not load the .d.ts for ${failures.length} registered gadget(s):\n${lines.join(
        '\n',
      )}\n\nThe code-gen sandbox needs each wrapper's declaration file to typecheck generated component code. Verify the typesUrl is reachable and the typesSri matches.`,
    );
    this.name = 'GadgetTypesFetchError';
    this.failures = failures;
  }
}

/** Compute the `sha384-<base64>` SRI of a byte buffer. */
function sha384(bytes: Uint8Array): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

/**
 * Parallel-fetch the `.d.ts` for every non-stdlib descriptor that
 * declares a `typesUrl`. Returns a `package → dtsContent` map ready
 * to thread into `UiGenerateInput.gadgetTypes`.
 *
 * Returns an empty object when no descriptor needs a fetch (the
 * common path — pure-stdlib or gadget-free contracts pay zero
 * latency).
 *
 * @throws {GadgetTypesFetchError} on any fetch failure or SRI mismatch.
 */
export async function fetchGadgetTypes(
  descriptors: readonly GadgetDescriptor[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  // Dedup by typesUrl — collect the descriptors that need a fetch.
  // Keyed by typesUrl so two descriptors sharing one package+version
  // (a package exporting multiple hooks) fetch the .d.ts once.
  const byUrl = new Map<
    string,
    { readonly package: string; readonly typesSri?: string }
  >();
  for (const d of descriptors) {
    if (d.package === STDLIB_GADGETS_PACKAGE) continue;
    if (typeof d.typesUrl !== 'string' || d.typesUrl.length === 0) continue;
    if (byUrl.has(d.typesUrl)) continue;
    byUrl.set(d.typesUrl, {
      package: d.package,
      ...(typeof d.typesSri === 'string' ? { typesSri: d.typesSri } : {}),
    });
  }

  if (byUrl.size === 0) return {};

  const failures: Array<{
    package: string;
    typesUrl: string;
    reason: string;
  }> = [];
  const result: Record<string, string> = {};

  await Promise.all(
    [...byUrl.entries()].map(async ([typesUrl, meta]) => {
      try {
        const response = await fetchImpl(typesUrl);
        if (!response.ok) {
          failures.push({
            package: meta.package,
            typesUrl,
            reason: `HTTP ${response.status}`,
          });
          return;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (meta.typesSri !== undefined) {
          const actual = sha384(bytes);
          if (actual !== meta.typesSri) {
            failures.push({
              package: meta.package,
              typesUrl,
              reason: `SRI mismatch — expected ${meta.typesSri}, got ${actual}`,
            });
            return;
          }
        }
        result[meta.package] = new TextDecoder().decode(bytes);
      } catch (err) {
        failures.push({
          package: meta.package,
          typesUrl,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  if (failures.length > 0) {
    throw new GadgetTypesFetchError(failures);
  }
  return result;
}
