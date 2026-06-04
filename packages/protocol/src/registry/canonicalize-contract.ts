/**
 * Canonical, deterministic serialization of `DataContract` per
 * RFC 8785 (JSON Canonicalization Scheme — JCS).
 *
 * Goal: two contracts with the same WIRE-OBSERVABLE shape produce
 * the same canonical bytes, regardless of key order, whitespace, or
 * description-only differences. The canonical string is the input to
 * `blueprintKey()`; equal canonical strings → equal cache key →
 * exact-match hit at handshake time.
 *
 * # Why RFC 8785
 *
 * JCS is the IETF standard for deterministic JSON serialization
 * (published 2020). External implementers can compute the same hash
 * we do using any JCS library (`canonicalize` on npm, `gocanon` in
 * Go, `pyjcs` in Python, `serde_jcs` in Rust). That makes the
 * `contractHash` field a portable identity claim — agents can verify
 * a hash off-server without knowing our internal format.
 *
 * # Pipeline
 *
 *   stripDescriptions(contract)        ← domain rule, OURS
 *     ↓
 *   canonicalize(value)                ← RFC 8785, vendored library
 *     ↓
 *   utf-8 bytes, then sha256 + 16-char hex prefix (in `blueprint-key.ts`)
 *
 * # Domain rule: informational prose is stripped
 *
 * `description` and `usage` are informational only — they don't alter
 * the wire surface (no React.Context is mounted from a description,
 * no action gets routed by a usage hint). Stripping them means a
 * documentation tweak doesn't invalidate a registered blueprint, and
 * an agent's intent-prose override on a gadget export-use entry (the
 * `description?` / `usage?` fields of each
 * `clientCapabilities.gadgets[<package>][<exportName>]`, agent-authored
 * at render time) does not pollute the cache key.
 *
 * The strip is keyed on `description`/`usage` as STRING-VALUED fields,
 * never as map keys. A gadget package, an `agentCapabilities.tools`
 * entry, or a spec slot may legitimately be NAMED `usage` (npm package
 * names allow it) — that key maps to an object and MUST survive, or two
 * distinct contracts collide onto one blueprint cache key and the wrong
 * cached UI is served. Informational prose is always a string; a data
 * map key named `usage`/`description` always maps to an object/array —
 * so the value-type test cleanly separates the two. If QA later shows
 * the prose affects LLM-generated copy enough to be load-bearing, flip
 * `STRIPPED_KEYS`.
 *
 * # Preserved (load-bearing for behavior)
 *
 *   - The four typed specs: `propsSpec`, `actionSpec`, `contextSpec`,
 *     `streamSpec` (including `streamSpec[*].source.tool` cross-refs).
 *   - The two catalogs: `agentCapabilities.tools[*]` (key names + their
 *     `toolInfo.inputSchema`/`toolInfo.outputSchema`) and
 *     `clientCapabilities.gadgets` (package-keyed — npm package names as
 *     outer keys, export names as the inner `exports` map keys; no
 *     `version`, no transport metadata on the wire).
 *
 * # Domain rule: `agentCapabilities.tools[*].serverInfo.version` is stripped
 *
 * `serverInfo` ({name, version?}) records the owning MCP server identity.
 * `(serverInfo.name, toolName)` is the canonical cross-framework identity and
 * stays in the hash — it disambiguates two servers that expose a byte-identical
 * bare tool name (Todoist's `todo_add` vs Google-Tasks' `todo_add` must NOT
 * reuse one another's UI). `serverInfo.version` is METADATA, not identity — a
 * server version bump MUST NOT invalidate a registered blueprint — so ONLY the
 * `version` field is removed (structurally, context-scoped to the tool-catalog
 * recursion) BEFORE the JCS pass. `toolInfo.inputSchema` / `toolInfo.outputSchema`
 * stay — they ARE identity (they shape the data).
 *   - Inner JSON Schema fields under every `schema:` wrapper (`type`,
 *     `enum`, `properties`, `required`, `items`, `additionalProperties`,
 *     `nullable`, `format`, …).
 *   - `default` values, `required` flags, `nextStep` hints (cross-ref
 *     identity), `confirm` / `icon` / `label` / `mode` / `replay` on
 *     their respective spec entries.
 *   - `enum` array order — order matters for select UIs; JCS preserves
 *     array order so we don't pre-sort.
 *   - Slot / action / stream channel / agent-capability tool names,
 *     plus gadget package keys and per-package export names (every key
 *     in the four specs + two catalogs).
 *
 * Pure function — no I/O, no globals.
 */
