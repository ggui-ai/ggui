import { createHash } from 'node:crypto';
import type { BlueprintVariance } from '../types/blueprint.js';
import { canonicalizeVariance } from './canonicalize-contract.js';

/**
 * Identity hash of the design-time variance block — the variant axis of
 * the reuse key. `(contractKey, variantKey)` identifies one reusable
 * component; runtime props are never an input. Spec §8.
 *
 * 16-char sha256 prefix of {@link canonicalizeVariance}'s output, which
 * is self-normalizing (D9): `undefined`, `{}`, `{persona:''}`, and any
 * all-empty variance hash to one stable "default variant" sentinel, so
 * the accept path (verbatim `blueprintMeta.variance`) and the override
 * path never false-miss on equivalent variance.
 *
 * Server-only — depends on `node:crypto`. Exposed at the
 * `@ggui-ai/protocol/blueprint-key` subpath (see `blueprint-key.ts`).
 */
export function variantKey(variance: BlueprintVariance | undefined): string {
  return createHash('sha256')
    .update(canonicalizeVariance(variance))
    .digest('hex')
    .slice(0, 16);
}
