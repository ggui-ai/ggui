/**
 * Shared handshake-decision core — ONE negotiation pipeline, adapter-injected.
 *
 * Every host drives the same `decideHandshake` function — the server in
 * `@ggui-ai/mcp-server` and any deployment's own host alike; they differ
 * ONLY in the {@link HandshakeDecisionAdapter} they inject. The adapter
 * abstracts every seam that varies between deployments — the LLM (a
 * per-request provider key, or a deployment's fixed caller), the
 * blueprint pools to search (a local vector store or a hosted one; one
 * per-app pool, or a per-app pool plus shared catalogs), an optional
 * deployment-specific pre-match (a curated catalog consulted first), and
 * an operator-visible warn sink.
 *
 * ## Decision spine (identical for every deployment)
 *
 *   1. **Pre-match** (optional adapter hook) — a deployment-specific
 *      deterministic match that wins over everything else — e.g. a
 *      curated catalog consulted first (dataTools ⊆ sourceTools). The
 *      server this package ships omits it. A returned result short-circuits.
 *   2. **Find-similar across pools** — for each declared pool, in order,
 *      run {@link matchBlueprint} (exact-key → cosine gate → judge). An
 *      `exact-key` hit (free, canonical-key equality) in ANY pool wins
 *      immediately. Otherwise the best `semantic` hit across all pools is
 *      reused ATOMICALLY (the cached blueprint's own contract +
 *      componentCode, never the agent's draft under cached code) — the
 *      tiebreak prefers a fully-covering hit over a gapped one, then
 *      higher judgeConfidence. A coverage gap is informational: the reuse
 *      carries `COVERAGE_GAP` warn findings naming the surfaces the cached
 *      UI lacks, and the agent override is the safety valve.
 *   3. **Create** — no reusable match: the agent's DRAFT is the basis.
 *      `ensureConformingContract` validates + repairs it via the bounded
 *      LLM loop, guaranteeing a contract the handshake backstop accepts.
 *      No LLM available ⇒ a deterministic no-repair create fallback.
 *
 * ## Failure posture
 *
 * Operational errors (registry hiccup, provider 5xx, pre-match backend
 * flap) fail open: the offending tier is skipped (warned) and the next
 * tier runs — the handshake NEVER hard-fails on a malformed draft or a
 * transient backend. Programmer errors (TypeError / ReferenceError /
 * RangeError / SyntaxError) re-throw so real bugs surface.
 */

import { createHash } from 'node:crypto';
import {
  dataContractSchema,
  lintContract,
  summarizeContract,
  type BlueprintSource,
  type BlueprintVariance,
  type DataContract,
  type HandshakeSuggestion,
  type SuggestionFinding,
} from '@ggui-ai/protocol';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import {
  ensureConformingContract,
  normalizeDraft,
  type LLMCaller,
} from '@ggui-ai/negotiator';
import type { HandlerContext } from '../types.js';
import {
  matchBlueprint,
  type BlueprintMatchHit,
  type BlueprintMatchResult,
  type MatchBlueprintDeps,
} from './blueprint-matcher.js';
import type { CoverageGap } from './blueprint-coverage.js';
import { isFulfillable } from './blueprint-fulfillability.js';
import type { BlueprintRegistryDeps } from './blueprint-registry.js';
import type {
  HandshakeNegotiator,
  HandshakeNegotiatorResult,
} from './handshake.js';
import { buildDeclined, buildSalvagedOrDeclined } from './handshake-fallbacks.js';
import type { InstalledBlueprintsProvider } from './installed-blueprints-provider.js';
import { emitAgentCaps } from './agentcaps-measurement.js';
import {
  canonicalizeToolIdentity,
  type ToolIdentityCatalog,
} from './canonicalize-tool-identity.js';

