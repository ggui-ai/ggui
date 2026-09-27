/**
 * Deterministic draft normalization — the cheap, faithful repair tier.
 *
 * Most agent-draft malformations are MECHANICAL: a stray illegal key on
 * a spec wrapper (a JSON-Schema-reflex `required: [...]` array on the
 * propsSpec wrapper, an `additionalProperties` key), or a non-canonical
 * schema `type` spelling (`"enum"`, `"integer"`). None of these needs an
 * LLM to fix — and routing them through the LLM repair loop is both
 * wasteful (a full regeneration) and RISKY (the model may re-author and
 * reshape a 95%-correct draft, e.g. drop a propsSpec seed surface).
 *
 * This pass fixes the mechanical classes deterministically, preserving
 * the agent's intent exactly:
 *   - lifts a wrapper-level `propsSpec.required: [...]` (JSON Schema's
 *     spelling of the same declaration) into each listed entry's
 *     `required: true` before the key goes — the agent said which props
 *     are required, and the served contract keeps saying it (ggui#1432);
 *     an entry's own explicit `required` wins, and a name with no entry
 *     lifts nothing;
 *   - strips keys the protocol's `.strict()` spec schemas would reject,
 *     keeping only the allowed keys at each wrapper / entry level;
 *   - canonicalizes every inner JSON Schema via {@link normalizeSchema}
 *     (the same normalizer `buildContract` runs on synth output).
 *
 * The caller (`ensureConformingContract`) re-lints the result: if it now
 * passes the gate, the draft is returned WITHOUT ever calling the LLM.
 * Semantic deficiencies (wrong placement, missing data surface, dangling
 * cross-refs) are deliberately out of scope — those still go to the
 * repair loop, where reasoning earns its keep.
 */

import {
  actionEntrySchema,
  agentToolEntrySchema,
  contextEntrySchema,
  propEntrySchema,
  propsSpecSchema,
  streamChannelEntrySchema,
} from '@ggui-ai/protocol';
import { normalizeSchema } from './normalize-schema.js';

// Allowed-key sets are DERIVED from the protocol's `.strict()` spec
// schemas (schemas/data-contract.ts) — never hand-copied. A hand-copied
// mirror drifts the day the schema grows: `oneShot` joined
// `actionEntrySchema` on 2026-09-15 (ggui#1108) and a stale mirror here
// stripped it from every repaired draft for eleven days (ggui#1421).
// Stripping anything outside these sets is safe: the strict schema
// would reject it as CTR_SHAPE_UNRECOGNIZED_KEYS.
const PROPS_WRAPPER_KEYS: ReadonlySet<string> = new Set(Object.keys(propsSpecSchema.shape));
const PROP_ENTRY_KEYS: ReadonlySet<string> = new Set(Object.keys(propEntrySchema.shape));
const CONTEXT_ENTRY_KEYS: ReadonlySet<string> = new Set(Object.keys(contextEntrySchema.shape));
const ACTION_ENTRY_KEYS: ReadonlySet<string> = new Set(Object.keys(actionEntrySchema.shape));
const STREAM_ENTRY_KEYS: ReadonlySet<string> = new Set(Object.keys(streamChannelEntrySchema.shape));
const AGENT_TOOL_KEYS: ReadonlySet<string> = new Set(Object.keys(agentToolEntrySchema.shape));
/** Inner keys of an {@link AgentToolEntry.toolInfo} (the MCP descriptor). */
const AGENT_TOOL_INFO_KEYS: ReadonlySet<string> = new Set(
  Object.keys(agentToolEntrySchema.shape.toolInfo.shape),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep only `allowed` keys; normalize the schema-bearing fields named
 *  in `schemaFields`. Non-record entries pass through untouched. */
function cleanEntry(
  entry: unknown,
  allowed: ReadonlySet<string>,
  schemaFields: readonly string[],
): unknown {
  if (!isRecord(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!allowed.has(key)) continue; // strip the illegal key
    out[key] =
      schemaFields.includes(key) && value !== undefined
        ? normalizeSchema(value)
        : value;
  }
  return out;
}

/** Apply {@link cleanEntry} across a `Record<name, entry>` spec map. */
function cleanEntryMap(
  map: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  schemaFields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(map)) {
    out[name] = cleanEntry(entry, allowed, schemaFields);
  }
  return out;
}

/** Clean a single `AgentToolEntry`: keep only the allowed outer keys
 *  ({@link AGENT_TOOL_KEYS}), then clean the nested `toolInfo` to its
 *  inner keys ({@link AGENT_TOOL_INFO_KEYS}) and normalize
 *  `toolInfo.inputSchema` / `toolInfo.outputSchema` so the `.strict()`
 *  schema doesn't reject a stray nested key. Non-record entries pass
 *  through untouched. */
function cleanAgentToolEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!AGENT_TOOL_KEYS.has(key)) continue; // strip the illegal outer key
    out[key] =
      key === 'toolInfo'
        ? cleanEntry(value, AGENT_TOOL_INFO_KEYS, ['inputSchema', 'outputSchema'])
        : value;
  }
  return out;
}

/** Apply {@link cleanAgentToolEntry} across the agent-tool catalog. */
function cleanAgentToolMap(
  map: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(map)) {
    out[name] = cleanAgentToolEntry(entry);
  }
  return out;
}

/**
 * Return a structurally-normalized copy of an untrusted draft: illegal
 * wrapper/entry keys stripped, inner schemas canonicalized. Pure — never
 * mutates the input, never throws. Unknown top-level fields ride through
 * (the top-level DataContract schema is `.passthrough()`); only the
 * `.strict()` spec wrappers and entries are cleaned.
 */
/**
 * The prop names a wrapper-level `propsSpec.required: [...]` will be
 * lifted onto by {@link normalizeDraft} (ggui#1432): each listed name that
 * has an entry and whose entry declares no `required` of its own, in the
 * wrapper's order and de-duplicated. A ghost name (no entry) and an entry
 * with its own word are skipped, exactly as the lift skips them. Empty when
 * nothing lifts.
 *
 * One source of truth for the lift and for the finding that reports it
 * (ggui#1454): the gate's `CTR_SHAPE_UNRECOGNIZED_KEYS` at `propsSpec` is
 * a repair here, not a refusal, and its message says which entries gained
 * `required: true`.
 */
export function liftedRequiredNames(draft: unknown): readonly string[] {
  if (!isRecord(draft) || !isRecord(draft['propsSpec'])) return [];
  const wrapper = draft['propsSpec'];
  if (!Array.isArray(wrapper['required']) || !isRecord(wrapper['properties'])) return [];
  const entries = wrapper['properties'];
  // De-duplicated: a name the wrapper lists twice lifts once and is reported once.
  return [...new Set(wrapper['required'].filter((name): name is string => typeof name === 'string'))].filter((name) => {
    const entry = entries[name];
    return isRecord(entry) && entry['required'] === undefined;
  });
}

export function normalizeDraft(draft: unknown): unknown {
  if (!isRecord(draft)) return draft;
  const out: Record<string, unknown> = { ...draft };

  // propsSpec wrapper: keep {description, properties}; clean each PropEntry.
  // A wrapper-level `required: [...]` is the agent's declaration in JSON
  // Schema's spelling — lift it into the listed entries before the key
  // goes, so the served contract still says which props are required.
  if (isRecord(out['propsSpec'])) {
    const wrapper = out['propsSpec'];
    const ps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(wrapper)) {
      if (PROPS_WRAPPER_KEYS.has(key)) ps[key] = value;
    }
    if (isRecord(ps['properties'])) {
      const cleaned = cleanEntryMap(ps['properties'], PROP_ENTRY_KEYS, ['schema']);
      // The same selection `liftedRequiredNames` reports (one source of truth);
      // `cleanEntryMap` keeps an entry's own `required`, so the test is the same on
      // the cleaned map as on the raw one.
      for (const name of liftedRequiredNames(draft)) {
        const entry = cleaned[name];
        if (!isRecord(entry)) continue;
        cleaned[name] = { ...entry, required: true };
      }
      ps['properties'] = cleaned;
    }
    out['propsSpec'] = ps;
  }

  if (isRecord(out['contextSpec'])) {
    out['contextSpec'] = cleanEntryMap(out['contextSpec'], CONTEXT_ENTRY_KEYS, [
      'schema',
    ]);
  }
  if (isRecord(out['actionSpec'])) {
    out['actionSpec'] = cleanEntryMap(out['actionSpec'], ACTION_ENTRY_KEYS, [
      'schema',
    ]);
  }
  if (isRecord(out['streamSpec'])) {
    out['streamSpec'] = cleanEntryMap(out['streamSpec'], STREAM_ENTRY_KEYS, [
      'schema',
    ]);
  }
  if (isRecord(out['agentCapabilities'])) {
    const ac = out['agentCapabilities'];
    if (isRecord(ac['tools'])) {
      out['agentCapabilities'] = {
        ...ac,
        tools: cleanAgentToolMap(ac['tools']),
      };
    }
  }

  return out;
}