import canonicalize from 'canonicalize';
import type { AgentToolEntry, DataContract } from '../types/data-contract.js';
import type { BlueprintVariance } from '../types/blueprint.js';

/**
 * Informational-prose field names removed from the canonical form —
 * but ONLY where they are string-valued (see `canonicalizeValue`); a
 * same-named map key is data and is preserved. Stripping happens
 * BEFORE JCS — JCS itself has no concept of "ignorable fields"; that's
 * the protocol's domain rule, not the serialization standard's.
 */
const STRIPPED_KEYS: ReadonlySet<string> = new Set(['description', 'usage']);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Walk `value` recursively and produce a structurally-equivalent
 * tree with stripped keys removed and all strings NFC-normalized.
 * Arrays preserved in order; primitives unchanged except for Unicode
 * normalization on strings; `undefined` collapses to absent (mirrors
 * JSON behavior). Object key sorting + JSON serialization happen in
 * the downstream JCS pass — this function handles the domain-specific
 * strip step PLUS Unicode normalization (RFC 8785 leaves NFC out of
 * scope; we apply it ourselves so visually-identical contracts hash
 * identically regardless of the agent's keyboard / IME composition).
 *
 * Exported for tests / debugging — production callers should use
 * `canonicalizeContracts()`.
 *
 * `stripProse` (default `true`) controls the `description`/`usage`
 * STRIPPED_KEYS strip. The contract pipeline strips (prose is
 * informational); the variance pipeline ({@link canonicalizeVariance})
 * passes `false` because variance prose is load-bearing signal.
 */
export function canonicalizeValue(
  value: unknown,
  stripProse = true,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') return (value as string).normalize('NFC');
  if (t === 'number' || t === 'boolean') {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const c = canonicalizeValue(item, stripProse);
      if (c !== undefined) out.push(c);
    }
    return out;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    // NFC-normalize keys before sort so two contracts with the same
    // key in different normalization forms (precomposed "café" vs
    // decomposed "café") collapse to one identity. Keep the original
    // key for lookup; emit the normalized key in output. Keys sorted
    // alphabetically here too — idempotent with the downstream JCS
    // pass, but keeps the intermediate-form output predictable for
    // tests/debugging that consume `canonicalizeValue` directly.
    const entries = Object.keys(obj)
      // Strip `description`/`usage` ONLY when string-valued — i.e. only
      // where they are informational prose fields. A key that IS
      // literally `description`/`usage` as a MAP key (a gadget package,
      // an `agentCapabilities.tools` entry, a spec slot) maps to an
      // object/array and MUST survive: stripping it collapses distinct
      // contracts onto one blueprint cache key. Skipped entirely when
      // `stripProse` is false (the variance pipeline).
      .filter(
        (k) =>
          !(stripProse && STRIPPED_KEYS.has(k) && typeof obj[k] === 'string'),
      )
      .map((k) => ({ source: k, normalized: k.normalize('NFC') }))
      .sort((a, b) => (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0));
    const out: { [key: string]: JsonValue } = {};
    for (const { source, normalized } of entries) {
      const c = canonicalizeValue(obj[source], stripProse);
      if (c !== undefined) out[normalized] = c;
    }
    return out;
  }
  // Functions, symbols, bigint — not JSON-serializable; treat as absent.
  return undefined;
}

/**
 * Canonicalization-internal projection of an {@link AgentToolEntry} whose
 * `serverInfo` is reduced to its identity-bearing `name`; the metadata
 * `version` is removed. NOT a wire type — only fed to {@link canonicalizeValue}.
 */
type IdentityToolEntry = Omit<AgentToolEntry, 'serverInfo'> & {
  serverInfo?: { name: string };
};

/** A {@link DataContract} projection with version-stripped tool `serverInfo`. */
type IdentityContract = Omit<DataContract, 'agentCapabilities'> & {
  agentCapabilities?: { tools: Record<string, IdentityToolEntry> };
};

