/**
 * `Blueprint` — the variant-unit between a `DataContract` and the
 * generated UI code that renders it.
 *
 * Multiple `Blueprint` records MAY share `(appId, contractHash)`; they
 * differ on `source` and/or {@link BlueprintVariance}. The selector
 * picks one at runtime (an LLM-driven pick layered atop the
 * deterministic fallback ladder; see
 * {@link BlueprintSelector} in `@ggui-ai/mcp-server-core`).
 *
 * Locked decisions:
 *
 *   - **Storage shape: content-addressed body + metadata pointer.**
 *     Persistent adapters store the code body content-addressed (keyed
 *     by its hash) and keep `codeS3Url + codeHash` as a pointer on the
 *     metadata row — row-size limits in typical metadata stores
 *     preclude inline storage (typical generated code is 5-30KB but
 *     advanced-generator iterative-loop output routinely exceeds
 *     them). The in-memory adapter skips the body store (in-process
 *     `Map<codeHash, string>`).
 *   - **App scope.** Scoped per `(appId, contractHash)`. Different apps'
 *     contract may coincidentally hash the same; their blueprints
 *     must never cross-pollinate. Rows are keyed by `blueprintId`;
 *     lookups go through an indexed `(appId, contractHash)` query.
 *   - **`contract` field.** The contract shape is content-keyed by
 *     `contractHash` (RFC 8785 / `blueprintKey`), so any two
 *     blueprints with the same `contractHash` agree on it
 *     byte-for-byte after canonicalization. The embedded `contract`
 *     copy is a read-time convenience for callers that have the
 *     blueprint row in hand and don't want a second lookup — NOT a
 *     source-of-truth divergence. Implementations MAY denormalize
 *     freely; consumers MUST treat `contractHash` as authoritative.
 */
import type { BlueprintSource } from "./blueprint-source.js";
import type { DataContract, JsonObject } from "./data-contract.js";

/**
 * Per-axis weights for the {@link BlueprintSearch} multi-axis scoring
 * algorithm. Each weight is a non-negative number; the final score is
 * the weighted sum divided by the sum-of-weights so the output stays
 * in `[0, 1]` regardless of how operators tune the dial.
 *
 * Wire shape: lives on
 * {@link BlueprintSearchConfig.weights}, which lives on the per-app
 * {@link AppBlueprintSearchConfig}. Default values:
 * `{hash: 1.0, embed: 0.4, struct: 0.3, variance: 0.2, intent: 0.1}` —
 * the embed + struct axes dominate by design (a structurally-similar
 * contract is the strongest semantic match short of an exact hash).
 */
export interface BlueprintSearchWeights {
  /** Exact `contractHash` equality. Short-circuit weight — when a
   *  match exists on this axis, the search returns `score: 1.0`
   *  immediately without consulting the others. */
  readonly hash: number;
  /** Cosine similarity between query + candidate `contractEmbedding`. */
  readonly embed: number;
  /** Structural fingerprint Jaccard — actionNames, streamChannels,
   *  propsKeys, contextKeys overlap. */
  readonly struct: number;
  /** Variance-tag overlap — persona equality + aesthetic equality +
   *  context-key Jaccard, averaged. */
  readonly variance: number;
  /** Intent-keyword Jaccard against the blueprint's stored
   *  `seedPrompt + persona` tokens. */
  readonly intent: number;
}

/**
 * Per-app blueprint-search configuration. All fields optional — the
 * server applies the global default when absent.
 *
 * Wire shape: lives on the per-app `App` record
 * in `@ggui-ai/mcp-server-core` as `App.blueprintSearchConfig?`.
 * Persistent adapters carry it as an optional column with
 * default-on-read.
 */
export interface AppBlueprintSearchConfig {
  /** Per-axis weight overrides. Falls back to
   *  `DEFAULT_BLUEPRINT_SEARCH_WEIGHTS`. */
  readonly weights?: Partial<BlueprintSearchWeights>;
  /** Score gate for `origin: 'cache'` routing in the three-step
   *  handshake. Defaults to `0.85`. */
  readonly threshold?: number;
  /** Maximum results returned per call. Defaults to `5`. */
  readonly topK?: number;
}

