/**
 * Deterministic {@link DataContract} derivation from MCP tool schemas.
 *
 * Given a primary data tool (with `outputSchema`) and optional action tools
 * (with `inputSchema`), produces a complete contract — no LLM needed.
 *
 * This is the Screen Designer's Tier 1 fast path: when a ggui-first-party MCP
 * server ships native `outputSchema` on every tool, the contract falls out of
 * the schema automatically. The agent supplies the wiring (data tool + action
 * tools); ggui derives the rendering contract.
 *
 * Tier 2 (learned `generatedOutputSchema`) uses the same deriver — the caller
 * passes the learned schema instead of the native one.
 */
import type {
  ActionEntry,
  ActionSpec,
  DataContract,
  JsonSchema,
  PropEntry,
  PropsSpec,
} from "../types/data-contract.js";

/** An MCP tool spec, as it appears in tools/list (subset we care about). */
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface DeriveContractInput {
  /** Display name of the owning server, used to build the intent string. */
  serverName: string;
  /** Primary tool — its outputSchema becomes the component's props. */
  dataTool: McpToolSpec;
  /** Optional MCP tools the UI hints at on its gestures. Each becomes an ActionEntry with `nextStep` set to the tool name (advisory hint the agent reads on `ggui_consume` to decide which tool to call next). */
  actionTools?: McpToolSpec[];
  /** Optional intent override. Default: derived from serverName + dataTool.name. */
  intent?: string;
  /** Optional tool-name prefix to strip when generating action keys and labels.
   * Only strips when the tool name actually starts with `${toolPrefix}`. Default: none —
   * the full tool name is used. Supply this only for servers that prefix their tools
   * (e.g. `toolPrefix: "gmail_"` turns `gmail_search_messages` into `searchMessages`).
   * Bare-named tools (`get_task`, `complete_task`) must NOT use this. */
  toolPrefix?: string;
}

/**
 * Build a DataContract from native MCP tool schemas.
 *
 * Behavior:
 * - `intent` — "<serverName> — <humanized tool verb>" unless overridden.
 * - `props` — each top-level property of dataTool.outputSchema becomes a PropEntry.
 *   If outputSchema is not an object schema, a single `data` prop wraps the whole thing.
 * - `actions` — one ActionEntry per actionTool, with `nextStep` set to the MCP tool
 *   name (advisory hint) and `schema` set to the tool's inputSchema (if present).
 *
 * Pure — deterministic given identical input.
 */
export function deriveContract(input: DeriveContractInput): DataContract {
  const { dataTool, actionTools = [], toolPrefix } = input;

  // `intent` is not a contract field. `input.intent` and `serverName`
  // stay on the input so callers can describe the contract for their
  // own purposes (logging, embedding-search keys); the returned
  // contract carries no intent of its own. See {@link DataContract}.
  const contract: DataContract = {};

  const props = propsFromOutputSchema(dataTool.outputSchema, dataTool.description);
  if (props) contract.propsSpec = props;

  if (actionTools.length > 0) {
    contract.actionSpec = actionsFromTools(actionTools, toolPrefix);
  }

  return contract;
}

/** Convert an outputSchema into a PropsSpec. */
export function propsFromOutputSchema(
  outputSchema: JsonSchema | undefined,
  description?: string,
): PropsSpec | undefined {
  if (!outputSchema) return undefined;

  // Object schema — one PropEntry per top-level property.
  if (outputSchema.type === "object" && outputSchema.properties) {
    const required = new Set(outputSchema.required ?? []);
    const properties: Record<string, PropEntry> = {};
    for (const [key, propSchema] of Object.entries(outputSchema.properties)) {
      const entry: PropEntry = {
        schema: propSchema,
        required: required.has(key),
      };
      if (propSchema.description) entry.description = propSchema.description;
      if (propSchema.example !== undefined) entry.example = propSchema.example;
      properties[key] = entry;
    }
    const spec: PropsSpec = { properties };
    if (description) spec.description = description;
    return spec;
  }

  // Non-object schema (array, primitive, anyOf) — wrap as single `data` prop.
  const entry: PropEntry = { schema: outputSchema, required: true };
  if (outputSchema.description) entry.description = outputSchema.description;
  const spec: PropsSpec = { properties: { data: entry } };
  if (description) spec.description = description;
  return spec;
}

/** Convert a list of action-tools into an ActionSpec, one entry per tool.
 * Collisions (two tools camelCase-ing to the same key) are resolved by appending
 * a numeric suffix — the raw tool name is always preserved on the
 * entry's `nextStep` hint. */
export function actionsFromTools(actionTools: McpToolSpec[], toolPrefix?: string): ActionSpec {
  const actions: Record<string, ActionEntry> = {};
  for (const tool of actionTools) {
    let actionKey = camelKey(stripPrefix(tool.name, toolPrefix));
    if (actionKey in actions) {
      // Fall back to the full tool name (camelCased) before disambiguating with a suffix.
      const full = camelKey(tool.name);
      actionKey = full in actions ? uniqueKey(actions, full) : full;
    }
    const entry: ActionEntry = {
      label: humanizeToolName(tool.name, toolPrefix),
      nextStep: tool.name,
    };
    if (tool.description) entry.description = tool.description;
    if (tool.inputSchema) entry.schema = tool.inputSchema;
    actions[actionKey] = entry;
  }
  return actions;
}

function uniqueKey(existing: Record<string, unknown>, base: string): string {
  let i = 2;
  while (`${base}${i}` in existing) i++;
  return `${base}${i}`;
}

// ────────────────────────── naming helpers ──────────────────────────

/** Humanize a tool name, optionally stripping a known server prefix.
 * `humanizeToolName("gmail_search_messages", "gmail_")` → "Search Messages".
 * `humanizeToolName("get_task")` → "Get Task". */
export function humanizeToolName(name: string, toolPrefix?: string): string {
  const stripped = stripPrefix(name, toolPrefix);
  return stripped
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Strip `toolPrefix` iff `name` starts with it; otherwise return `name` unchanged. */
export function stripPrefix(name: string, toolPrefix?: string): string {
  if (!toolPrefix) return name;
  return name.startsWith(toolPrefix) ? name.slice(toolPrefix.length) : name;
}

/** "search_messages" → "searchMessages". */
export function camelKey(name: string): string {
  const parts = name.split(/[_\-\s]+/).filter(Boolean);
  if (parts.length === 0) return name;
  return parts[0].toLowerCase() +
    parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
}
