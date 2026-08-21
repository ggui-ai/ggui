/**
 * Blueprint registry.
 *
 * Storage layer for the blueprint-first runtime cache. Supersedes the
 * intent-keyed `generation-cache.ts` with a contract-keyed registry
 * that supports the three-tier match flow:
 *
 *   - Tier 1: exact contract-hash lookup → instant reuse.
 *   - Tier 2: RAG retrieval → top-K candidates handed to the LLM judge.
 *   - Tier 3: cold gen → register the produced blueprint.
 *
 * ## Storage layout (uuid-keyed)
 *
 * Vector-store rows are keyed by an opaque `bp_<uuid>` id minted once at
 * first registration. The deterministic reuse identity lives in the
 * sibling {@link BlueprintIndex}, which maps the exact key
 * `${kind}:${contractKey}:${variantKey}` to that uuid. `kind` is the
 * atomic-design level (`'template'` for full components today;
 * `'organism'` / `'molecule'` / `'atom'` reserved for future
 * compositional decomposition).
 *
 * One blueprint per `(scope, kind, contractKey, variantKey)` tuple:
 * the same contract under distinct design-time variance blocks resolves
 * to distinct sibling rows (distinct exact keys → distinct uuids). The
 * default variant (absent / empty variance) hashes to one stable sentinel.
 *
 * ## What's stored
 *
 *   - vector: embedding of `summarizeContract(contract) + intent`
 *     (the same shape the LLM judge sees — no second source of truth).
 *   - metadata: a JSON blob carrying
 *     `{intent, contract, componentCode, contractKey, createdAt,
 *     hitCount, lastHitAt?}` so reconstruction is one round-trip.
 *
 * ## Pure-data layer
 *
 * No LLM calls in this module. The judge / rerank step happens
 * downstream in the handshake handler. Registry just persists,
 * retrieves, and enumerates.
 */
import { randomUUID } from 'node:crypto';
import type {
  BlueprintIndex,
  EmbeddingProvider,
  EnumerableVectorStore,
  KeyedVectorStore,
  VectorEntry,
  VectorRowSummary,
  VectorSearchResult,
  VectorStore,
} from '@ggui-ai/mcp-server-core';

// Re-export the core seam so handlers-side consumers (matcher, render,
// ops-blueprint) name the index type from one barrel without reaching
// into `@ggui-ai/mcp-server-core` directly.
export type { BlueprintIndex } from '@ggui-ai/mcp-server-core';
import {
  blueprintSourceToFlat,
  flatToBlueprintSource,
  summarizeContract,
  type BlueprintSource,
  type BlueprintVariance,
  type DataContract,
} from '@ggui-ai/protocol';
// `blueprintKey` + `variantKey` are server-only — pulled in from a
// dedicated subpath because they import `node:crypto`, which browsers
// can't bundle.
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import {
  validateContractRedundancy,
  type ContractValidationFinding,
  type ContractValidationResult,
} from '@ggui-ai/negotiator';
import {
  writeBlueprintDurably,
  type BlueprintDurabilityDeps,
} from './blueprint-durability.js';

/**
 * Atomic-design level. The runtime currently writes only
 * `'template'` — the full-component case. Smaller-grain kinds are
 * reserved for future compositional decomposition.
 */
export type BlueprintKind = 'template' | 'organism' | 'molecule' | 'atom';

/** A blueprint as carried through the registry. */
export interface Blueprint {
  /**
   * Opaque registry id — `bp_<uuid>`, minted once at first registration.
   * Identity is no longer derived from `(kind, contractKey)`; the
   * deterministic exact-lookup key composes `(kind, contractKey,
   * variantKey)` and resolves to this id via the {@link BlueprintIndex}.
   */
  readonly id: string;
  readonly kind: BlueprintKind;
  /** Identity hash of `contract` — equal contract produce equal keys. */
  readonly contractKey: string;
  /**
   * Identity hash of the design-time {@link variance} block — the variant
   * axis of the reuse key. `(contractKey, variantKey)` identifies one
   * reusable component; runtime props are never an input. Self-normalizing:
   * `undefined` / `{}` / all-empty variance hash to one stable "default
   * variant" sentinel. See `variantKey()` in `@ggui-ai/protocol`.
   */
  readonly variantKey: string;
  /**
   * Design-time variance tags carried alongside the contract. The variant
   * selector reads these to pick the best fit; `variantKey` is their
   * identity hash. Defaults to `{}` (the default variant).
   */
  readonly variance: BlueprintVariance;
  readonly contract: DataContract;
  /** Original intent prose that produced the blueprint. Diagnostic + RAG. */
  readonly intent: string;
  /** Generated component source. Empty string when generation hasn't happened yet. */
  readonly componentCode: string;
  /**
   * Authored (pre-compile) source body, when the generator distinguishes
   * one from the compiled {@link componentCode}. Carried in-memory only
   * — from `registerBlueprint`'s construction through to the durable
   * write in `writeBlueprintDurably` — and NEVER persisted in
   * vector-store metadata: a multi-KB source blob would blow the
   * filterable-metadata size cap on production vector-store backends
   * (vector-store metadata stays small; code bodies go through the
   * `CodeStore` seam). A row read back via {@link rowToBlueprint} always
   * has this `undefined`; only {@link sourceCodeHash} round-trips.
   */
  readonly sourceCode?: string;
  /**
   * Content hash (`CodeStore.hashOf`) of {@link sourceCode}, computed at
   * registration when a `CodeStore` is bound. Unlike `sourceCode`
   * itself, THIS field rides the vector-store row (see
   * `METADATA_KEYS.sourceCodeHash`) — the small scalar pointer the
   * `codeHash` pattern already established for compiled bodies.
   */
  readonly sourceCodeHash?: string;
  /** ISO timestamp of registration. */
  readonly createdAt: string;
  /** Times this entry was returned as a registry hit. Bumps on Tier 1 + Tier 2 hits. */
  readonly hitCount: number;
  /** ISO timestamp of the most recent hit. Absent until first hit. */
  readonly lastHitAt?: string;
  /**
   * Provenance of `componentCode` — the {@link BlueprintSource}
   * union. `llm` rows carry the engine slug + model id of the
   * generation that produced the code; `user` rows are
   * developer-registered / hand-authored. Required: rows whose stored
   * provenance fails the validating narrower (including every row
   * written under the retired flat `provenance` vocabulary) do not
   * reconstruct — {@link rowToBlueprint} drops them with a log line.
   * A blueprint cache invalidates by regeneration; it never coerces.
   */
  readonly source: BlueprintSource;
  /**
   * Lifecycle-owner marker for rows materialized by the marketplace
   * install bridge (`installToCache`). Orthogonal to {@link source}
   * (which records who authored the code): the install bridge owns
   * these rows' lifecycle — orphan eviction on uninstall and
   * stale-row eviction on compile failure key on this marker, never
   * on authorship. Only the install bridge writes it.
   */
  readonly installed?: boolean;
  /**
   * Structural validator findings emitted at registration time. Only
   * `severity: 'warn'` findings reach this list — `severity: 'error'`
   * findings short-circuit registration via {@link BlueprintRejectedError}.
   * Surfaced on the return value (NOT persisted in vector-store metadata)
   * so operators can see "this blueprint registered with warnings" without
   * widening the storage schema.
   */
  readonly validationWarnings?: readonly ContractValidationFinding[];
}

