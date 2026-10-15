/**
 * Output-schema catalog — an advertised output object MUST NOT be closed
 * (SPEC §7.9 "Advertised output objects", ggui#1333).
 *
 * ## The obligation
 *
 * A host that caches a tool's advertised `outputSchema` at `tools/list` and
 * validates every result's `structuredContent` against it (the MCP TS SDK
 * client does) refuses a result carrying a member the cached schema does not
 * name. So an object anywhere under an advertised `outputSchema` that says
 * `additionalProperties: false` turns every later optional output member —
 * MINOR by VERSION-POLICY §1.2 — into a break for every host that listed
 * tools against the previous release. The advertised document is a
 * projection, not the server's parse: a conforming server still strips what
 * its own shape does not name before a result reaches the wire, so an open
 * advertisement never widens what is sent.
 *
 * ## Why this is a pure-function catalog, graded on data
 *
 * Like `registry-completeness`, this catalog grades DATA: the deployment's
 * served `tools/list` document. There is no transport to drive — the
 * document is what any client already holds after one `listTools` — so the
 * adopter passes it (`toolsList` on `runConformance()`, `--tools-list
 * <file.json>` on the CLI) and every tool that advertises an `outputSchema`
 * becomes one row, failing with the path of every closed object. A tool
 * that advertises no `outputSchema` has no object to be closed and
 * contributes no row.
 *
 * ## Polyglot, decoupled
 *
 * The walk is the whole grader, and it reads JSON Schema, not zod: an
 * adopter on any stack can feed the kit the document their server serves.
 * The cases under `./cases/` are the kit's own unit lane for the walk.
 */

/** One advertised tool, in the kit's own loose vocabulary — only what the walk reads. */
export interface AdvertisedToolView {
  readonly name: string;
  readonly outputSchema?: unknown;
}

/** The served `tools/list` document, as far as this catalog reads it. */
export interface AdvertisedToolsListView {
  readonly tools: readonly AdvertisedToolView[];
}

/**
 * Every `additionalProperties: false` under a JSON Schema document, by path
 * (`$` is the document root; `$.properties.x.items` and so on below it).
 * Empty means open at every depth.
 */
export function closedObjectsIn(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => closedObjectsIn(item, `${path}[${String(i)}]`));
  }
  if (node === null || typeof node !== 'object') return [];
  const closed: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' && value === false) closed.push(path);
    closed.push(...closedObjectsIn(value, `${path}.${key}`));
  }
  return closed;
}

/** One tool whose advertised output object is closed somewhere. */
export interface OutputSchemaViolation {
  /** The tool's name — the row is `output-schema/<name>` in a run. */
  readonly name: string;
  readonly description: string;
  /** Every closed object's path in the advertised `outputSchema`. */
  readonly violations: readonly string[];
}

export interface OutputSchemaConformanceResult {
  /** Tool names whose advertised output object is open at every depth. */
  readonly passed: readonly string[];
  readonly failed: readonly OutputSchemaViolation[];
}

export const OUTPUT_SCHEMA_OPEN_DESCRIPTION =
  'Every object under the advertised outputSchema is open — no `additionalProperties: false` at any depth — so a host caching this schema accepts a later release’s added optional member (SPEC §7.9 "Advertised output objects", ggui#1333).';

/**
 * Grade a served `tools/list` document: one row per tool that advertises an
 * `outputSchema`, failing with every closed object's path.
 */
export function runOutputSchemaConformance(
  list: AdvertisedToolsListView,
): OutputSchemaConformanceResult {
  const passed: string[] = [];
  const failed: OutputSchemaViolation[] = [];
  for (const tool of list.tools) {
    if (tool.outputSchema === undefined) continue;
    const violations = closedObjectsIn(tool.outputSchema);
    if (violations.length === 0) {
      passed.push(tool.name);
    } else {
      failed.push({ name: tool.name, description: OUTPUT_SCHEMA_OPEN_DESCRIPTION, violations });
    }
  }
  return { passed, failed };
}