/**
 * Per-blueprint variance tags. Free-form at v1 — a `PersonaRegistry`
 * may follow if the tag set stabilizes around recurring patterns.
 *
 * The LLM-driven selector reads `persona` + `context` + `seedPrompt`
 * to pick the best fit for the current request's `intent` + `hint`.
 */
export interface BlueprintVariance {
  /**
   * Free-form persona tag (e.g. `'minimalist'`, `'data-dense'`,
   * `'mobile-first'`). Operator-authored.
   */
  readonly persona?: string;
  /**
   * Free-form aesthetic tag (e.g. `'glassmorphic'`, `'brutalist'`,
   * `'editorial'`). Distinct from persona — persona names the user
   * mental model; aesthetic names the visual treatment. Cold-gen
   * prompts surface this as a styling directive; the variant selector
   * weights it alongside persona when ranking cached variants.
   */
  readonly aesthetic?: string;
  /**
   * Small structured signal carried alongside the persona. Typed as
   * {@link JsonObject} so any JSON-safe shape rides through.
   */
  readonly context?: JsonObject;
  /**
   * The raw operator prompt that produced this variant. Round-trip
   * input for the LLM selector + audit trail.
   */
  readonly seedPrompt?: string;
}

/**
 * The BUILD identity of the engine that minted a blueprint: values that
 * change when the engine's code or templates change and never with the
 * request, so results group by the build that produced them (ggui#1280).
 *
 * One declaration, here: `@ggui-ai/mcp-server-core` re-exports it under
 * the same name for `GenerationMetadata.build`, and the durable record
 * carries it as {@link Blueprint.build}. Absent when the engine reports
 * none — never guessed.
 */
export interface GeneratorBuild {
  /** The engine package's version when readable at runtime; absent, never guessed, when not. */
  readonly version?: string;
  /** Engine-defined label for the configuration the digests were computed under. Opaque to consumers, like `routeKind`. */
  readonly mode?: string;
  /**
   * Content digests (lowercase hex sha256) that identify the build. Keys are
   * the engine's own, scoped by the source's `generator`; consumers compare
   * and group by value, and only a consumer that knows the engine reads a key.
   */
  readonly digests: Readonly<Record<string, string>>;
}

/**
 * The variant-unit. See file-level docstring for the locked decisions
 * this shape encodes.
 */
