/**
 * Binding-conformance catalog — MCP tool-binding resolution + search
 * filter semantics (SPEC §7.7.4 — tool bindings & discovery).
 *
 * ## Why this is a pure-function catalog
 *
 * Two pure obligations connect a registry artifact to the MCP tools
 * it renders:
 *
 *   1. RESOLUTION — given a manifest, which binding set is
 *      effective? A declared `mcpTools` list wins entirely; a
 *      blueprint without one derives bare tool names from its
 *      contract's lineage fields
 *      (`propsSpec.properties[*].sourceTool`,
 *      `streamSpec[*].source.tool`); a schema-invalid list rejects
 *      with the manifest-validation code. Bindings are search
 *      metadata only — they never enter contract canonicalization
 *      or any cache identity.
 *   2. FILTERING — given an artifact's stored binding set and a
 *      search query's `tool` / `server` params, does the artifact
 *      match? Both dimensions are case-sensitive exact and must land
 *      on a single entry; a bare entry never satisfies a server
 *      dimension; no dimensions given passes everything.
 *
 * Both are deterministic functions — no render, transport, or wire
 * frame — so they get the same treatment as the registry gate
 * (`../registration-conformance`) and bundle-URL resolution
 * (`../resolution-conformance`): catalogs of JSON cases graded
 * against caller-supplied functions.
 *
 * ## Polyglot, decoupled
 *
 * Each case ships as raw JSON under `./cases/`.
 * {@link runBindingResolutionCases} / {@link runBindingFilterCases}
 * take the implementation as a callback — the kit never imports a
 * concrete resolver or search filter, so adopters drive their OWN.
 * The reference binding (`./binding-conformance.test.ts`) restates
 * faithful minimal implementations in-test.
 */
import type { DataContract } from "@ggui-ai/protocol";

import bindBlueprintNoContractNone from "./cases/bind-blueprint-no-contract-none.json" with { type: "json" };
import bindContractWithoutToolNamesNone from "./cases/bind-contract-without-tool-names-none.json" with { type: "json" };
import bindDeclaredGadget from "./cases/bind-declared-gadget.json" with { type: "json" };
import bindDeclaredWinsOverContract from "./cases/bind-declared-wins-over-contract.json" with { type: "json" };
import bindDerivedPropsAndStream from "./cases/bind-derived-props-and-stream.json" with { type: "json" };
import bindDerivedUnionDedupes from "./cases/bind-derived-union-dedupes.json" with { type: "json" };
import bindGadgetUndeclaredNone from "./cases/bind-gadget-undeclared-none.json" with { type: "json" };
import bindRejectCharset from "./cases/bind-reject-charset.json" with { type: "json" };
import bindRejectDuplicatePair from "./cases/bind-reject-duplicate-pair.json" with { type: "json" };
import bindRejectEmptyList from "./cases/bind-reject-empty-list.json" with { type: "json" };
import bindRejectOverlongName from "./cases/bind-reject-overlong-name.json" with { type: "json" };
import bindRejectServerCharset from "./cases/bind-reject-server-charset.json" with { type: "json" };
import bindRejectTooManyEntries from "./cases/bind-reject-too-many-entries.json" with { type: "json" };
import filterCaseSensitiveServer from "./cases/filter-case-sensitive-server.json" with { type: "json" };
import filterCaseSensitiveTool from "./cases/filter-case-sensitive-tool.json" with { type: "json" };
import filterNonePassesBound from "./cases/filter-none-passes-bound.json" with { type: "json" };
import filterNonePassesUnbound from "./cases/filter-none-passes-unbound.json" with { type: "json" };
import filterPairBareNeverMatches from "./cases/filter-pair-bare-never-matches.json" with { type: "json" };
import filterPairExact from "./cases/filter-pair-exact.json" with { type: "json" };
import filterPairNotCrossEntry from "./cases/filter-pair-not-cross-entry.json" with { type: "json" };
import filterServerExcludesBare from "./cases/filter-server-excludes-bare.json" with { type: "json" };
import filterServerMatch from "./cases/filter-server-match.json" with { type: "json" };
import filterToolCrossServer from "./cases/filter-tool-cross-server.json" with { type: "json" };
import filterToolExcludesUnbound from "./cases/filter-tool-excludes-unbound.json" with { type: "json" };
import filterToolMatchesBareEntry from "./cases/filter-tool-matches-bare-entry.json" with { type: "json" };
import filterToolNoMatch from "./cases/filter-tool-no-match.json" with { type: "json" };

/**
 * One MCP tool binding as authored on a manifest / stored on search
 * metadata. `server` carries `serverInfo.name` semantics; a bare
 * entry (no `server`) is server-agnostic.
 */