/**
 * Pluggable contract-validator. Defaults to {@link validateContractRedundancy}
 * from `@ggui-ai/negotiator`. Tests inject custom validators to assert
 * fail-closed semantics on `severity: 'error'` findings; production wires
 * the default and lets the heuristic decide.
 */
export type ContractValidator = (
  contract: DataContract,
) => ContractValidationResult;

/**
 * Thrown by {@link registerBlueprint} when the structural validator
 * emits one or more `severity: 'error'` findings. Carries the full
 * findings list so callers can render the diagnostic alongside the
 * rejected contract — e.g. on a cache trace event or in an operator
 * log line.
 *
 * Distinct from contract-shape and access errors thrown elsewhere:
 *   - ContractViolationError      — runtime data violates a declared schema
 *   - GguiSessionNotFoundError         — target GguiSession id is missing
 *   - BlueprintRejectedError (this) — contract structure trips a fail-closed
 *                                     validator finding at registration time
 */
export class BlueprintRejectedError extends Error {
  readonly code = 'blueprint_rejected' as const;
  readonly findings: readonly ContractValidationFinding[];
  constructor(findings: readonly ContractValidationFinding[]) {
    const summary = findings.map((f) => `[${f.kind}] ${f.hint}`).join(' | ');
    super(
      `registerBlueprint: contract rejected by structural validator. ${summary}`,
    );
    this.name = 'BlueprintRejectedError';
    this.findings = findings;
  }
}

/** Compose deps for the registry — embedder + vector store + identity index. */
export interface BlueprintRegistryDeps {
  readonly embedding: EmbeddingProvider;
  readonly vectorStore: VectorStore;
  /**
   * `(scope, exactKey) → blueprintId` resolver. Sibling of
   * {@link vectorStore}: the vector store holds the embedding+metadata row;
   * this index resolves the deterministic exact-lookup key to the row's id
   * without a scope scan. Threaded now (plumbing wave); the dedup +
   * indexed exact lookup that consume it land next wave.
   */
  readonly index: BlueprintIndex;
  /**
   * Durable write-through target (#430 slice 2). When bound, a fresh
   * mint is also written to a {@link BlueprintStore} (+ optional
   * {@link CodeStore} for the body) so it stays resolvable by id after
   * the capped registry has evicted it or the process has restarted.
   *
   * Optional and best-effort: absent ⇒ no write, no event; present and
   * failing ⇒ a named event and a registration that still succeeds.
   * See `blueprint-durability.ts`.
   */
  readonly durability?: BlueprintDurabilityDeps;
}