/**
 * One blueprint pool to search for a reusable match. A pool is a
 * `(registry, scope)` pair — the registry (embedding + vectorStore)
 * backing it, and the scope partition (an app, a shared catalog) to query
 * within it.
 *
 * Modeling pools as an array is the adapter-first generalization: the
 * server this package ships declares a single per-app pool; a deployment
 * may declare the per-app pool plus shared catalogs (and more partitions
 * later) — the same core fans out over whatever the deployment provides,
 * no `includeSharedPool` boolean special-case.
 */
export interface BlueprintPool {
  /** Registry (embedding + vectorStore) backing this pool. */
  readonly registry: BlueprintRegistryDeps;
  /**
   * Scope partition to query within the registry. Defaults to the
   * request's `ctx.appId` (the per-app pool) when omitted; a deployment
   * may use e.g. `'shared'` for a catalog every app can match against.
   */
  readonly scope?: string;
  /**
   * Optional marketplace-install bridge wired into THIS pool's store.
   * The matcher calls `ensureCached(scope)` before querying so installed
   * blueprints lazily compile + populate the same store the matcher
   * reads. Naturally per-pool — it populates one scope.
   */
  readonly installedBlueprints?: InstalledBlueprintsProvider;
  /** Optional human label for warn/trace lines. */
  readonly label?: string;
}

/**
 * The deployment-specific seams `decideHandshake` injects. Everything
 * that differs between deployments lives behind this interface; the
 * decision spine in {@link decideHandshake} is deployment-agnostic.
 */
export interface HandshakeDecisionAdapter {
  /**
   * Resolve the LLM for this request — the find-similar judge AND the
   * synth-repair loop both use it. Returns `undefined` when no LLM is
   * available (e.g. no BYOK creds resolved); the core then returns a
   * deterministic no-repair create fallback. The server this package ships
   * wraps a per-`ctx` provider-key resolver; a deployment may return a
   * fixed caller.
   */
  resolveLlm(
    ctx: HandlerContext,
  ): Promise<LLMCaller | undefined> | LLMCaller | undefined;
  /**
   * Ordered list of blueprint pools to search. Empty / absent ⇒ the
   * find-similar probe is skipped entirely (synth-only). Searched in
   * order: an `exact-key` hit in any pool wins immediately; otherwise the
   * highest-confidence `semantic` hit across pools is reused. Empty pools
   * are cheap (no RAG candidates ⇒ judge skipped).
   */
  readonly pools?: readonly BlueprintPool[];

  /**
   * Per-request reuse policy (ggui#607). `'exact-only'` disables the
   * semantic (RAG + judge) strategy for this request — exact-key
   * canonical matches still reuse; everything else regenerates. For
   * callers whose surfaces must be presentation-stable (byte-identical
   * requests → the identical cached surface; paraphrases → fresh
   * generation): a SIMILAR cached surface is exactly what a
   * stability-sensitive deployment cannot afford. Absent ⇒ `'full'`.
   * Resolved once per decision, before the pool loop.
   */
  readonly reuseMode?: (
    ctx: HandlerContext,
  ) => Promise<'full' | 'exact-only'> | 'full' | 'exact-only';
  /**
   * Optional deployment-specific pre-match, run BEFORE the find-similar
   * probe so a curated / byte-exact hit wins over everything — e.g. a
   * deployment with a curated catalog consults it here. Return a result to short-circuit;
   * return `undefined` to fall through to the shared probe.
   */
  preMatch?(input: {
    readonly declaredAgentTools: readonly string[];
    readonly intent: string;
    readonly ctx: HandlerContext;
  }):
    | Promise<HandshakeNegotiatorResult | undefined>
    | HandshakeNegotiatorResult
    | undefined;
  /**
   * Operator-visible sink for swallowed operational errors (pool probe
   * hiccup, pre-match backend flap). The server this package ships passes
   * `console.warn`; a deployment may pass its structured logger. Absent ⇒
   * silent.
   */
  warn?(message: string): void;
  /**
   * Optional observer for every blueprint-match OUTCOME (hit or miss),
   * called once per pool probed in the Tier-1 find-similar loop.
   * Non-error, non-blocking — purely for cache-hit-ratio observability.
   * Absent ⇒ no-op. This package ships no default observer; a host MAY wire
   * this to its own structured logger. Enforced non-blocking: a
   * throwing observer is caught, reported via `warn` if present, and
   * never breaks the handshake.
   */
  onBlueprintMatch?(input: {
    readonly pool: string;
    readonly scope: string;
    readonly result: BlueprintMatchResult;
  }): void;
  /** Optional per-app tool-identity catalog (bare tool → canonical serverInfo).
   *  Present ⇒ run the canonicalization step before keying (Tier 1); absent ⇒
   *  no-op (Tier 2). Resolved by ctx.appId. */
  readonly toolIdentityCatalog?: (
    ctx: HandlerContext,
  ) => Promise<ToolIdentityCatalog | undefined> | ToolIdentityCatalog | undefined;
}

