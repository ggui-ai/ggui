/**
 * One-line, paraphrase-stable summary of a `DataContract` shape.
 *
 * Two consumers share this string:
 *   1. **Embedding input** — concatenated with the intent prose
 *      before bge-small embedding. The structured summary anchors
 *      retrieval to slot/action names that survive prose
 *      paraphrase, while the prose half feeds bge-small's
 *      topic-similarity awareness. Hybrid input.
 *   2. **LLM rerank prompt** — shown to Haiku alongside the user's
 *      query so the judge has the structural context it needs to
 *      decide match-vs-no-match.
 *
 * Putting both consumers on the same string is load-bearing: if the
 * embedded vector and the prompt-shown summary diverged, we'd get
 * "RAG retrieved candidate X, but the prompt shows a different
 * summary" — the judge would lose context the index used to
 * retrieve. One source of truth eliminates that drift class.
 *
 * Format (deterministic):
 *
 *     slots=<name:type,...>;
 *     actions=<name(payloadFields)?,...>; streams=<name,...>;
 *     props=<name:type,...>
 *
 * Format details:
 *   - slots: `name:type` (e.g. `count:number,draft:string`). Bare
 *     `name` when the schema has no `type` field.
 *   - actions: `name(field1,field2,...)` when the action's schema has
 *     non-empty `properties`; bare `name` when payload-less. This
 *     differentiation is load-bearing: a `sendChip` action with
 *     `{chipText: string}` payload must NOT match a payload-less
 *     `sendChip` cached blueprint, since the runtime-emitted action
 *     would arrive with `data: {}` instead of `data: {chipText}` —
 *     the agent loses the user's input. Surfacing payload field names
 *     in the summary lets the judge see this distinction.
 *   - streams: bare `name` (channel schemas vary a lot and are usually
 *     emitted by the agent later; including them adds noise).
 *   - props: `name:type` (initial render shape).
 *
 * Empty slots/actions/streams/props collapse to `∅`.
 */
import type { DataContract } from '../types/data-contract.js';

/** Stable summary of `contract` for embedding + rerank input. */
export function summarizeContract(
  contract: DataContract | undefined,
): string {
  if (!contract) return 'slots=∅; actions=∅; streams=∅';

  const slots = contract.contextSpec
    ? Object.entries(contract.contextSpec)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => {
          const t = readType((entry as { schema?: unknown }).schema);
          return t ? `${name}:${t}` : name;
        })
        .join(',')
    : '';

  const actions = contract.actionSpec
    ? Object.entries(contract.actionSpec)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => {
          const fields = readPayloadFields(
            (entry as { schema?: unknown }).schema,
          );
          return fields ? `${name}(${fields})` : name;
        })
        .join(',')
    : '';

  const streams = contract.streamSpec
    ? Object.keys(contract.streamSpec).sort().join(',')
    : '';

  const props = contract.propsSpec?.properties
    ? Object.entries(contract.propsSpec.properties)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => {
          const t = readType((entry as { schema?: unknown }).schema);
          return t ? `${name}:${t}` : name;
        })
        .join(',')
    : '';

  const parts: string[] = [];
  parts.push(`slots=${slots || '∅'}`);
  parts.push(`actions=${actions || '∅'}`);
  parts.push(`streams=${streams || '∅'}`);
  if (props) parts.push(`props=${props}`);
  return parts.join('; ');
}

function readType(schema: unknown): string | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const t = (schema as { type?: unknown }).type;
  return typeof t === 'string' ? t : null;
}

/** Sorted comma-joined property names for an action's payload schema,
 *  or `null` when the action takes no payload. Empty `properties` →
 *  null (payload-less). */
function readPayloadFields(schema: unknown): string | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const props = (schema as { properties?: unknown }).properties;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return null;
  }
  const keys = Object.keys(props as Record<string, unknown>);
  if (keys.length === 0) return null;
  return keys.sort().join(',');
}