/** Input for {@link registerBlueprint}. */
export interface RegisterBlueprintInput {
  readonly kind: BlueprintKind;
  readonly contract: DataContract;
  readonly intent: string;
  readonly componentCode: string;
  /**
   * Authored (pre-compile) source body, when the generator distinguishes
   * one from `componentCode`. Optional — the registry persists only its
   * content hash in row metadata (vector-store metadata stays small;
   * code bodies go through the `CodeStore` seam). Skipped entirely (no
   * hash computed, no body written) when byte-identical to
   * `componentCode` — fallback-collapse symmetry: engines that
   * duplicate compiled output into `sourceCode` produce a pair the
   * read-side envelope guard would reject anyway, so persisting it is
   * pure waste — or when no `CodeStore` is bound (no store → no hash →
   * honest absence, never a guess).
   */
  readonly sourceCode?: string;
  /**
   * Provenance of `componentCode` — required, no default. Every mint
   * site knows where its code came from: generation paths stamp
   * `{kind: 'llm', generator, model}`, registration/import paths
   * stamp `{kind: 'user'}`. The matcher ignores provenance; the field
   * exists for observability and for export (PortableBlueprint v2
   * requires it).
   */
  readonly source: BlueprintSource;
  /**
   * Lifecycle-owner marker — see {@link Blueprint.installed}. Only
   * the install bridge (`installToCache`) passes `true`.
   */
  readonly installed?: boolean;
  /**
   * Design-time variance tags for this registration. Drives the variant
   * axis of the reuse key via `variantKey(variance)`. Omitted → the
   * default variant (`{}`); the self-normalizing hash treats absent /
   * empty variance as one stable sentinel.
   */
  readonly variance?: BlueprintVariance;
  /**
   * WHO initiated this mint, for the durable record. `'agent'` is the
   * standard handshake → render flow; the operator tools
   * (`ggui_ops_register_blueprint` / `ggui_ops_generate_blueprint`)
   * pass `'operator'`.
   *
   * A different axis from {@link source}, which records what PRODUCED
   * the code: an operator-invoked generation is `createdBy: 'operator'`
   * AND `source.kind: 'llm'`. Defaults to `'agent'` — the registry row
   * itself does not carry the field, so only the caller knows.
   */
  readonly createdBy?: 'agent' | 'operator';
}

/**
 * Compose the deterministic exact-lookup key — the `(scope, exactKey)`
 * half of the {@link BlueprintIndex} binding. Three-segment join
 * `${kind}:${contractKey}:${variantKey}` so the variant axis is part of
 * the reuse identity: two registrations of the same contract shape under
 * distinct variance blocks resolve to distinct exact keys (and so distinct
 * cached components). The index maps this key to the row's opaque
 * `bp_<uuid>` id; identity is never derived from `(kind, contractKey)`.
 */
export function composeExactKey(
  kind: BlueprintKind,
  contractKey: string,
  variantKey: string,
): string {
  return `${kind}:${contractKey}:${variantKey}`;
}

/**
 * Compute the embedding input string. Concatenates the canonical
 * contract summary with the intent prose so retrieval is hybrid:
 * structural shape anchors the result, intent prose feeds bge-small's
 * topic-similarity awareness.
 *
 * Exported so the rerank prompt path can produce the same string —
 * the prompt's `cachedContractSummary` MUST equal what was embedded.
 */
export function composeEmbeddingInput(
  contract: DataContract | undefined,
  intent: string,
): string {
  return `${summarizeContract(contract)}\nINTENT: ${intent.trim()}`;
}

/**
 * Vector-store metadata layout. Provenance is flat-encoded via the
 * protocol's flat-provenance codec (`blueprintSourceToFlat` /
 * `flatToBlueprintSource`, keys `sourceKind` / `sourceGenerator` /
 * `sourceModel`) — the union is the code shape; storage stays scalar,
 * and the key vocabulary has ONE owner in `@ggui-ai/protocol`. Rows
 * written under the retired flat `provenance` vocabulary lack
 * `sourceKind` and therefore fail the codec's read narrower — they
 * stop reconstructing (rebuild posture: the cache regenerates; there
 * is no migration shim).
 */
const METADATA_KEYS = {
  intent: 'intent',
  componentCode: 'componentCode',
  contract: 'contract',
  contractKey: 'contractKey',
  variantKey: 'variantKey',
  variance: 'variance',
  kind: 'kind',
  createdAt: 'createdAt',
  hitCount: 'hitCount',
  lastHitAt: 'lastHitAt',
  installed: 'installed',
  sourceCodeHash: 'sourceCodeHash',
} as const;

function blueprintToMetadata(
  bp: Omit<Blueprint, 'id'>,
): Record<string, string | number | boolean | null> {
  return {
    [METADATA_KEYS.intent]: bp.intent,
    [METADATA_KEYS.componentCode]: bp.componentCode,
    [METADATA_KEYS.contract]: JSON.stringify(bp.contract),
    [METADATA_KEYS.contractKey]: bp.contractKey,
    [METADATA_KEYS.variantKey]: bp.variantKey,
    [METADATA_KEYS.variance]: JSON.stringify(bp.variance),
    [METADATA_KEYS.kind]: bp.kind,
    [METADATA_KEYS.createdAt]: bp.createdAt,
    [METADATA_KEYS.hitCount]: bp.hitCount,
    // Flat-provenance scalars — key names owned by the protocol codec.
    ...blueprintSourceToFlat(bp.source),
    ...(bp.installed === true ? { [METADATA_KEYS.installed]: true } : {}),
    ...(bp.lastHitAt !== undefined
      ? { [METADATA_KEYS.lastHitAt]: bp.lastHitAt }
      : {}),
    // `sourceCode` itself (the raw body) is deliberately NEVER written
    // here — only its hash. See `Blueprint.sourceCode`'s docstring.
    ...(bp.sourceCodeHash !== undefined
      ? { [METADATA_KEYS.sourceCodeHash]: bp.sourceCodeHash }
      : {}),
  };
}

/**
 * Once-per-row-id guard for the dropped-row log so a lingering
 * legacy row doesn't spam the log on every query/list pass. Bounded
 * by the store's row count; cleared only on process restart.
 */
