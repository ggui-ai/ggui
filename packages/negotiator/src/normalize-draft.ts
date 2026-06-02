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

import { normalizeSchema } from './normalize-schema.js';

// Allowed-key sets mirror the protocol `.strict()` schemas
// (schemas/data-contract.ts). Stripping anything outside these is safe:
// the strict schema would reject it as CTR_SHAPE_UNRECOGNIZED_KEYS.
const PROPS_WRAPPER_KEYS = new Set(['description', 'properties']);
const PROP_ENTRY_KEYS = new Set([
  'description',
  'schema',
  'required',
  'default',
  'example',
  'sourceTool',
]);
const CONTEXT_ENTRY_KEYS = new Set([
  'description',
  'schema',
  'default',
  'debounceMs',
  'example',
]);
const ACTION_ENTRY_KEYS = new Set([
  'description',
  'label',
  'schema',
  'example',
  'icon',
  'confirm',
  'nextStep',
]);
const STREAM_ENTRY_KEYS = new Set(['description', 'schema', 'source']);
const AGENT_TOOL_KEYS = new Set(['serverInfo', 'toolInfo', 'usage', 'example']);
/** Inner keys of an {@link AgentToolEntry.toolInfo} (the MCP descriptor). */
const AGENT_TOOL_INFO_KEYS = new Set([
  'inputSchema',
  'description',
  'outputSchema',
]);

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
export function normalizeDraft(draft: unknown): unknown {
  if (!isRecord(draft)) return draft;
  const out: Record<string, unknown> = { ...draft };

  // propsSpec wrapper: keep {description, properties}; clean each PropEntry.
  if (isRecord(out['propsSpec'])) {
    const ps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out['propsSpec'])) {
      if (PROPS_WRAPPER_KEYS.has(key)) ps[key] = value;
    }
    if (isRecord(ps['properties'])) {
      ps['properties'] = cleanEntryMap(ps['properties'], PROP_ENTRY_KEYS, [
        'schema',
      ]);
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
