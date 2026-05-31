/**
 * Shared handshake-decision core — ONE negotiation pipeline, adapter-injected.
 *
 * Both the OSS server (`@ggui-ai/mcp-server`) and the cloud pod
 * (`@ggui-cloud/ggui-protocol-pod`) drive the same `decideHandshake`
 * function; they differ ONLY in the {@link HandshakeDecisionAdapter} they
 * inject. The adapter abstracts every seam that varies between
 * deployments — the LLM (BYOK provider vs Bedrock), the blueprint pools
 * to search (sqlite/in-memory vs S3 Vectors; one per-app pool vs a
 * per-app + shared-catalog + org fan-out), an optional deployment-specific
 * pre-match (cloud's curated-blueprint tier-0), the generator slug, and an
 * operator-visible warn sink.
 *
 * ## Decision spine (identical for every deployment)
 *
 *   1. **Pre-match** (optional adapter hook) — a deployment-specific
 *      deterministic match that wins over everything else. Cloud uses it
 *      for the curated-blueprint tier-0 (dataTools ⊆ sourceTools). OSS
 *      omits it. A returned result short-circuits.
 *   2. **Find-similar across pools** — for each declared pool, in order,
 *      run {@link matchBlueprint} (exact-key → coverage guard → judge).
 *      An `exact-key` hit (free, canonical-key equality) in ANY pool wins
 *      immediately. Otherwise the highest-confidence `semantic` hit across
 *      all pools is reused ATOMICALLY (the cached blueprint's own contract
 *      + componentCode, never the agent's draft under cached code).
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
  type DataContract,
  type HandshakeSuggestion,
  type SuggestionFinding,
} from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  ensureConformingContract,
  type LLMCaller,
} from '@ggui-ai/negotiator';
import type { HandlerContext } from '../types.js';
import {
  matchBlueprint,
  type BlueprintMatchHit,
  type MatchBlueprintDeps,
} from './blueprint-matcher.js';
import type { BlueprintRegistryDeps } from './blueprint-registry.js';
import {
  DEFAULT_GENERATOR_SLUG,
  type HandshakeNegotiator,
  type HandshakeNegotiatorResult,
} from './handshake.js';
import type { InstalledBlueprintsProvider } from './installed-blueprints-provider.js';

/**
 * One blueprint pool to search for a reusable match. A pool is a
 * `(registry, scope)` pair — the registry (embedding + vectorStore)
 * backing it, and the tenant/catalog partition to query within it.
 *
 * Modeling pools as an array is the adapter-first generalization: OSS
 * declares a single per-app pool; cloud declares the per-app pool plus a
 * shared-catalog pool (and may add org/team pools later) — the same core
 * fans out over whatever the deployment provides, no `includeSharedPool`
 * boolean special-case.
 */
export interface BlueprintPool {
  /** Registry (embedding + vectorStore) backing this pool. */
  readonly registry: BlueprintRegistryDeps;
  /**
   * Scope / tenant partition to query within the registry. Defaults to
   * the request's `ctx.appId` (the per-app pool) when omitted. Cloud uses
   * e.g. `'shared'` for a cross-tenant curated catalog.
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
 * that differs between OSS and cloud lives behind this interface; the
 * decision spine in {@link decideHandshake} is deployment-agnostic.
 */
export interface HandshakeDecisionAdapter {
  /**
   * Resolve the LLM for this request — the find-similar judge AND the
   * synth-repair loop both use it. Returns `undefined` when no LLM is
   * available (e.g. no BYOK creds resolved); the core then returns a
   * deterministic no-repair create fallback. OSS wraps a per-`ctx` BYOK
   * resolver; cloud returns its static Bedrock caller.
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
   * Optional deployment-specific pre-match, run BEFORE the find-similar
   * probe so a curated / byte-exact hit wins over everything. Cloud uses
   * it for the curated-blueprint tier-0. Return a result to short-circuit;
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
   * Generator slug stamped on every suggestion's `blueprintMeta.generator`.
   * Defaults to {@link DEFAULT_GENERATOR_SLUG}.
   */
  readonly generatorSlug?: string;
  /**
   * Operator-visible sink for swallowed operational errors (pool probe
   * hiccup, pre-match backend flap). OSS passes `console.warn`; cloud
   * passes its structured logger. Absent ⇒ silent.
   */
  warn?(message: string): void;
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
  },
  reason: string,
  generatorSlug: string = DEFAULT_GENERATOR_SLUG,
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
      generator: generatorSlug,
      variance: {},
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
    },
  };
}