const droppedRowIds = new Set<string>();

function warnDroppedRow(id: string, reason: string): void {
  if (droppedRowIds.has(id)) return;
  droppedRowIds.add(id);
  // eslint-disable-next-line no-console -- operator-visible invalidation notice
  console.warn(
    `[ggui] blueprint registry: dropped row ${id} — ${reason} ` +
      '(legacy rows are invalidated, not migrated; the cache regenerates on next use)',
  );
}

function readScalarString(
  value: string | number | boolean | null | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Narrow a stored `kind` scalar to {@link BlueprintKind}, or `undefined`
 * when the row is foreign / malformed. Avoids an unchecked cast at the
 * index-key reconstruction site.
 */
function readBlueprintKind(
  value: string | number | boolean | null | undefined,
): BlueprintKind | undefined {
  if (
    value === 'template' ||
    value === 'organism' ||
    value === 'molecule' ||
    value === 'atom'
  ) {
    return value;
  }
  return undefined;
}

function readScalarNumber(
  value: string | number | boolean | null | undefined,
): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Reconstruct a `Blueprint` from a vector store row. Returns `null`
 * when the row's shape doesn't match (defensive — same scope can
 * legitimately host other vector families today, and we silently
 * skip foreign rows rather than crashing on missing fields).
 *
 * A row that IS shaped like a blueprint but carries no valid
 * provenance (legacy `provenance` vocabulary, missing `sourceKind`)
 * OR no `variantKey` (written before the variant axis existed, or by
 * a storage codec that dropped it) is dropped WITH a log line — that
 * is the rebuild posture for registry schema changes, not a silent
 * foreign-row skip. No compat read: defaulting a missing `variantKey`
 * to the default-variant sentinel would silently collapse variant
 * identity for every such row.
 */
function rowToBlueprint(
  key: string,
  metadata: Record<string, string | number | boolean | null>,
): Blueprint | null {
  const intent = readScalarString(metadata[METADATA_KEYS.intent]);
  const componentCode = readScalarString(metadata[METADATA_KEYS.componentCode]);
  const contractStr = readScalarString(metadata[METADATA_KEYS.contract]);
  const contractKey = readScalarString(metadata[METADATA_KEYS.contractKey]);
  const kindStr = readScalarString(metadata[METADATA_KEYS.kind]);
  const createdAt = readScalarString(metadata[METADATA_KEYS.createdAt]);
  if (
    intent === undefined ||
    componentCode === undefined ||
    contractStr === undefined ||
    contractKey === undefined ||
    kindStr === undefined ||
    createdAt === undefined
  ) {
    return null;
  }
  if (
    kindStr !== 'template' &&
    kindStr !== 'organism' &&
    kindStr !== 'molecule' &&
    kindStr !== 'atom'
  ) {
    return null;
  }
  let contract: DataContract;
  try {
    contract = JSON.parse(contractStr) as DataContract;
  } catch {
    return null;
  }
  const source = flatToBlueprintSource(metadata);
  if (source === null) {
    warnDroppedRow(key, 'missing or malformed provenance');
    return null;
  }
  const hitCount = readScalarNumber(metadata[METADATA_KEYS.hitCount]) ?? 0;
  const lastHitAt = readScalarString(metadata[METADATA_KEYS.lastHitAt]);
  const installed = metadata[METADATA_KEYS.installed] === true;
  const variance = readVariance(metadata[METADATA_KEYS.variance]);
  // `variantKey` is identity-bearing — `blueprintToMetadata` always
  // writes it, so a blueprint-shaped row without one is a legacy row
  // (pre-variant-axis, or written through a codec that dropped it).
  // Drop with a log line; defaulting would silently rebind the row to
  // the default variant.
  const variantKeyValue = readScalarString(metadata[METADATA_KEYS.variantKey]);
  if (variantKeyValue === undefined) {
    warnDroppedRow(key, 'missing variantKey');
    return null;
  }
  // Missing on legacy rows (written before this field existed) — never
  // an error, just absence. `sourceCode` itself never round-trips (it
  // was never persisted); only the hash does.
  const sourceCodeHash = readScalarString(metadata[METADATA_KEYS.sourceCodeHash]);
  return {
    id: key,
    kind: kindStr,
    contractKey,
    variantKey: variantKeyValue,
    variance,
    contract,
    intent,
    componentCode,
    createdAt,
    hitCount,
    source,
    ...(installed ? { installed: true } : {}),
    ...(lastHitAt !== undefined ? { lastHitAt } : {}),
    ...(sourceCodeHash !== undefined ? { sourceCodeHash } : {}),
  };
}

/**
 * Reconstruct a {@link BlueprintVariance} from the stored JSON blob.
 * Defensive only — `blueprintToMetadata` always writes `variance`
 * alongside the (required) `variantKey`, so an absent or malformed
 * blob resolves to `{}` without shifting identity: the row's identity
 * lives in the stored `variantKey` hash, never in this projection.
 */
function readVariance(
  value: string | number | boolean | null | undefined,
): BlueprintVariance {
  const str = readScalarString(value);
  if (str === undefined) return {};
  try {
    return JSON.parse(str) as BlueprintVariance;
  } catch {
    return {};
  }
}

/**
 * Default cap on registered blueprints per (scope, kind). When a
 * fresh registration would push the bucket past the cap,
 * {@link registerBlueprint} evicts the lowest-`hitCount` entry first;
 * ties broken by oldest `createdAt`. The number is calibrated for an
 * OSS single-tenant `ggui serve` workload — every render is one
 * `template` entry, so 100 templates per scope = ~100 distinct
 * UI shapes the agent has built across its renders, well above any
 * realistic single-app surface and small enough to keep the
 * `InMemoryVectorStore` footprint bounded under abuse.
 */
export const DEFAULT_MAX_BLUEPRINTS_PER_KIND = 100;

export interface RegisterBlueprintOptions {
  /**
   * Cap on entries per (scope, kind). When the bucket already holds
   * `cap` entries AND the new key isn't a re-write of an existing
   * row, the lowest-hitCount entry is evicted before the put.
   * Re-writes (same key) bypass eviction — they don't grow the bucket.
   * Set to `Infinity` to disable eviction (test-only; production
   * paths should always cap to bound memory).
   */
  readonly maxPerKind?: number;
  /**
   * Override the default structural validator. Defaults to
   * {@link validateContractRedundancy} from `@ggui-ai/negotiator`. Tests
   * inject custom validators to exercise the fail-closed branch on
   * `severity: 'error'` findings (today's heuristic only emits warnings,
   * so the fail-closed branch never fires under the default validator).
   */
  readonly validator?: ContractValidator;
  /**
   * Override the UUID minter. Defaults to `() => \`bp_${randomUUID()}\``.
   * Tests inject a deterministic minter to assert id shape without
   * depending on `node:crypto` randomness. Only consulted on a fresh
   * registration — a dedup hit returns the existing row's id verbatim.
   */
  readonly mintId?: () => string;
}

/**
 * Register a blueprint into the scope.
 *
 * Identity: a fresh `(contractKey, variantKey)` mints an opaque
 * `bp_<uuid>` once and binds it in the {@link BlueprintIndex} under the
 * deterministic exact key. Dedup-on-first-registration: re-registering an
 * already-bound `(contractKey, variantKey)` returns the existing UUID+row
 * verbatim (first write wins — no re-mint, no metadata overwrite, no
 * hitCount reset). A dangling index binding (id present, row gone)
 * self-heals: the stale binding is dropped and registration proceeds as
 * a fresh mint.
 *
 * Validation: the contract is run through the structural validator
 * BEFORE any write. `severity: 'error'` findings short-circuit the
 * registration with {@link BlueprintRejectedError} — a bad shape never
 * enters the registry where future Tier 1/2 hits would re-serve it.
 * `severity: 'warn'` findings register normally but are surfaced on the
 * returned blueprint's `validationWarnings` so operators can see
 * "this entry had warnings at registration." Today's default validator
 * only emits warnings; the fail-closed branch is wired ahead of the
 * heuristic graduating findings to `'error'`.
 *
 * Eviction: when the (scope, kind) bucket is at capacity AND the new
 * key is NOT a re-write of an existing row, the lowest-hitCount entry
 * is deleted first. Ties break by oldest `createdAt`. Eviction needs an
 * `EnumerableVectorStore` to enumerate the bucket; a deployment that
 * wires a non-enumerable backend skips eviction and must bound the
 * bucket's growth itself.
 */
export async function registerBlueprint(
  deps: BlueprintRegistryDeps,
  scope: string,
  input: RegisterBlueprintInput,
  options: RegisterBlueprintOptions = {},
): Promise<Blueprint> {
  if (input.intent.trim().length === 0) {
    throw new Error('registerBlueprint: intent cannot be empty');
  }

  const validator = options.validator ?? validateContractRedundancy;
  const validation = validator(input.contract);
  const errorFindings = validation.findings.filter(
    (f) => f.severity === 'error',
  );
  if (errorFindings.length > 0) {
    throw new BlueprintRejectedError(errorFindings);
  }
  const warnFindings = validation.findings.filter(
    (f) => f.severity === 'warn',
  );

  const contractKey = blueprintKey(input.contract);
  const vKey = variantKey(input.variance);
  const exactKey = composeExactKey(input.kind, contractKey, vKey);

  // Dedup-on-first-registration: a bound (contractKey, variantKey) returns its
  // existing UUID+row verbatim (first write wins, no re-mint, no hitCount reset).
  const existingId = await deps.index.getId(scope, exactKey);
  if (existingId) {
    const existing = await findBlueprintByUuid(deps.vectorStore, scope, existingId);
    if (existing) return existing;
    // Dangling binding (id present, row gone) — self-heal: drop the stale
    // binding and fall through to mint a fresh row.
    await deps.index.deleteId(scope, exactKey);
  }

  const id = options.mintId?.() ?? `bp_${randomUUID()}`;
  const variance = input.variance ?? {};
  const createdAt = new Date().toISOString();

  // Authored source — only worth carrying when
  // distinct from componentCode (fallback-collapse symmetry: a
  // byte-identical pair is never worth persisting) AND a CodeStore is
  // bound (no store → no hash → honest absence, never a guess).
  const codeStore = deps.durability?.codeStore;
  const sourceCodeHash =
    input.sourceCode !== undefined &&
    input.sourceCode !== input.componentCode &&
    codeStore !== undefined
      ? codeStore.hashOf(input.sourceCode)
      : undefined;

  const blueprint: Blueprint = {
    id,
    kind: input.kind,
    contractKey,
    variantKey: vKey,
    variance,
    contract: input.contract,
    intent: input.intent.trim(),
    componentCode: input.componentCode,
    createdAt,
    hitCount: 0,
    source: input.source,
    ...(input.installed === true ? { installed: true } : {}),
    ...(warnFindings.length > 0
      ? { validationWarnings: warnFindings }
      : {}),
    ...(sourceCodeHash !== undefined
      ? { sourceCode: input.sourceCode, sourceCodeHash }
      : {}),
  };

  const cap = options.maxPerKind ?? DEFAULT_MAX_BLUEPRINTS_PER_KIND;
  await maybeEvictLowestHitBlueprint(deps, scope, input.kind, cap);

  const embeddingInput = composeEmbeddingInput(input.contract, input.intent);
  const vector = await deps.embedding.embed(embeddingInput);
  await deps.vectorStore.putVector(scope, {
    key: id,
    vector,
    metadata: blueprintToMetadata(blueprint),
  });
  await deps.index.putId(scope, exactKey, id);
  // Durable write-through for the fresh mint only. The dedup return
  // above skips it deliberately: that row was written through when it
  // was first minted, and re-writing it would fail the durable store's
  // already-exists guard on every cache hit.
  //
  // `scope` is the appId at every call site — the registry's tenancy
  // unit and the durable record's are the same thing.
  await writeBlueprintDurably(
    deps.durability,
    scope,
    blueprint,
    input.createdBy ?? 'agent',
  );
  return blueprint;
}

/**
 * If a fresh registration into (scope, kind) would push the bucket past
 * `cap`, delete the lowest-hitCount entry (oldest on ties). No-op when:
 *   - cap is Infinity (eviction disabled),
 *   - the bucket is below cap,
 *   - the vector store isn't enumerable (hosted-only path).
 *
 * Always called for a fresh mint — dedup is upstream now, so a
 * re-registration of an already-bound `(contractKey, variantKey)` never
 * reaches here (it returns the existing row before eviction). There is
 * therefore no re-write short-circuit: every call grows the bucket by one.
 *
 * After deleting the victim's vector, the victim's exact key is
 * reconstructed from its stored metadata (`kind` / `contractKey` /
 * `variantKey`) and dropped from the {@link BlueprintIndex} so the
 * binding doesn't dangle. Both deletes are best-effort — a failure
 * won't block the put. The cap is a soft ceiling; one over-cap state is
 * preferable to dropping a fresh registration.
 */
async function maybeEvictLowestHitBlueprint(
  deps: { vectorStore: VectorStore; index: BlueprintIndex },
  scope: string,
  kind: BlueprintKind,
  cap: number,
): Promise<void> {
  if (!Number.isFinite(cap)) return;
  const store = deps.vectorStore;
  if (!('listByScope' in store) || typeof store.listByScope !== 'function') {
    return;
  }
  const enumerable = store as EnumerableVectorStore;

  // Count-gate (ggui#540): when the index can answer the bucket size
  // cheaply, skip the O(scope) enumeration entirely while under cap.
  // exactKey is `${kind}:${contractKey}:${variantKey}`, so the kind
  // prefix counts exactly this bucket. The index may under-count
  // (bindings that skipped unbind on legacy evictions are the OVER-
  // count direction; an under-count comes from a lost binding) — one
  // put past the soft ceiling is the accepted cost, per the cap's
  // documented semantics above. Any failure falls through to the walk:
  // counting is an optimization, never a correctness gate.
  if (typeof deps.index.countIds === 'function') {
    try {
      const count = await deps.index.countIds(scope, `${kind}:`);
      if (count < cap) return;
    } catch {
      // Fall through to the enumeration below.
    }
  }
  let bucket: VectorRowSummary[];
  try {
    // Metadata-only walk (ggui#540) — ranking below reads kind /
    // hitCount / createdAt off metadata, never the embedding.
    const all = await enumerable.listByScope(scope);
    bucket = all.filter((entry) => {
      const k = readScalarString(entry.metadata[METADATA_KEYS.kind]);
      return k === kind;
    });
  } catch {
    return;
  }

  if (bucket.length < cap) return;

  // Pick the entry with the lowest hitCount; on ties pick the oldest
  // createdAt. This lines up with LRU-by-importance: rarely-used
  // blueprints go first, and when nothing has been hit yet, the
  // oldest cold entry leaves.
  let victim: VectorRowSummary | null = null;
  let victimHits = Number.POSITIVE_INFINITY;
  let victimCreated = '￿'; // Sorts after every realistic ISO string
  for (const entry of bucket) {
    const hits =
      readScalarNumber(entry.metadata[METADATA_KEYS.hitCount]) ?? 0;
    const created =
      readScalarString(entry.metadata[METADATA_KEYS.createdAt]) ?? '';
    if (hits < victimHits || (hits === victimHits && created < victimCreated)) {
      victim = entry;
      victimHits = hits;
      victimCreated = created;
    }
  }
  if (!victim) return;
  try {
    await store.deleteVector(scope, victim.key);
  } catch {
    // Eviction is best-effort — let the put proceed even if delete
    // raced with another writer.
  }
  // Drop the victim's index binding so it doesn't dangle. Reconstruct
  // the exact key from the victim's own metadata. A victim missing any
  // identity segment (legacy row) skips the unbind — composing a
  // defaulted key could delete a live sibling's binding, while a
  // genuinely dangling binding self-heals on the next exact lookup.
  const victimKind = readBlueprintKind(victim.metadata[METADATA_KEYS.kind]);
  const victimContractKey = readScalarString(
    victim.metadata[METADATA_KEYS.contractKey],
  );
  const victimVariantKey = readScalarString(
    victim.metadata[METADATA_KEYS.variantKey],
  );
  if (
    victimKind !== undefined &&
    victimContractKey !== undefined &&
    victimVariantKey !== undefined
  ) {
    try {
      await deps.index.deleteId(
        scope,
        composeExactKey(victimKind, victimContractKey, victimVariantKey),
      );
    } catch {
      // Best-effort — a failed index delete leaves a self-healing
      // dangling binding, which `findBlueprintExact` resolves to null.
    }
  }
}

/**
 * Tier 1 exact lookup — resolve the blueprint bound to `(kind,
 * contractKey, variantKey)` via the {@link BlueprintIndex}, or `null` if
 * none exists.
 *
 * `variantKey_` is optional (named with a trailing underscore so it does
 * not shadow the imported `variantKey` helper). Omitted → the
 * default-variant sentinel, so a contract-only lookup resolves the
 * default variant. The index resolves the deterministic exact key to the
 * row's UUID in one point-read; an index hit that points at a missing
 * row (a dangling binding) resolves to `null` rather than throwing — the
 * read site is one of the two self-heal points for stale bindings.
 */
export async function findBlueprintExact(
  deps: { vectorStore: VectorStore; index: BlueprintIndex },
  scope: string,
  kind: BlueprintKind,
  contractKey: string,
  variantKey_?: string,
): Promise<Blueprint | null> {
  const vKey = variantKey_ ?? variantKey(undefined); // optional → default-variant
  const exactKey = composeExactKey(kind, contractKey, vKey);
  const id = await deps.index.getId(scope, exactKey);
  if (!id) return null;
  return findBlueprintByUuid(deps.vectorStore, scope, id); // UUID-miss after index-hit → null, never throw
}

/**
 * Read the vector-store row at `(scope, id)` — the ONE keyed-read
 * ladder every registry point-read shares (ggui#527):
 *
 *   1. `getByKey` on a {@link KeyedVectorStore} — O(1), the backend's
 *      own point-read (S3 Vectors `GetVectors`, sqlite PK, in-memory
 *      map). ALWAYS preferred.
 *   2. `listByScope` + find on an {@link EnumerableVectorStore} — the
 *      pre-#527 default. On the S3 Vectors adapter this is a whole-
 *      INDEX walk with `returnData` (every app's float32 vectors,
 *      deserialized on the main thread): 500–970 ms event-loop stall
 *      bursts on every cache-hit render, long enough for nginx to see
 *      the upstream reset and answer 502. Reached now only by a
 *      backend that enumerates but cannot point-read.
 *   3. zero-vector `query` + scan on a backend with neither.
 *
 * Returns the raw entry. Only rung 1 carries the embedding
 * (`VectorEntry`); rungs 2 and 3 are vectorless (`VectorRowSummary` /
 * `VectorSearchResult` — enumeration is metadata-only per ggui#540, and
 * a query result never carried one). Callers that need the vector on a
 * vectorless rung fall back to re-embedding.
 */
async function readRegistryRow(
  store: VectorStore,
  scope: string,
  id: string,
): Promise<VectorEntry | VectorRowSummary | VectorSearchResult | null> {
  if ('getByKey' in store && typeof store.getByKey === 'function') {
    return (store as KeyedVectorStore).getByKey(scope, id);
  }
  if ('listByScope' in store && typeof store.listByScope === 'function') {
    const entries = await (store as EnumerableVectorStore).listByScope(scope);
    return entries.find((e) => e.key === id) ?? null;
  }
  const dummy = new Array<number>(1).fill(0);
  const results = await store.query(scope, dummy, 1000);
  return results.find((r) => r.key === id) ?? null;
}

/**
 * Point-read a blueprint by its vector-store key (id) within `scope`,
 * or `null` when absent — {@link readRegistryRow} projected onto the
 * blueprint shape.
 *
 * Distinct from `findBlueprintExact`, which resolves a `(kind,
 * contractKey)` lookup to the synthetic key first. This reads straight
 * by id — the shape the render-time point-read needs once the index
 * resolves `(scope, exactKey) → id`.
 */
async function findBlueprintByUuid(
  store: VectorStore,
  scope: string,
  id: string,
): Promise<Blueprint | null> {
  const row = await readRegistryRow(store, scope, id);
  return row ? rowToBlueprint(row.key, row.metadata) : null;
}

/**
 * Public point-read wrapper — resolve a blueprint by its id within
 * `scope`, or `null` when absent. The render-time point-read path (the
 * next wave, once the index resolves `(scope, exactKey) → id`) uses this
 * to fetch the matched row without a contract re-hash.
 */
export async function readBlueprintById(
  deps: { vectorStore: VectorStore },
  scope: string,
  id: string,
): Promise<Blueprint | null> {
  return findBlueprintByUuid(deps.vectorStore, scope, id);
}

/**
 * Tier 2 retrieval — return the top-K blueprints whose embedding is
 * closest to the embedded `(intent, contract)` query.
 *
 * Filters by `kind` after the cosine sort; today only `'template'`
 * blueprints exist, but the filter future-proofs the call for
 * smaller-grain kinds.
 *
 * Returned blueprints carry `_cosine` on the result tuple so the
 * caller can hand it to the LLM rerank judge as a retrieval-score
 * hint.
 */
export interface BlueprintCandidate {
  readonly blueprint: Blueprint;
  readonly cosine: number;
}

export async function findBlueprintsByEmbedding(
  deps: BlueprintRegistryDeps,
  scope: string,
  query: { readonly intent: string; readonly contract?: DataContract },
  options: { readonly kind?: BlueprintKind; readonly topK?: number } = {},
): Promise<readonly BlueprintCandidate[]> {
  const topK = options.topK ?? 20;
  const embeddingInput = composeEmbeddingInput(query.contract, query.intent);
  const vector = await deps.embedding.embed(embeddingInput);
  const results = await deps.vectorStore.query(scope, vector, topK);
  const out: BlueprintCandidate[] = [];
  for (const result of results) {
    const blueprint = rowToBlueprint(result.key, result.metadata);
    if (!blueprint) continue;
    if (options.kind !== undefined && blueprint.kind !== options.kind) continue;
    out.push({ blueprint, cosine: result.score });
  }
  return out;
}

/**
 * Enumerate every blueprint in `scope`, optionally filtered by
 * `kind`. Used by the devtool registry view and by Tier 1 lookup on
 * enumerable backends. Requires an {@link EnumerableVectorStore}.
 */
export async function listBlueprints(
  deps: { vectorStore: EnumerableVectorStore },
  scope: string,
  kind?: BlueprintKind,
): Promise<readonly Blueprint[]> {
  const entries = await deps.vectorStore.listByScope(scope);
  const out: Blueprint[] = [];
  for (const entry of entries) {
    const blueprint = rowToBlueprint(entry.key, entry.metadata);
    if (!blueprint) continue;
    if (kind !== undefined && blueprint.kind !== kind) continue;
    out.push(blueprint);
  }
  return out;
}

/**
 * Bump `hitCount` + `lastHitAt` on a blueprint. Operator metric for
 * the devtool ("which blueprints are hot?"). Writes happen on the
 * registry-hit code path — accepted as one extra `putVector` per
 * Tier 1 / Tier 2 hit.
 */
export async function recordBlueprintHit(
  deps: { vectorStore: VectorStore } & Partial<BlueprintRegistryDeps>,
  scope: string,
  id: string,
): Promise<void> {
  // We need the existing entry to update it — the shared keyed-read
  // ladder (`getByKey` → `listByScope` → zero-vector query). This
  // runs on EVERY cache hit, so it MUST take the point-read rung on a
  // keyed backend (ggui#527: the enumerate rung on S3 Vectors was a
  // whole-index walk per hit).
  const store = deps.vectorStore;
  const existing = await readRegistryRow(store, scope, id);
  if (!existing) return;
  // Re-write the entry with bumped counters. Reuse the existing
  // vector when rung 1 (`getByKey`) supplied it — it's already correct
  // for the canonical embedding input, and re-embedding would burn an
  // unnecessary round-trip. Rungs 2 and 3 are vectorless (enumeration
  // is metadata-only per ggui#540; a query result never carried one),
  // so re-embedding is the only path there. Every in-repo backend is
  // keyed (#527), so the vectorless rungs are the exotic-backend slow
  // case, not a path OSS or the pod takes.
  const vector = 'vector' in existing ? existing.vector : await reembed(deps, existing.metadata);
  if (!vector) return; // re-embed failed silently — drop the hit-count update
  const nextHitCount =
    (readScalarNumber(existing.metadata[METADATA_KEYS.hitCount]) ?? 0) + 1;
  await store.putVector(scope, {
    key: id,
    vector,
    metadata: {
      ...existing.metadata,
      [METADATA_KEYS.hitCount]: nextHitCount,
      [METADATA_KEYS.lastHitAt]: new Date().toISOString(),
    },
  });
}

async function reembed(
  deps: Partial<BlueprintRegistryDeps>,
  metadata: Record<string, string | number | boolean | null>,
): Promise<number[] | null> {
  if (!deps.embedding) return null;
  const intent = readScalarString(metadata[METADATA_KEYS.intent]);
  const contractStr = readScalarString(metadata[METADATA_KEYS.contract]);
  if (intent === undefined || contractStr === undefined) return null;
  let contract: DataContract;
  try {
    contract = JSON.parse(contractStr) as DataContract;
  } catch {
    return null;
  }
  const input = composeEmbeddingInput(contract, intent);
  return deps.embedding.embed(input);
}

/**
 * Delete a blueprint by id. Idempotent — deleting a missing key is a
 * no-op (matches `VectorStore.deleteVector` contract).
 *
 * Reads the row first so the `(kind, contractKey, variantKey)` exact key
 * can be reconstructed and dropped from the {@link BlueprintIndex}; the
 * index drop is best-effort (a missing row / failed delete leaves a
 * self-healing dangling binding, never an error).
 */
export async function deleteBlueprint(
  deps: { vectorStore: VectorStore; index: BlueprintIndex },
  scope: string,
  id: string,
): Promise<void> {
  const existing = await findBlueprintByUuid(deps.vectorStore, scope, id);
  await deps.vectorStore.deleteVector(scope, id);
  if (existing) {
    try {
      await deps.index.deleteId(
        scope,
        composeExactKey(existing.kind, existing.contractKey, existing.variantKey),
      );
    } catch {
      // Best-effort — a dangling binding self-heals at the read site.
    }
  }
}
