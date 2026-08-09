/**
 * Durable write-through for freshly registered blueprints (#430 slice
 * 2).
 *
 * The blueprint registry (`blueprint-registry.ts`) is a CAPPED vector
 * store: registering past `maxPerKind` evicts the lowest-hit entry, and
 * a deployment whose vector store is process-local loses the whole
 * bucket on restart. That is the right shape for a match cache — a miss
 * costs one regeneration. It is the wrong shape for anything that needs
 * to resolve a blueprint by id LATER, because "later" is exactly when
 * the entry is gone.
 *
 * So a registration that mints a fresh row also writes it through to a
 * durable pair: metadata to a {@link BlueprintStore}, the compiled body
 * to a {@link CodeStore} keyed by content hash. Deployments that bind
 * neither keep today's behavior exactly.
 *
 * ## Two `Blueprint` types, and the projection between them
 *
 * The registry's {@link RegistryBlueprint} and the protocol's
 * `Blueprint` share a name and almost nothing else. The registry row is
 * a match candidate: `id`, `kind`, `intent`, `componentCode` inline, a
 * `hitCount`. The protocol row is a persistence record: `blueprintId`,
 * `appId`, `contractHash`, a `codeHash` POINTER to the body. The
 * projection below is the only place the two meet, and it is where the
 * registry's `contractKey` becomes the protocol's `contractHash` —
 * one value, two spellings, same 16-char blueprintKey domain.
 *
 * ## Best-effort, and what "best" means when it fails
 *
 * Registration must never fail because durability hiccuped: the render
 * that triggered it already produced working code and already
 * committed. Both writes are therefore try/caught into named events.
 *
 * The order is body first, then metadata, and that is load-bearing. A
 * body with no row is an orphan — invisible, reclaimable, harmless. A
 * row naming a `codeHash` with no object behind it is a LIE: a later
 * resolve finds the record, fetches the body, gets nothing, and fails
 * at the point where it looked like it would succeed. So when the body
 * write fails, the row is still written but WITHOUT `codeHash`, which
 * reads as "metadata recorded, no body stored" — a state the protocol
 * type already models and consumers already branch on.
 *
 * ## Backfill posture — documented, not built
 *
 * Blueprints registered before this shipped exist only in the capped
 * vector registry. Their records carry a `blueprintId` that resolves to
 * nothing durable, so a re-mint against them lands in
 * `blueprint_unresolvable`. No backfill job exists, deliberately: the
 * affected rows are sandbox-only, the cost of the miss is one
 * regeneration, and a job to walk a capped in-memory registry would be
 * writing whatever survived rather than what was actually registered.
 * If real data ever needs it, the job is a scope scan of the vector
 * store through this same projection — but not until then.
 */
import type { BlueprintStore, CodeStore } from '@ggui-ai/mcp-server-core';
import type { Blueprint as DurableBlueprint } from '@ggui-ai/protocol';
import type { Blueprint as RegistryBlueprint } from './blueprint-registry.js';

/**
 * Every event this module can emit. Closed union — a new emitter picks
 * from these or extends the type, which is what makes a rename a
 * compile error rather than an alert filter that quietly stops
 * matching.
 */
export type BlueprintDurabilityEvent =
  | 'blueprint_durable_write_failed'
  | 'blueprint_code_write_failed';

/**
 * The event names as values, so every emitter — in this package or a
 * storage backend elsewhere — spells them from one place.
 */
export const BLUEPRINT_DURABILITY_EVENTS = {
  /** Metadata row rejected. The blueprint is not durably resolvable. */
  durableWriteFailed: 'blueprint_durable_write_failed',
  /** Body rejected. The row still lands, without a `codeHash`. */
  codeWriteFailed: 'blueprint_code_write_failed',
} as const satisfies Record<string, BlueprintDurabilityEvent>;

const DURABLE_WRITE_FAILED: BlueprintDurabilityEvent =
  BLUEPRINT_DURABILITY_EVENTS.durableWriteFailed;

const CODE_WRITE_FAILED: BlueprintDurabilityEvent =
  BLUEPRINT_DURABILITY_EVENTS.codeWriteFailed;

/**
 * The durable pair. Both optional at the binding site — a deployment
 * may have neither (no durability), or metadata without a body store
 * (rows persist, bodies do not).
 */
export interface BlueprintDurabilityDeps {
  readonly blueprintStore?: BlueprintStore;
  readonly codeStore?: CodeStore;
}

/**
 * Project a registry row onto the durable record.
 *
 * `codeHash` is passed rather than derived so the caller can omit it
 * when the body write failed — the record then honestly says no body
 * is stored. `codeS3Url` is deliberately NOT set here: it names a
 * location only the storage adapter knows, and the adapter composes it
 * on read.
 */
export function projectDurableBlueprint(
  blueprint: RegistryBlueprint,
  appId: string,
  codeHash: string | undefined,
  createdBy: DurableBlueprint['createdBy'] = 'agent',
): DurableBlueprint {
  return {
    blueprintId: blueprint.id,
    appId,
    // Registry `contractKey` → protocol `contractHash`. Same 16-char
    // blueprintKey value; see the module docstring.
    contractHash: blueprint.contractKey,
    source: blueprint.source,
    variance: blueprint.variance,
    createdAt: blueprint.createdAt,
    // WHO initiated the mint — a different axis from `source`, which
    // records what produced the code. An operator-invoked registration
    // is `createdBy: 'operator'` even when `source.kind` is `'llm'`.
    // Defaulted rather than derived: the registry row does not carry
    // this, and only the caller knows which tool it is serving.
    createdBy,
    contract: blueprint.contract,
    ...(codeHash !== undefined ? { codeHash } : {}),
  };
}

/**
 * Write a freshly minted blueprint through to durable storage.
 *
 * Never throws and never retries: one round-trip per store, both
 * try/caught. An unbound store is a no-op — not an error, and not an
 * event, because a deployment that never bound one is not failing at
 * anything.
 */
export async function writeBlueprintDurably(
  deps: BlueprintDurabilityDeps | undefined,
  appId: string,
  blueprint: RegistryBlueprint,
  createdBy: DurableBlueprint['createdBy'] = 'agent',
): Promise<void> {
  const blueprintStore = deps?.blueprintStore;
  if (!blueprintStore) return;

  // Body first — see the module docstring on why an orphan body beats a
  // row that points at nothing.
  let codeHash: string | undefined;
  const codeStore = deps?.codeStore;
  if (codeStore && blueprint.componentCode.length > 0) {
    try {
      const hash = codeStore.hashOf(blueprint.componentCode);
      await codeStore.put(hash, blueprint.componentCode);
      codeHash = hash;
    } catch (err) {
      logDurabilityFailure(CODE_WRITE_FAILED, blueprint, appId, err);
    }
  }

  try {
    await blueprintStore.put(
      projectDurableBlueprint(blueprint, appId, codeHash, createdBy),
    );
  } catch (err) {
    logDurabilityFailure(DURABLE_WRITE_FAILED, blueprint, appId, err);
  }
}

function logDurabilityFailure(
  event: BlueprintDurabilityEvent,
  blueprint: RegistryBlueprint,
  appId: string,
  err: unknown,
): void {
  // eslint-disable-next-line no-console -- structured single-line event for log-pipeline pickup
  console.warn(
    JSON.stringify({
      msg: event,
      blueprintId: blueprint.id,
      contractKey: blueprint.contractKey,
      appId,
      source: blueprint.source.kind,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