export interface McpToolBindingDecl {
  readonly server?: string;
  readonly tool: string;
}

/**
 * The binding-relevant subset of an artifact manifest the resolver
 * reads. Authored kit-local — decoupled from any shipping manifest
 * schema on purpose; `contract` reuses the protocol's
 * {@link DataContract} type the way `../registration-conformance`
 * does.
 */
export interface BindingManifestEntry {
  /** Which manifest kind the entry models. Only blueprints derive. */
  readonly kind: "gadget" | "blueprint";
  /** The `mcpTools` list as authored — possibly invalid. */
  readonly mcpTools?: readonly McpToolBindingDecl[];
  /** The blueprint's contract, when it has one. */
  readonly contract?: DataContract;
}

/**
 * The code a schema-invalid `mcpTools` list classifies into.
 * Extensibly-closed `(string & {})` tail so a later protocol
 * revision's code rides through without a kit bump — same
 * discipline as `GadgetGateRejectCode` in
 * `../registration-conformance`.
 */
export type BindingRejectCode = "manifest_invalid" | (string & {});

/**
 * What resolving one manifest's bindings produces: accept with a
 * `source` + `bindings` pair (declared or derived — present together
 * or absent together), accept with NEITHER (the artifact has no
 * bindings and is not findable by tool), or reject with the
 * manifest-validation code.
 */
export type BindingResolutionOutcome =
  | {
      readonly outcome: "accept";
      readonly source?: "declared" | "derived";
      readonly bindings?: readonly McpToolBindingDecl[];
    }
  | { readonly outcome: "reject"; readonly code: BindingRejectCode };

/**
 * A search query's tool/server params as one filter input. Both
 * optional — an absent dimension does not constrain. Matching is
 * case-sensitive exact on both dimensions.
 */
export interface McpToolFilterDecl {
  readonly tool?: string;
  readonly server?: string;
}

/**
 * One binding-resolution case. Authored as JSON under `./cases/`,
 * consumed via {@link bindingResolutionCases}, graded by
 * {@link runBindingResolutionCases}.
 *
 * The shape IS the public API — additive changes only.
 */
export interface BindingResolutionCase {
  /** Unique case name. MUST match the JSON filename without `.json`. */
  readonly name: string;
  /** Which binding obligation this case proves. */
  readonly description: string;
  /** The manifest subset fed to the resolver. */
  readonly entry: BindingManifestEntry;
  /**
   * The outcome a spec-conformant resolver MUST produce. Binding
   * lists are compared order-sensitively: declared bindings carry
   * authored order; derived bindings carry first-appearance order
   * (props in declaration order, then stream channels), duplicates
   * collapsed to the first occurrence.
   */
  readonly expect: BindingResolutionOutcome;
}

/**
 * One filter-semantics case. Authored as JSON under `./cases/`,
 * consumed via {@link bindingFilterCases}, graded by
 * {@link runBindingFilterCases}.
 *
 * The shape IS the public API — additive changes only.
 */
export interface BindingFilterCase {
  /** Unique case name. MUST match the JSON filename without `.json`. */
  readonly name: string;
  /** Which filter obligation this case proves. */
  readonly description: string;
  /** The artifact's stored binding set — absent models an unbound artifact. */
  readonly bindings?: readonly McpToolBindingDecl[];
  /** The query's tool/server params — `{}` models neither given. */
  readonly filters: McpToolFilterDecl;
  /** Whether a spec-conformant filter matches the artifact. */
  readonly expect: boolean;
}

/**
 * Every binding-resolution case the kit ships, in deterministic
 * order — declared first, then derived, then the no-binding edges,
 * then the schema rejects.
 */
export const bindingResolutionCases: readonly BindingResolutionCase[] = [
  bindDeclaredGadget as BindingResolutionCase,
  bindDeclaredWinsOverContract as BindingResolutionCase,
  bindDerivedPropsAndStream as BindingResolutionCase,
  bindDerivedUnionDedupes as BindingResolutionCase,
  bindBlueprintNoContractNone as BindingResolutionCase,
  bindContractWithoutToolNamesNone as BindingResolutionCase,
  bindGadgetUndeclaredNone as BindingResolutionCase,
  bindRejectCharset as BindingResolutionCase,
  bindRejectServerCharset as BindingResolutionCase,
  bindRejectDuplicatePair as BindingResolutionCase,
  bindRejectOverlongName as BindingResolutionCase,
  bindRejectTooManyEntries as BindingResolutionCase,
  bindRejectEmptyList as BindingResolutionCase,
];

/**
 * Every filter-semantics case the kit ships, in deterministic
 * order — tool-dimension, server-dimension, pair, no-filter
 * passthrough, then case-sensitivity.
 */