/** Decide-input shape — derived from the negotiator contract (single source of truth). */
export type HandshakeDecideInput = Parameters<HandshakeNegotiator['decide']>[0];

/** Operational vs programmer-error classifier — bugs re-throw, ops fail open. */
function isOperationalError(err: unknown): boolean {
  if (err instanceof TypeError) return false;
  if (err instanceof ReferenceError) return false;
  if (err instanceof RangeError) return false;
  if (err instanceof SyntaxError) return false;
  return true;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stable code for the COVERAGE_GAP warn findings appended on a gapped reuse. */
const COVERAGE_GAP_CODE = 'COVERAGE_GAP';

/** True iff the coverage gap names any surface the cached UI lacks. */
function coverageHasGap(gap: CoverageGap): boolean {
  return (
    gap.actions.length > 0 ||
    gap.props.length > 0 ||
    gap.context.length > 0 ||
    gap.streams.length > 0 ||
    gap.gadgets.length > 0
  );
}

/**
 * Project a coverage gap into `severity:'warn'` validation findings — one
 * per missing surface — so the agent sees exactly what the proposed cached
 * UI lacks before accepting. Empty gap ⇒ no findings. Reuses the
 * `validationFindings` channel; introduces no new wire field.
 *
 * The message steers DEFAULT-ACCEPT: reuse-and-refine is the priority, and
 * override is the conditional exception (only when the user must directly
 * see or act on the missing surface). For a PROP gap ONLY, the finding also
 * notes whether the missing prop was required or optional in the agent's
 * `request` draft — that required/optional signal is exactly what tells the
 * agent whether overriding is warranted. `PropEntry.required` is the only
 * per-entry boolean of its kind; actions / context / streams / gadgets have
 * no such concept, so their messages carry no annotation.
 */
function coverageGapFindings(
  gap: CoverageGap,
  request: DataContract,
): SuggestionFinding[] {
  const findings: SuggestionFinding[] = [];
  const push = (kind: keyof CoverageGap, path: string): void => {
    for (const name of gap[kind]) {
      const annotation =
        kind === 'props'
          ? request.propsSpec?.properties?.[name]?.required === true
            ? ' (required in your draft)'
            : ' (optional in your draft)'
          : '';
      findings.push({
        code: COVERAGE_GAP_CODE,
        severity: 'warn',
        path: `${path}.${name}`,
        message: `the proposed cached UI does not declare ${kind} '${name}'${annotation} that your draft requests. Default to ACCEPT (reuse-and-refine) — override only if the user must directly see or act on this surface, since the cached UI cannot show it.`,
      });
    }
  };
  push('actions', 'actionSpec');
  push('props', 'propsSpec.properties');
  push('context', 'contextSpec');
  push('streams', 'streamSpec');
  push('gadgets', 'gadgets');
  return findings;
}

/** Stable code for the VARIANCE_GAP warn finding on a variance-divergent reuse. */
const VARIANCE_GAP_CODE = 'VARIANCE_GAP';

/**
 * Bounded, readable projection of a variance block for the VARIANCE_GAP
 * message. NEVER `JSON.stringify` the whole block: `context` (a free-form
 * `JsonObject`) and `seedPrompt` (an arbitrary-length string) are unbounded
 * and would bloat every variance-gap handshake response (`SuggestionFinding`
 * carries no maxLength). Only the short tags (`persona`, `aesthetic`) are
 * inlined; the unbounded fields collapse to a `<set>` presence marker.
 */
function summarizeVariance(v: BlueprintVariance | undefined): string {
  if (!v || Object.keys(v).length === 0) return '(default)';
  const parts: string[] = [];
  if (v.persona) parts.push(`persona:${JSON.stringify(v.persona)}`);
  if (v.aesthetic) parts.push(`aesthetic:${JSON.stringify(v.aesthetic)}`);
  if (v.context !== undefined) parts.push('context:<set>');
  if (v.seedPrompt !== undefined) parts.push('seedPrompt:<set>');
  return parts.join(', ') || '(default)';
}

/**
 * Project a variance delta into a single `severity:'warn'` validation
 * finding — emitted ONLY when the proposed (matched-blueprint) variance
 * differs from the request variance. Mirrors {@link coverageGapFindings}:
 * same `validationFindings` channel, no new wire field, default-ACCEPT
 * steer (reuse-and-refine is the priority; override only when the variance
 * difference must change what is generated).
 *
 * Equivalence is decided on {@link variantKey} (self-normalizing per D9),
 * so `undefined` / `{}` / `{persona:''}` and any all-empty variance never
 * false-flag against one another. Returns `[]` when the two variances are
 * variantKey-equal.
 */
function varianceGapFindings(
  requestVariance: BlueprintVariance | undefined,
  proposedVariance: BlueprintVariance | undefined,
): SuggestionFinding[] {
  if (variantKey(requestVariance) === variantKey(proposedVariance)) return [];
  return [
    {
      code: VARIANCE_GAP_CODE,
      severity: 'warn',
      path: 'variance',
      message: `the proposed cached UI was built for variance ${summarizeVariance(
        proposedVariance,
      )}; you requested ${summarizeVariance(
        requestVariance,
      )}. Default to ACCEPT (reuse-and-refine) — override the variance only if the difference must change what is generated.`,
    },
  ];
}

/**
 * Build the `origin: 'cache'` reuse result from a matched blueprint —
 * ATOMIC: the cached blueprint's OWN contract + componentCode are reused
 * together (never the agent's draft under cached code), so the served UI
 * always matches the served contract. Shared by the exact-key and
 * semantic match branches. Pure / deterministic (sha256 only).
 */
export function buildCacheReuseResult(
  blueprint: {
    readonly id: string;
    readonly contractKey: string;
    readonly variantKey: string;
    readonly componentCode: string;
    readonly contract: DataContract;
    readonly variance: BlueprintVariance;
    readonly source: BlueprintSource;
  },
  reason: string,
  /**
   * The matcher's measured retrieval cosine — `1` from the exact-key
   * tier, the real embedding similarity from the semantic tier. Rides
   * `matchedBlueprint.cosine` so the paired render reports it on the
   * wire's `cacheHit.similarity` (ggui#564).
   */
  matchCosine: number,
): HandshakeNegotiatorResult {
  const codeHash = createHash('sha256')
    .update(blueprint.componentCode)
    .digest('hex');
  const suggestion: HandshakeSuggestion = {
    origin: 'cache',
    rationale: reason,
    // blueprintId is set ONLY on cache reuse — it is the durable UUID
    // minted at the blueprint's first render-time registration. Create /
    // synth / agent decisions omit it (the UUID does not exist yet).
    blueprintMeta: {
      blueprintId: blueprint.id,
      contractHash: blueprint.contractKey,
      codeHash,
      // The MATCHED blueprint's own stored provenance — cache-only on
      // BlueprintMeta (same presence rule as codeHash). Never a
      // deployment-level slug: the cached code may be engine-generated,
      // operator-registered, or curated, and only the row knows which.
      source: blueprint.source,
      // The MATCHED blueprint's own variance — what the cached UI carries,
      // surfaced so the agent sees the proposed variance before accepting
      // (D5). Required on Blueprint (rowToBlueprint resolves a malformed
      // stored blob to {}), so no coalesce here.
      variance: blueprint.variance,
      selectedReason: reason,
    },
    proposedContractSummary: summarizeContract(blueprint.contract),
  };
  return {
    action: 'reuse',
    reason,
    suggestion,
    effectiveContract: blueprint.contract,
    // Matched-ref for the paired render's §6 point-read.
    matchedBlueprint: {
      id: blueprint.id,
      contractKey: blueprint.contractKey,
      variantKey: blueprint.variantKey,
      cosine: matchCosine,
    },
  };
}

/**
 * Deterministic no-LLM create fallback (no LLM resolved, or an
 * operational error during synth). The handshake backstop
 * (`validateContract`) THROWS on a malformed draft and there is no LLM
 * here to repair it — so deterministically keep the conforming SUBSET
 * of the draft (+ one finding per dropped entry), or DECLINE when
 * nothing survives; never the empty contract (ggui#523 item 3). NEVER
 * return a raw malformed draft into the throwing backstop. A clean
 * draft is kept verbatim (`origin: 'agent'`).
 */
export function buildCreateFallback(
  draftContract: unknown,
  reason: string,
  requestVariance?: BlueprintVariance,
): HandshakeNegotiatorResult {
  const lint = lintContract(draftContract);
  if (lint.errors.length === 0) {
    // Clean draft: kept verbatim (origin agent), exactly as before.
    const contract: DataContract = dataContractSchema.parse(draftContract);
    const suggestion: HandshakeSuggestion = {
      origin: 'agent',
      rationale: reason,
      // No blueprintId, no source — the durable UUID and the real
      // provenance are both minted at render-time registration, never at
      // handshake. Absent on agent/synth (D4).
      blueprintMeta: {
        contractHash: blueprintKey(contract),
        // The REQUEST variance — this contract was built for the request, so
        // the proposed variance is the request's. `?? {}` keeps the
        // no-variance default (D5).
        variance: requestVariance ?? {},
      },
      proposedContractSummary: summarizeContract(contract),
    };
    return {
      action: 'create',
      reason,
      suggestion,
      effectiveContract: contract,
    };
  }
  // Dirty draft, no LLM to repair it: keep the conforming subset, or
  // decline. Never the empty contract (ggui#523 item 3).
  return buildSalvagedOrDeclined({
    draftContract,
    reason,
    ...(requestVariance !== undefined ? { variance: requestVariance } : {}),
  });
}

/**
 * Decide a handshake — the shared core. See the module docstring for the
 * decision spine. Pure orchestration over the injected adapter; never
 * throws on a malformed draft or transient backend.
 */
export async function decideHandshake(
  adapter: HandshakeDecisionAdapter,
  input: HandshakeDecideInput,
): Promise<HandshakeNegotiatorResult> {
  const { intent, blueprintDraft, gadgets, ctx } = input;
  // The agent's draft contract (untrusted). Reassigned in place to the
  // canonicalized contract by the Slice-2 step below so the create / repair
  // path (ensureConformingContract + buildCreateFallback) hashes the same
  // canonical identity the match probe reads.
  let draftContract = blueprintDraft.contract;
  // Request variance (persona / aesthetic / context / seedPrompt) is a
  // sibling of the draft contract — it keys the matcher's exact-key lookup
  // (`variantKey`) so a same-contract-different-persona request misses the
  // cached UI rather than reusing it.
  const variance: BlueprintVariance | undefined = blueprintDraft.variance;
  // Draft is UNTRUSTED (forgiving handshake — may be malformed). Parse
  // once up front: the find-similar tiers need a valid DataContract; a
  // malformed draft skips them and falls straight to validate/repair.
  //
  // FALLBACK-NORMALIZE (only-on-failure, load-bearing): when the RAW
  // parse fails, retry on the DETERMINISTICALLY-normalized draft. Most
  // LLM drafts carry mechanical-only quirks (Gemini uppercase 'OBJECT'
  // types, 'TYPE|null' pipe-unions, a stray propsSpec.required array) that
  // `normalizeDraft` fixes without an LLM. Without this, a quirky-but-
  // matchable draft skips the find-similar block entirely and cold-gens
  // every turn. The retry is gated ON FAILURE so a CLEAN draft keeps
  // parsing verbatim: its match key (`blueprintKey(draft)`) must stay
  // identical to the key Tier-2 create registers it under (the verbatim
  // fast-path in ensureConformingContract). A quirky-but-normalizable
  // draft instead matches on `blueprintKey(normalizeDraft(draft))`, which
  // equals the key its OWN first-time create registers under (the
  // deterministic `method:'normalized'` tier) — so create-then-reuse line
  // up. Always-normalizing would break that key consistency.
  let parsedDraft = dataContractSchema.safeParse(draftContract);
  if (!parsedDraft.success) {
    const normalizedParse = dataContractSchema.safeParse(
      normalizeDraft(draftContract),
    );
    if (normalizedParse.success) parsedDraft = normalizedParse;
  }

  // Measurement (dev/CI only; default off). Record what the agent authored for
  // each tool's serverInfo.name — the empirical read on whether the config-key
  // nudge stops fabrication. Pure side-effect; never affects the decision.
  if (parsedDraft.success) {
    emitAgentCaps(parsedDraft.data, {
      enabled: process.env['GGUI_AGENTCAPS_STDERR'] === '1',
    });
  }

  // Slice 2 — tool identity canonicalization. Resolve each tool's serverInfo.name
  // to its canonical (initialize) value BEFORE keying, so reuse is framework-
  // invariant. No-op when no catalog is declared (Tier 2). The canonical name
  // lands in the contract that gets hashed → portable hash preserved.
  if (parsedDraft.success && adapter.toolIdentityCatalog) {
    const catalog = await adapter.toolIdentityCatalog(ctx);
    if (catalog) {
      const canonical = canonicalizeToolIdentity(parsedDraft.data, catalog);
      // Re-parse keeps `parsedDraft` a real SafeParseSuccess (the
      // canonicalized contract is still schema-valid) — no hand-built
      // discriminated union, no cast. Thread the canonical contract onto
      // the create / repair basis too so it hashes the same identity the
      // match probe reads.
      parsedDraft = dataContractSchema.safeParse(canonical);
      draftContract = canonical;
      // EFFECTIVE measurement (dev/CI only; default off). The authored line
      // above measured the PRE-canonicalization serverInfo (fabrication read);
      // this SECOND line measures the EFFECTIVE serverInfo AFTER the rewrite —
      // making canonicalization observable in the container. Only emitted when
      // canonicalization actually ran (a catalog resolved), so an effective
      // line whose name is the canonical `initialize` value is direct evidence
      // the step fired. Pure side-effect; never affects the decision.
      if (parsedDraft.success) {
        emitAgentCaps(parsedDraft.data, {
          enabled: process.env['GGUI_AGENTCAPS_STDERR'] === '1',
          phase: 'effective',
        });
      }
    }
  }

  // Tier 0 — deployment-specific pre-match (e.g. a curated catalog).
  // Runs first so a curated / byte-exact hit wins over find-similar.
  if (adapter.preMatch) {
    const declaredAgentTools = parsedDraft.success
      ? Object.keys(parsedDraft.data.agentCapabilities?.tools ?? {})
      : [];
    try {
      const pre = await adapter.preMatch({ declaredAgentTools, intent, ctx });
      if (pre) return pre;
    } catch (err) {
      if (!isOperationalError(err)) throw err;
      adapter.warn?.(
        `[decideHandshake] preMatch failed; falling through to find-similar: ${errMessage(err)}`,
      );
    }
  }

  // Resolve the LLM ONCE, before the find-similar probe — the semantic
  // judge needs it at handshake time (parity with the render path), and
  // the synth/repair create path reuses it.
  const llm = await adapter.resolveLlm(ctx);

  // ggui#607 — resolve the reuse policy once; 'exact-only' threads
  // disableSemantic into every pool probe below.
  const reuseMode = adapter.reuseMode ? await adapter.reuseMode(ctx) : 'full';

  // Tier 1 — find-similar across pools (exact-key free + semantic
  // find+judge). Reuse the cached blueprint ATOMICALLY; a coverage gap is
  // informational (surfaced as COVERAGE_GAP warn findings, not a drop).
  if (adapter.pools && adapter.pools.length > 0 && parsedDraft.success) {
    // The requesting agent's declared MCP tools (a set keyed by bare
    // toolName) — the basis for the reuse fulfillability gate. A cached
    // blueprint is only proposed for reuse when these SUPERSET the
    // blueprint's required tools AND keep its recorded input schemas
    // satisfiable (see {@link isFulfillable}).
    const agentCaps = parsedDraft.data.agentCapabilities?.tools;
    const semanticHits: BlueprintMatchHit[] = [];
    for (const pool of adapter.pools) {
      const scope = pool.scope ?? ctx.appId;
      try {
        const matchDeps: MatchBlueprintDeps = {
          registry: pool.registry,
          ...(llm ? { llm } : {}),
          ...(pool.installedBlueprints
            ? { installedBlueprints: pool.installedBlueprints }
            : {}),
        };
        const matchResult = await matchBlueprint(
          matchDeps,
          scope,
          {
            intent,
            contract: parsedDraft.data,
            ...(variance !== undefined ? { variance } : {}),
          },
          ...(reuseMode === 'exact-only'
            ? [{ disableSemantic: true } as const]
            : []),
        );
        // Isolated in its OWN try/catch, separate from the outer
        // pool-probe catch below: onBlueprintMatch's contract promises
        // non-blocking observation, so a throwing observer must never
        // lose an otherwise-successful matchResult (falling into the
        // outer catch would either rethrow a non-operational error or
        // misreport "matchBlueprint probe failed" for a probe that
        // actually succeeded). Observer failures are surfaced via warn
        // and the request proceeds — never rethrown.
        try {
          adapter.onBlueprintMatch?.({
            pool: pool.label ?? scope,
            scope,
            result: matchResult,
          });
        } catch (err) {
          adapter.warn?.(
            `[decideHandshake] onBlueprintMatch observer threw for pool ${pool.label ?? scope}; ignoring: ${errMessage(err)}`,
          );
        }
        // exact-key is a perfect canonical match — it wins immediately over
        // any semantic hit from any pool, but ONLY when the requesting agent
        // can fulfill it: its declared tools must superset the blueprint's
        // required tools and keep the recorded input schemas satisfiable.
        // An unfulfillable candidate is declined (the cached UI's actions /
        // channels would dead-end against tools the agent cannot call) — fall
        // through to the next pool / semantic accumulation / create.
        if (
          matchResult.strategy === 'exact-key' &&
          isFulfillable(matchResult.blueprint.contract, agentCaps).ok
        ) {
          return buildCacheReuseResult(
            matchResult.blueprint,
            matchResult.reason,
            // Exact-key = canonical-contract identity — cosine 1 by
            // definition (the matcher hard-sets it; no retrieval ran).
            1,
          );
        }
        if (
          matchResult.strategy === 'semantic' &&
          isFulfillable(matchResult.blueprint.contract, agentCaps).ok
        ) {
          semanticHits.push(matchResult);
        }
      } catch (err) {
        if (!isOperationalError(err)) throw err;
        // Pool hiccup — warn + try the next pool / fall through to synth.
        adapter.warn?.(
          `[decideHandshake] matchBlueprint probe failed for pool ${pool.label ?? scope}; falling through: ${errMessage(err)}`,
        );
      }
    }
    if (semanticHits.length > 0) {
      // No exact-key anywhere → reuse the best semantic hit across pools
      // (each pool's judge ran in its own candidate context). Tiebreak:
      // prefer a FULLY-COVERING hit over a gapped one (an exact surface
      // match is worth more than a higher-confidence partial), then break
      // ties on judgeConfidence.
      const best = semanticHits.reduce((a, b) => {
        const aGap = coverageHasGap(a.coverage);
        const bGap = coverageHasGap(b.coverage);
        if (aGap !== bGap) return aGap ? b : a; // empty-gap wins
        return (b.judgeConfidence ?? 0) > (a.judgeConfidence ?? 0) ? b : a;
      });
      const reuse = buildCacheReuseResult(best.blueprint, best.reason, best.cosine);
      // A gapped reuse carries COVERAGE_GAP warn findings so the agent sees
      // what the cached UI lacks before accepting; a variance-divergent
      // reuse additionally carries a VARIANCE_GAP warn finding so the agent
      // sees the proposed variance differs from the request (both reuse the
      // existing validationFindings channel — no new wire field). A single
      // reuse can carry BOTH.
      const extraFindings = [
        ...coverageGapFindings(best.coverage, parsedDraft.data),
        ...varianceGapFindings(variance, best.blueprint.variance),
      ];
      if (extraFindings.length === 0) return reuse;
      return {
        ...reuse,
        suggestion: {
          ...reuse.suggestion,
          validationFindings: [
            ...(reuse.suggestion.validationFindings ?? []),
            ...extraFindings,
          ],
        },
      };
    }
  }

  // No LLM → deterministic no-repair create fallback.
  if (!llm) {
    return buildCreateFallback(
      draftContract,
      'no-creds: no LLM available for the configured provider; ggui_render will surface the same error and the handshake stays a no-op create.',
      variance,
    );
  }

  // Tier 2 — create. The agent's DRAFT is the basis:
  // ensureConformingContract validates + repairs it in place (bounded LLM
  // loop, gated by the deterministic validateContract), GUARANTEEING a
  // contract the handshake backstop accepts. origin 'agent' = draft was
  // already clean; 'synth' = repaired (or minimal-conforming fallback).
  // ensureConformingContract never throws; the catch is a defensive
  // backstop for an unexpected operational failure under it.
  try {
    const conforming = await ensureConformingContract(
      { llm },
      {
        intent,
        draft: draftContract,
        ...(gadgets !== undefined ? { appGadgets: gadgets } : {}),
      },
    );
    if (conforming.contract === null) {
      // Repair exhausted AND nothing salvageable — decline, loudly.
      return buildDeclined({
        draftContract,
        findings: conforming.findings,
        reason: conforming.reasoning,
        ...(variance !== undefined ? { variance } : {}),
      });
    }
    const suggestion: HandshakeSuggestion = {
      origin: conforming.origin,
      rationale: conforming.reasoning,
      // No blueprintId, no source — both are minted at render-time
      // registration, not here. Absent on agent/synth origins (D4).
      blueprintMeta: {
        contractHash: blueprintKey(conforming.contract),
        // The synthesized contract was made for the request, so its
        // proposed variance is the REQUEST variance (D5).
        variance: variance ?? {},
      },
      proposedContractSummary: summarizeContract(conforming.contract),
      ...(conforming.findings.length > 0
        ? { validationFindings: conforming.findings }
        : {}),
    };
    return {
      action: 'create',
      reason: conforming.reasoning,
      suggestion,
      effectiveContract: conforming.contract,
    };
  } catch (err) {
    if (!isOperationalError(err)) throw err;
    const errorClass = err instanceof Error ? err.name : 'unknown';
    return buildCreateFallback(
      draftContract,
      `negotiator-degraded: ${errorClass} during decision LLM call — ${errMessage(err)}. Falling back to bare-create; the paired ggui_render will still generate the UI.`,
      variance,
    );
  }
}