/**
 * Structurally reduce `agentCapabilities.tools[*].serverInfo` to its
 * identity-bearing `name` before the generic JCS walk — `serverInfo.name`
 * is load-bearing identity (it disambiguates two servers that expose a
 * byte-identical bare tool name, e.g. Todoist vs Google-Tasks `todo_add`),
 * while `serverInfo.version` is metadata that MUST NOT bust the cache key.
 * Context-scoped to the tool catalog (NOT a global value-guard) so a spec
 * slot / gadget package / tool literally named `serverInfo` elsewhere can
 * never be collateral-stripped. Pure — returns a shallow-cloned projection;
 * the input is never mutated. Returns the input unchanged when there is no
 * `agentCapabilities.tools` to walk.
 */
function stripToolServerInfo(contract: DataContract): IdentityContract {
  const tools = contract.agentCapabilities?.tools;
  if (!tools) return contract;
  const cleanedTools: Record<string, IdentityToolEntry> = {};
  for (const [name, entry] of Object.entries(tools)) {
    if (entry.serverInfo === undefined) {
      cleanedTools[name] = entry;
      continue;
    }
    // Keep serverInfo.name (identity); drop serverInfo.version (metadata).
    const { version: _version, ...nameOnly } = entry.serverInfo;
    cleanedTools[name] = { ...entry, serverInfo: nameOnly };
  }
  return {
    ...contract,
    agentCapabilities: { ...contract.agentCapabilities, tools: cleanedTools },
  };
}

/**
 * Produce the canonical bytes for a `DataContract` value, suitable
 * for hashing or external content-address lookups. Stable across
 * paraphrase, key order, whitespace, description-only edits, and
 * `serverInfo.version` (server-version metadata; `serverInfo.name` is
 * identity and is preserved).
 *
 * Empty / undefined / `{}` all collapse to the same canonical bytes,
 * which produces a stable `blueprintKey` for the "no-contract" case.
 * That key isn't used for cache lookups (registry refuses to register
 * contract-less pushes) but stays well-defined for completeness.
 *
 * The output is a UTF-8-encoded JSON string per RFC 8785. External
 * implementations using any JCS library produce the same bytes.
 */
export function canonicalizeContracts(contract: DataContract | undefined): string {
  const stripped = canonicalizeValue(stripToolServerInfo(contract ?? {}));
  // `canonicalize` may return undefined if every field was stripped;
  // fall back to the empty-object canonical form so the hash function
  // always receives a stable string.
  const result = canonicalize(stripped);
  return result ?? '{}';
}

/**
 * Recursively elide "absent-equivalent" fields so semantically-empty
 * variance collapses to the empty-object canonical form. Empty strings
 * (`''`), empty objects (`{}`), empty arrays, `null`, and `undefined`
 * are all dropped; a primitive that survives is kept verbatim. This is
 * the D9 self-normalization step — callers never pre-normalize.
 */
function elideEmpty(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const e = elideEmpty(item);
      if (e !== undefined) out.push(e);
    }
    return out.length === 0 ? undefined : out;
  }
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    const e = elideEmpty(value[key]);
    if (e !== undefined) out[key] = e;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Canonical bytes for a {@link BlueprintVariance} block — the input to
 * `variantKey()`. Same JCS + NFC pipeline as {@link canonicalizeContracts}
 * with two DELIBERATE divergences from the contract pipeline:
 *
 *   1. **No `description`/`usage` strip.** For a contract, prose is
 *      informational and stripped so a doc tweak doesn't invalidate a
 *      cache key. For variance, the prose IS the signal: `seedPrompt`
 *      and any `context` value steer the generated `componentCode`, so
 *      stripping them would collapse genuinely distinct variants onto
 *      one key (false reuse). This is the inverse of the contract rule.
 *   2. **Self-normalizing (D9).** Empty-string fields, empty objects,
 *      and empty arrays are elided internally so `undefined`, `{}`,
 *      `{persona:''}`, and an all-empty block all collapse to the same
 *      "default variant" canonical form. Callers never pre-normalize —
 *      the accept path (verbatim `blueprintMeta.variance`) and the
 *      override path produce identical keys for equivalent variance.
 *
 * Pure function — no I/O, no globals.
 */
export function canonicalizeVariance(
  variance: BlueprintVariance | undefined,
): string {
  // NFC-normalize + sort keys (canonicalizeValue), but withOUT the
  // STRIPPED_KEYS prose strip (`stripProse: false`) — variance prose
  // is load-bearing signal, the inverse of the contract rule.
  const normalized = canonicalizeValue(variance ?? {}, false);
  const elided = elideEmpty(normalized) ?? {};
  const result = canonicalize(elided);
  return result ?? '{}';
}
