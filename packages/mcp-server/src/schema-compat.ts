/**
 * Schema compatibility check — verifies that a GguiSession's declared
 * `actionSpec` / `streamSpec` schemas line up with the input/output
 * schemas of the tools they reference. Wired at two canonical check
 * points: `ggui_render` validation (defensive, fires when the
 * generator eventually emits contract) and blueprint registration
 * (the console blueprint-try endpoint — the real-world site where a
 * GguiSession with pre-declared `actionSpec` / `streamSpec` and tool
 * refs lands on the server).
 *
 * **Algorithmic primitive** lives in `@ggui-ai/protocol`:
 *
 *   - `isSchemaSubset(superset, subset)` answers "can every value
 *     subset accepts also pass superset?".
 *   - `zodToJsonSchema(...)` converts a tool's ZodRawShape
 *     `inputSchema` / `outputSchema` to the JsonSchema shape the
 *     subset algorithm consumes.
 *
 * **What this module adds.** A small layer that walks a GguiSession's
 * `actionSpec` + `streamSpec`, resolves each declared `tool` ref
 * against a toolName → ZodRawShape registry, runs the appropriate
 * subset check, and reports a stable {@link SchemaCompatReport}. The
 * caller (console endpoint, render handler — later) decides whether
 * a non-empty report should throw, warn, or be ignored per the
 * {@link SchemaCompatMode} policy flag.
 *
 * **Direction semantics (load-bearing).**
 *
 *   - For `actionSpec[name].schema` + `tool`: the action's payload
 *     is sent INTO the tool, so the action schema must be a subset
 *     of the tool's `inputSchema`. Compat relation:
 *     `isSchemaSubset(toolInputSchema, actionSchema)`.
 *   - For `streamSpec[channel].schema` + `tool`: the tool's return
 *     value is emitted OUT on the channel. Every value the tool
 *     returns MUST be accepted by the channel schema (otherwise a
 *     tool-fired refresh would emit a payload that subscribers
 *     reject). The channel schema is therefore the PERMISSIVE side
 *     and the tool's return is the restricted side. Compat relation:
 *     `isSchemaSubset(channelSchema, toolReturnSchema)` — i.e.
 *     "every toolReturn-accepted value is also channelSchema-
 *     accepted".
 *
 *     Note: the `StreamChannelEntry.schema` docstring phrases this
 *     as "the tool's returns MUST be a superset of channel schema".
 *     That historical phrasing is author-facing and slightly
 *     misleading if read literally as set-theoretic superset of
 *     accepted-values; the semantic intent is the one encoded here
 *     — EVERY tool return passes channel validation.
 */
import type { ZodRawShape } from 'zod';
import {
  isSchemaSubset,
  zodToJsonSchema,
  type SubsetViolation,
  type ActionSpec,
  type StreamSpec,
} from '@ggui-ai/protocol';

/**
 * Stance the host takes when a check surfaces violations.
 *
 *   - `'reject'` (default) — throw {@link SchemaCompatError} so the
 *     containing request fails before the render commits /
 *     before the blueprint registers. The canonical enforcement
 *     posture for launch.
 *   - `'warn'` — return the report without throwing. The caller is
 *     expected to log the violations on an observable surface
 *     (logger, telemetry). Used during migration windows when an
 *     operator wants to surface mismatches without breaking
 *     existing flows.
 *   - `'off'` — skip the check entirely. Test convenience;
 *     explicit opt-out.
 */
export type SchemaCompatMode = 'reject' | 'warn' | 'off';

/**
 * Default mode applied when the host does not override. Matches the
 * Item 5 brief default.
 */
export const DEFAULT_SCHEMA_COMPAT_MODE: SchemaCompatMode = 'reject';

/**
 * Per-action or per-channel compat finding. Preserves the underlying
 * subset violations so downstream messaging can surface any level of
 * detail the operator wants.
 */
export interface SchemaCompatFinding {
  /**
   * Which spec side produced this finding. `'action'` for an
   * `actionSpec[name]` tool ref; `'stream'` for a
   * `streamSpec[channel].tool` ref. Consumers can branch on this
   * when rendering the cause.
   */
  readonly kind: 'action' | 'stream';
  /** Action name or channel name. */
  readonly specName: string;
  /** Tool name the spec referenced. */
  readonly toolName: string;
  /** One of:
   *   - `'tool-not-found'`  — the ref's tool is not registered on
   *     the composed handler set. (Author bug — matching the
   *     existing `TOOL_NOT_FOUND` contract semantics, but surfaced
   *     before any envelope reaches the agentic loop.)
   *   - `'schema-mismatch'` — the subset check failed with at least
   *     one violation. See {@link SchemaCompatFinding.violations}.
   */
  readonly reason: 'tool-not-found' | 'schema-mismatch';
  /**
   * Whether this finding blocks the render (`'error'`) or is purely
   * advisory (`'warn'`). Defaults to error severity when omitted — the
   * throw gate treats any finding lacking `severity: 'warn'` as a
   * hard error. An action `nextStep` tool-not-found is tagged `'warn'`
   * because `nextStep` is a documented HINT the agent owns and ggui
   * never dispatches; an unresolved one must not block the render.
   */
  readonly severity?: 'error' | 'warn';
  /** Subset violations carried through for rich error rendering.
   *  Empty array when `reason: 'tool-not-found'`. */
  readonly violations: readonly SubsetViolation[];
}