export interface Blueprint {
  /** Stable, unique blueprint id (e.g. `bp_<uuid>`). Primary key. */
  readonly blueprintId: string;
  /**
   * Canonical RFC 8785 (JCS) hash of the contract shape — same
   * function as `blueprintKey(contract)`. Groups variants under one
   * key.
   */
  readonly contractHash: string;
  /** App scope. Composite secondary key with `contractHash`. */
  readonly appId: string;
  /**
   * S3 URL (`s3://<bucket>/<key>`) of the generated code body when
   * cached. Absent → blueprint is pending generation; render branches
   * on this to decide cache-hit vs gen-and-persist. OSS in-memory
   * adapters MAY use a non-S3 sentinel (or just leave this absent
   * and rely on `codeHash` to look up code body inline).
   */
  readonly codeS3Url?: string;
  /**
   * Content hash of the generated code body. Present iff
   * {@link codeS3Url} is present (or the in-memory equivalent).
   */
  readonly codeHash?: string;
  /**
   * `CodeStore` content hash (`hashOf`) of the AUTHORED, pre-compile
   * source body — distinct from {@link codeHash}, which hashes the
   * compiled `componentCode`. Absent when the blueprint has no
   * authored form distinct from its compiled output (the engine never
   * produced one, or produced a byte-identical duplicate that the
   * read-side envelope guard would reject as a fallback collapse
   * anyway). The body itself is NOT stored on this row — persistent
   * adapters keep vector/metadata rows small and content-address the
   * body through the same `CodeStore` seam `codeHash` already implies.
   */
  readonly sourceCodeHash?: string;
  /**
   * Provenance of the component code — the single
   * {@link BlueprintSource} vocabulary. Generation paths mint the
   * `llm` arm (`{kind: 'llm', generator, model}`) from the engine's
   * own metadata stamp; `ggui_ops_register_blueprint` stamps
   * `{kind: 'user'}` for operator-supplied bytes (no engine claim
   * exists to record). A DIFFERENT axis from {@link createdBy} (who
   * initiated the mint): an `ggui_ops_generate_blueprint` row is
   * `createdBy: 'operator'` AND `source.kind: 'llm'`.
   */
  readonly source: BlueprintSource;
  /**
   * Optional 0-1 validator score from the advanced generator's
   * iterative loop. Sub-threshold variants are stored but not selected
   * by default; the operator UI can promote them.
   */
  readonly validatorScore?: number;
  /**
   * Variance tags driving the LLM selector. See
   * {@link BlueprintVariance}.
   */
  readonly variance: BlueprintVariance;
  /**
   * Operator-pinned default flag. The deterministic fallback ladder
   * picks this variant first when present; the LLM selector defers to
   * it when ambiguous.
   *
   * Encoded as `true | undefined` (never `false`) — only one variant
   * per `(appId, contractHash)` carries the flag, and the store
   * enforces the invariant on `setOperatorDefault`. Absent ≡ not
   * the default.
   */
  readonly isOperatorDefault?: true;
  /** ISO-8601 timestamp the row was first inserted. */
  readonly createdAt: string;
  /**
   * `'agent'` when the standard handshake → render flow minted the
   * blueprint; `'operator'` when an explicit `ggui_ops_generate_blueprint`
   * call created it.
   */
  readonly createdBy: "agent" | "operator";
  /**
   * Read-cache copy of the contract shape. See file-level docstring
   * for why this is a denormalization, not a source-of-truth
   * divergence. Consumers MUST treat {@link contractHash} as
   * authoritative for identity comparison.
   */
  readonly contract: DataContract;
  /**
   * Embedding vector of the canonical-JSON-stringified contract,
   * computed by {@link EmbeddingProvider} at
   * {@link BlueprintStore.put} time when a provider is wired. Read
   * by {@link BlueprintSearch} on the embed axis (cosine similarity
   * vs. the search-time embedding of the query contract). Absent
   * when the store was constructed without a provider; the search
   * still works — the embed axis simply contributes zero and the
   * other axes (hash, structural, variance, intent) carry the
   * decision.
   *
   * Length MUST equal the provider's declared `dimensions`. SHOULD be
   * L2-normalized so dot product == cosine.
   * Implementations that swap providers across deployments are
   * expected to re-embed; comparing vectors across provider ids is
   * a category error (different basis), and the search layer
   * defends by treating dimension mismatch as embed-axis zero.
   */
  readonly contractEmbedding?: readonly number[];
  /**
   * The build of the engine that minted this blueprint (ggui#1280), so a
   * reused render is separable from a fresh one by the generator that
   * made its code. Written once at mint from the generation's
   * `metadata.build`; never rewritten.
   *
   * Absent on rows minted before the stamp existed and on engines that
   * report no build; absence means the minting build is unknown, and a
   * reader reports it as such rather than failing the row (the first such
   * reader is the serve trace's `mintedBy`, ggui#1280 read side). Written
   * by a generation mint only — a cold-generated render's registration and
   * an operator-invoked generation; an operator-registered, installed or
   * seed-imported row never carries it, and a stamp that fails
   * {@link generatorBuildSchema} is dropped at registration rather than
   * stored. Declared one release before any writer emitted it, because the
   * previous release's `ggui_ops_list_blueprints` output validation parses
   * rows with the strict `blueprintSchema` and would refuse a stamped one.
   * A store MUST persist what it is given here (graded by the
   * `BlueprintStore` conformance kit).
   */
  readonly build?: GeneratorBuild;
}