/**
 * Deterministic no-LLM create fallback (no LLM resolved, or an
 * operational error during synth). The handshake backstop
 * (`validateContract`) THROWS on a malformed draft and there is no LLM
 * here to repair it — so deterministically substitute the trivially-
 * conforming empty contract (+ loud findings) when the draft fails the
 * gate. NEVER return a raw malformed draft into the throwing backstop. A
 * clean draft is kept verbatim (`origin: 'agent'`).
 */
export function buildCreateFallback(
  draftContract: unknown,
  reason: string,
  generatorSlug: string = DEFAULT_GENERATOR_SLUG,
): HandshakeNegotiatorResult {
  const lint = lintContract(draftContract);
  const contract: DataContract =
    lint.errors.length === 0 ? dataContractSchema.parse(draftContract) : {};
  const findings: SuggestionFinding[] = lint.errors.map((e) => ({
    code: e.code,
    severity: 'error',
    path: e.path,
    message: e.message,
  }));
  const contractHash = blueprintKey(contract);
  const suggestion: HandshakeSuggestion = {
    origin: 'agent',
    rationale: reason,
    // No blueprintId — the durable UUID is minted at render-time
    // registration, never at handshake. Absent on agent/synth (D4).
    blueprintMeta: {
      contractHash,
      generator: generatorSlug,
      variance: {},
    },
    proposedContractSummary: summarizeContract(contract),
    ...(findings.length > 0 ? { validationFindings: findings } : {}),
  };
  return {
    action: 'create',
    reason,
    suggestion,
    effectiveContract: contract,
  };
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
  const generatorSlug = adapter.generatorSlug ?? DEFAULT_GENERATOR_SLUG;
  const draftContract = blueprintDraft.contract;
  // Draft is UNTRUSTED (forgiving handshake — may be malformed). Parse
  // once up front: the find-similar tiers need a valid DataContract; a
  // malformed draft skips them and falls straight to validate/repair.
  const parsedDraft = dataContractSchema.safeParse(draftContract);

  // Tier 0 — deployment-specific pre-match (cloud curated blueprint).
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

  // Tier 1 — find-similar across pools (exact-key free + semantic
  // find+judge+coverage). Reuse the cached blueprint ATOMICALLY.
  if (adapter.pools && adapter.pools.length > 0 && parsedDraft.success) {
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
        const matchResult = await matchBlueprint(matchDeps, scope, {
          intent,
          contract: parsedDraft.data,
        });
        // exact-key is a perfect canonical match — it always wins,
        // immediately, over any semantic hit from any pool.
        if (matchResult.strategy === 'exact-key') {
          return buildCacheReuseResult(
            matchResult.blueprint,
            matchResult.reason,
            generatorSlug,
          );
        }
        if (matchResult.strategy === 'semantic') {
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
      // No exact-key anywhere → reuse the highest-confidence semantic hit
      // across pools (each pool's judge ran in its own candidate context).
      const best = semanticHits.reduce((a, b) =>
        (b.judgeConfidence ?? 0) > (a.judgeConfidence ?? 0) ? b : a,
      );
      return buildCacheReuseResult(best.blueprint, best.reason, generatorSlug);
    }
  }

  // No LLM → deterministic no-repair create fallback.
  if (!llm) {
    return buildCreateFallback(
      draftContract,
      'no-creds: no LLM available for the configured provider; ggui_render will surface the same error and the handshake stays a no-op create.',
      generatorSlug,
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
    const suggestion: HandshakeSuggestion = {
      origin: conforming.origin,
      rationale: conforming.reasoning,
      // No blueprintId — minted at render-time registration, not here.
      // Absent on agent/synth origins (D4).
      blueprintMeta: {
        contractHash: blueprintKey(conforming.contract),
        generator: generatorSlug,
        variance: {},
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
      generatorSlug,
    );
  }
}