/**
 * Aggregate compat report. A `compatible: true` report is the
 * happy path — the caller commits its side effect. A
 * `compatible: false` report enumerates every failing spec entry.
 */
export interface SchemaCompatReport {
  readonly compatible: boolean;
  readonly findings: readonly SchemaCompatFinding[];
}

/**
 * Narrow shape of what the check helper needs from each registered
 * tool. Satisfied by `SharedHandler<ZodRawShape, ZodRawShape>` — the
 * two schema fields are the only consumed inputs.
 */
export interface ToolSchemaRef {
  readonly name: string;
  readonly inputSchema: ZodRawShape;
  readonly outputSchema: ZodRawShape;
}

/**
 * Narrow shape of the GguiSession subset the checker consumes — the
 * two spec fields PLUS the contract's own tool catalog. Accepts any
 * object carrying them, so both `@ggui-ai/protocol::GguiSession` and
 * the console endpoint's manifest contract shape work without a cast.
 *
 * `agentCapabilities.tools` is the contract author's declared catalog
 * of every tool the contract references. Tools listed here but NOT
 * registered on the composing server are CROSS-MCP references — the
 * agent intends to call them on a different MCP server in its
 * toolbox. The compat checker accepts these without a server-side
 * schema check (we can't validate a remote server's tool schema from
 * here; the agent owns the cross-MCP call).
 */
