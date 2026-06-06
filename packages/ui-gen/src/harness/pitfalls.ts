// Common Pitfalls registry.
//
// Each entry is a rule the LLM should know up-front — it prevents an
// error class that benchmarking has flagged as costing iterations. Keep
// entries tight: the line that appears in the system prompt is the
// entry's `rule`. Everything else is provenance + audit metadata.
//
// Growth path: when a benchmark run surfaces a new recurring error
// class, add a pitfall entry with a short `foundIn` provenance note.
//
// The rules are rendered in the system prompt's `## Common Pitfalls`
// block. Injection point: runtime.ts::buildSystemPrompt.

export interface Pitfall {
  /** Short id for logs / deduping. */
  readonly id: string;
  /** The one-line rule shown to the LLM. Uses backtick code spans. */
  readonly rule: string;
  /** Why this exists (developer note, not shown to LLM). */
  readonly why: string;
  /** Regex/substring the error message typically contains — used by
   *  future analyzers to auto-detect "this pitfall was violated". */
  readonly errorPattern?: string | RegExp;
  /** Source: which experiment surfaced this. */
  readonly foundIn: string;
}

/**
 * Live registry. Append-only — never remove entries without a bench
 * that shows the rule no longer applies. Order doesn't matter (we
 * render alphabetically by id at emit time for determinism).
 */
export const PITFALLS: readonly Pitfall[] = [
  {
    id: "stack-row-padding",
    rule: "`Stack`/`Row` do NOT accept `padding` — wrap the children in `<Box padding=\"...\">`.",
    why: "Stack and Row are flex containers; padding would violate the gap-based spacing model.",
    foundIn: "pre-#61 baseline",
  },
  {
    id: "align-enum",
    rule: "`align` accepts only `'start' | 'center' | 'end' | 'stretch'` (NEVER `flex-end`/`flex-start`).",
    why: "Components use semantic enums, not raw CSS flex values.",
    foundIn: "pre-#61 baseline",
  },
  {
    id: "justify-enum",
    rule: "`justify` accepts only `'start' | 'center' | 'end' | 'between' | 'around' | 'evenly'`.",
    why: "Semantic enum, not raw CSS flex values.",
    foundIn: "pre-#61 baseline",
  },
  {
    id: "badge-variant",
    rule: "`Badge variant` accepts `'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info'`.",
    why: "Badge has a fixed enum — LLMs sometimes invent variants like 'danger' or 'red'.",
    foundIn: "pre-#61 baseline",
  },
  {
    id: "imports-preimported",
    rule: "All design-system primitives are pre-imported by the boilerplate — do NOT add imports unless absolutely needed.",
    why: "Duplicate imports cause TS errors; the boilerplate already resolves the full primitive surface.",
    foundIn: "pre-#61 baseline",
  },
  // ─── Provisional pitfalls considered + retired by exp66 n=6 factorial ───
  //
  // The 3 "new" pitfalls below were added in exp61 after OpenAI kanban
  // error mining: useState typing, stream null-guard promotion, null-vs-
  // undefined. Individual smokes suggested they helped, but the rigorous
  // exp66 factorial (n=6, 3×2 pitfalls × batch-fix) showed they REGRESS
  // blended ms by +8.8s (legacy5 29.3s → full8 38.1s, batch-off).
  //
  // Mechanism: attention dilution. Each added rule shifts LLM attention
  // away from the 5 legacy pitfalls that catch the real error classes.
  // Plus, "ALWAYS type useState" is too categorical — LLMs over-annotate
  // in contexts that didn't need it.
  //
  // Retired from default. Kept as dormant comments so the next person
  // investigating the same error classes knows this path was tried.
  //
  //   usestate-type-annotation: "ALWAYS type useState: useState<T[]>([])..."
  //   stream-latest-null-guard: "useStream().latest is T|null — always null-guard..."
  //   null-vs-undefined:         "Use undefined for optional props, not null..."
  //
  // If a future bench mines a new provider/fixture combination that
  // reliably violates one of these, revisit with a targeted profile,
  // not a global rule.
];

/**
 * Render the pitfalls as the Common Pitfalls block of the system prompt.
 * Called by runtime.ts::buildSystemPrompt. Deterministic ordering (by id)
 * so prompt-cache prefix stays stable across runs.
 */
export function renderPitfallsBlock(): string {
  // Experiment toggles:
  //   GGUI_PITFALLS=off     — suppress the entire Common Pitfalls block.
  //                           Tests whether any rules are load-bearing at all.
  //   GGUI_NEW_PITFALLS=off — keep only the 5 legacy pitfalls, drop the
  //                           3 added in #61 (useState typing, stream null
  //                           guard, null vs undefined). Tests whether the
  //                           new rules are a real win or noise.
  const disableAll =
    typeof process !== "undefined" && process.env?.GGUI_PITFALLS === "off";
  if (disableAll) return "";
  const disableNew = typeof process !== "undefined" && process.env?.GGUI_NEW_PITFALLS === "off";
  const LEGACY_IDS = new Set([
    // Pre-exp61: original Common Pitfalls (5 rules)
    "stack-row-padding",
    "align-enum",
    "justify-enum",
    "badge-variant",
    "imports-preimported",
  ]);
  const entries = [...PITFALLS]
    .filter((p) => !disableNew || LEGACY_IDS.has(p.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const bullets = entries.map((p) => `- ${p.rule}`).join("\n");
  return `## Common Pitfalls (each costs an iteration — avoid them up front)\n${bullets}`;
}