export const bindingFilterCases: readonly BindingFilterCase[] = [
  filterToolCrossServer as BindingFilterCase,
  filterToolMatchesBareEntry as BindingFilterCase,
  filterToolNoMatch as BindingFilterCase,
  filterServerMatch as BindingFilterCase,
  filterServerExcludesBare as BindingFilterCase,
  filterPairExact as BindingFilterCase,
  filterPairNotCrossEntry as BindingFilterCase,
  filterPairBareNeverMatches as BindingFilterCase,
  filterNonePassesBound as BindingFilterCase,
  filterNonePassesUnbound as BindingFilterCase,
  filterToolExcludesUnbound as BindingFilterCase,
  filterCaseSensitiveTool as BindingFilterCase,
  filterCaseSensitiveServer as BindingFilterCase,
];

/** One resolution case the resolver under test graded wrong. */
export interface BindingResolutionMismatch {
  readonly name: string;
  /** The outcome the catalog says a conformant resolver MUST produce. */
  readonly expected: BindingResolutionOutcome;
  /** The outcome the resolver under test actually produced. */
  readonly actual: BindingResolutionOutcome;
}

/** Outcome of grading a resolver against the resolution catalog. */
export interface BindingResolutionResult {
  /** Names of cases the resolver graded correctly. */
  readonly passed: readonly string[];
  /** Cases the resolver graded wrong — empty iff fully conformant. */
  readonly failed: readonly BindingResolutionMismatch[];
}

/** One filter case the predicate under test graded wrong. */
export interface BindingFilterMismatch {
  readonly name: string;
  /** Whether the catalog says a conformant filter matches. */
  readonly expected: boolean;
  /** What the predicate under test actually returned. */
  readonly actual: boolean;
}

/** Outcome of grading a filter predicate against the filter catalog. */
export interface BindingFilterResult {
  /** Names of cases the predicate graded correctly. */
  readonly passed: readonly string[];
  /** Cases the predicate graded wrong — empty iff fully conformant. */
  readonly failed: readonly BindingFilterMismatch[];
}

function bindingListsEqual(
  a: readonly McpToolBindingDecl[] | undefined,
  b: readonly McpToolBindingDecl[] | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i];
    return other !== undefined && entry.tool === other.tool && entry.server === other.server;
  });
}

function resolutionOutcomeEquals(
  a: BindingResolutionOutcome,
  b: BindingResolutionOutcome
): boolean {
  if (a.outcome === "reject" || b.outcome === "reject") {
    return a.outcome === "reject" && b.outcome === "reject" && a.code === b.code;
  }
  return a.source === b.source && bindingListsEqual(a.bindings, b.bindings);
}

/**
 * Grade a binding resolver against the resolution catalog.
 *
 * `resolve` MUST be a pure computation of `(entry) →
 * BindingResolutionOutcome` — schema validation of a declared list
 * plus declared-wins/derivation precedence, composed however the
 * implementation likes. The kit deliberately does NOT import a
 * concrete resolver — adopters pass their own (the reference
 * binding uses a faithful in-test implementation; see
 * `./binding-conformance.test.ts`). A conformant resolver produces
 * an empty `failed` array.
 *
 * `resolve` is invoked exactly once per case, in
 * {@link bindingResolutionCases} order; it MUST be pure and MUST
 * NOT throw (a throwing resolver is itself non-conformant — wrap it
 * so a classified rejection becomes a returned outcome).
 */
export function runBindingResolutionCases(
  resolve: (entry: BindingManifestEntry) => BindingResolutionOutcome
): BindingResolutionResult {
  const passed: string[] = [];
  const failed: BindingResolutionMismatch[] = [];
  for (const testCase of bindingResolutionCases) {
    const actual = resolve(testCase.entry);
    if (resolutionOutcomeEquals(actual, testCase.expect)) {
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

/**
 * Grade a search filter predicate against the filter catalog.
 *
 * `matches` MUST be a pure computation of `(bindings, filters) →
 * boolean` — the same predicate every storage implementation shares
 * so `tool=` / `server=` behave identically everywhere. The kit
 * deliberately does NOT import a concrete predicate — adopters pass
 * their own. A conformant predicate produces an empty `failed`
 * array.
 *
 * `matches` is invoked exactly once per case, in
 * {@link bindingFilterCases} order; it MUST be pure and MUST NOT
 * throw.
 */
export function runBindingFilterCases(
  matches: (
    bindings: readonly McpToolBindingDecl[] | undefined,
    filters: McpToolFilterDecl
  ) => boolean
): BindingFilterResult {
  const passed: string[] = [];
  const failed: BindingFilterMismatch[] = [];
  for (const testCase of bindingFilterCases) {
    const actual = matches(testCase.bindings, testCase.filters);
    if (actual === testCase.expect) {
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