export interface GguiSessionContractShape {
  readonly actionSpec?: ActionSpec;
  readonly streamSpec?: StreamSpec;
  readonly agentCapabilities?: {
    readonly tools?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Thrown when `schemaCompatCheck: 'reject'` surfaces at least one
 * finding. Carries the full {@link SchemaCompatReport} so callers
 * can log / surface the detail beyond the `message` string.
 */
export class SchemaCompatError extends Error {
  readonly report: SchemaCompatReport;
  constructor(report: SchemaCompatReport, context: string) {
    super(formatReport(report, context));
    this.name = 'SchemaCompatError';
    this.report = report;
  }
}

/**
 * Check a GguiSession's `actionSpec` / `streamSpec` entries against
 * the tool registry. See {@link SchemaCompatMode} for policy
 * semantics.
 *
 * Returns a {@link SchemaCompatReport}. When `mode === 'reject'`
 * AND findings exist, throws {@link SchemaCompatError} instead —
 * the report is still available on `error.report`.
 *
 * `context` is a short string naming the call site (e.g.
 * `"ggui_render"`, `"console blueprint-try:<blueprintId>"`). Shows
 * up in thrown error messages so an operator reading logs sees
 * which ingress surfaced the mismatch.
 */
export function checkRenderSchemaCompat(
  render: GguiSessionContractShape,
  tools: Iterable<ToolSchemaRef>,
  mode: SchemaCompatMode,
  context: string,
): SchemaCompatReport {
  if (mode === 'off') {
    return { compatible: true, findings: [] };
  }
  // Build a one-pass name → tool map. Callers pass the composed
  // handler list; the map is cheap to rebuild per-check because
  // the input tool list is typically <50 entries.
  const byName = new Map<string, ToolSchemaRef>();
  for (const t of tools) byName.set(t.name, t);

  // Cross-MCP escape hatch: tools the contract author declared in
  // `agentCapabilities.tools` are accepted even when they don't
  // exist in the server's registry — the agent intends to call them
  // on a different MCP server in its toolbox. We can't validate
  // their inputSchema/outputSchema from here (no access to the
  // remote tool definition); cross-MCP shape compatibility is the
  // agent's responsibility. Same-server tools still get the full
  // server-driven subset check below.
  const contractDeclaredTools = new Set<string>(
    Object.keys(render.agentCapabilities?.tools ?? {}),
  );

  const findings: SchemaCompatFinding[] = [];

  // actionSpec — each action.tool's inputSchema must be a superset
  // of action.schema. A void action (no schema) paired with a tool
  // that requires input is flagged specifically: the wire sends
  // nothing, the tool demands something, so the compat relation is
  // "empty-object ⊆ tool-input" — which fails whenever the tool has
  // required fields.
  const actionSpec = render.actionSpec ?? {};
  for (const [actionName, entry] of Object.entries(actionSpec)) {
    if (!entry || typeof entry !== 'object') continue;
    const toolName = entry.nextStep;
    if (typeof toolName !== 'string' || toolName.length === 0) continue;

    const tool = byName.get(toolName);
    if (!tool) {
      // Tool not in server registry. Check the cross-MCP escape
      // hatch — if the contract declared it in agentCapabilities.tools,
      // skip the server-side check entirely (agent owns cross-MCP
      // validation).
      if (contractDeclaredTools.has(toolName)) continue;
      findings.push({
        kind: 'action',
        specName: actionName,
        toolName,
        reason: 'tool-not-found',
        // Advisory: `nextStep` is a documented HINT the agent owns and
        // ggui never dispatches, so an unresolved one must not block
        // the render. Warn-only — the throw gate skips it.
        severity: 'warn',
        violations: [],
      });
      continue;
    }
    const toolInput = zodToJsonSchema(tool.inputSchema);
    // Void action (no schema) — model the wire shape as the empty
    // object schema. The subset check reports required-field
    // violations only — an unconstrained tool with no required
    // fields stays compatible.
    const actionSchema = entry.schema ?? {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    };
    const result = isSchemaSubset(toolInput, actionSchema);
    if (!result.compatible) {
      findings.push({
        kind: 'action',
        specName: actionName,
        toolName,
        reason: 'schema-mismatch',
        violations: result.violations,
      });
    }
  }

  // streamSpec — each channel.tool's outputSchema must be a superset
  // of channel.schema (inverted direction from actions).
  const streamSpec = render.streamSpec ?? {};
  for (const [channelName, entry] of Object.entries(streamSpec)) {
    if (!entry || typeof entry !== 'object') continue;
    const toolName = entry.tool;
    if (typeof toolName !== 'string' || toolName.length === 0) continue;
    const channelSchema = entry.schema;
    if (!channelSchema) continue;

    const tool = byName.get(toolName);
    if (!tool) {
      // Cross-MCP escape hatch — symmetric with the actionSpec arm.
      if (contractDeclaredTools.has(toolName)) continue;
      // stream tool-not-found stays error — spec defers the stream downgrade (Phase 2 scope = action nextStep only).
      findings.push({
        kind: 'stream',
        specName: channelName,
        toolName,
        reason: 'tool-not-found',
        violations: [],
      });
      continue;
    }
    const toolOutput = zodToJsonSchema(tool.outputSchema);
    // Direction: every tool-returned value must be accepted by the
    // channel schema. Channel is the superset / permissive side,
    // tool-return is the restricted side.
    const result = isSchemaSubset(channelSchema, toolOutput);
    if (!result.compatible) {
      findings.push({
        kind: 'stream',
        specName: channelName,
        toolName,
        reason: 'schema-mismatch',
        violations: result.violations,
      });
    }
  }

  const report: SchemaCompatReport = {
    compatible: findings.length === 0,
    findings,
  };

  if (mode === 'reject' && hasErrorFinding(report)) {
    throw new SchemaCompatError(report, context);
  }
  return report;
}

/**
 * Does this report carry at least one finding that should BLOCK the
 * render? A finding blocks unless it is explicitly advisory
 * (`severity: 'warn'`) — i.e. anything lacking `severity: 'warn'`
 * counts as a hard error (default-error semantics). The single
 * source of truth for the throw gate, shared by the internal
 * `'reject'`-mode gate above AND any external host that runs the
 * check in `'warn'` mode and owns its own enforcement (e.g. the
 * cloud pod's `ggui_render`). Keeping ONE predicate guarantees the
 * OSS and pod gates can never silently diverge.
 */
export function hasErrorFinding(report: SchemaCompatReport): boolean {
  return report.findings.some((f) => f.severity !== 'warn');
}

/**
 * Format a report into a human-readable message suitable for a
 * thrown error or a log line. Output is deterministic — sorted
 * by `kind` then `specName` — so tests can pattern-match on the
 * exact string without ordering flakes.
 */
function formatReport(report: SchemaCompatReport, context: string): string {
  if (report.compatible) {
    return `${context}: SCHEMA_MISMATCH_ERROR (no findings — internal error)`;
  }
  const sorted = [...report.findings].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.specName < b.specName ? -1 : a.specName > b.specName ? 1 : 0;
  });
  const lines = sorted.map((f) => {
    if (f.reason === 'tool-not-found') {
      return `- ${f.kind} "${f.specName}" references tool "${f.toolName}" which is not registered`;
    }
    const firstViol = f.violations[0];
    const suffix = firstViol
      ? ` — ${firstViol.message}` +
        (f.violations.length > 1
          ? ` (${f.violations.length - 1} more violation${f.violations.length > 2 ? 's' : ''})`
          : '')
      : '';
    return `- ${f.kind} "${f.specName}" (tool "${f.toolName}") — schema mismatch${suffix}`;
  });
  return [
    `${context}: SCHEMA_MISMATCH_ERROR — ${report.findings.length} finding${report.findings.length > 1 ? 's' : ''}`,
    ...lines,
  ].join('\n');
}
