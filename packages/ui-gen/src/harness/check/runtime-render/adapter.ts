// packages/ui-gen/src/harness/check/runtime-render/adapter.ts
//
// Adapter: convert RenderCheckResult → EvalIssue[] so runtime-render
// integrates with the rest of the eval pipeline (axisChecks, tierChecks,
// llmEvaluator). Fits the RuntimeRenderCheck interface from harness/types.ts.

import type { EvalIssue } from "../../../evaluation/types-public.js";
import type { RuntimeRenderCheck } from "../../types-public.js";
import {
  RENDER_CHECK_KINDS,
  runRenderCheck,
  type RenderCheckIssue,
  type RenderCheckKind,
  type RunRenderCheckOptions,
} from "./render-check.js";
import { prepareMockupProps } from "./prepare-mockup.js";

/**
 * How one runtime-render check instance runs its isolated worker
 * (ggui#1380). A serving deployment sets the probe's wall-clock bound,
 * worker heap and concurrency here; every field omitted is the evaluation
 * lane's behaviour — the host's default bounds and no concurrency cap.
 */
export interface RuntimeRenderProbeConfig {
  /** Wall-clock bound of one isolated check, ms. Default: the host's (30 000). */
  readonly timeoutMs?: number;
  /** V8 heap cap of the worker, MB. Default: the host's (512). */
  readonly heapMb?: number;
  /**
   * Live workers this instance may have at once. The (K+1)th check waits
   * in FIFO order and spawns only when a slot frees; a check that throws
   * releases its slot. Default: unbounded. Must be a positive integer.
   */
  readonly maxConcurrent?: number;
}

/**
 * K-slot FIFO limiter. `undefined` slots = no limiter (the task runs at
 * once). A slot is released in `finally`, so a rejected task never holds
 * one.
 */
function createSlotLimiter(
  maxConcurrent: number | undefined
): <T>(task: () => Promise<T>) => Promise<T> {
  if (maxConcurrent === undefined) return (task) => task();
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(
      `createRuntimeRenderCheck: maxConcurrent must be a positive integer, got ${maxConcurrent}`
    );
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  };
  const release = (): void => {
    active -= 1;
    const next = waiting.shift();
    if (next !== undefined) next();
  };
  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/** The `runRenderCheck` options a config maps to — `undefined` when no bound is set. */
function toRenderCheckOptions(config: RuntimeRenderProbeConfig): RunRenderCheckOptions | undefined {
  if (config.timeoutMs === undefined && config.heapMb === undefined) return undefined;
  return {
    bounds: {
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.heapMb !== undefined ? { heapMb: config.heapMb } : {}),
    },
  };
}

/**
 * Build a runtime-render check instance. One FIFO limiter per instance;
 * the bounds reach `runRenderCheck` on every run. `createRuntimeRenderCheck()`
 * with no config is {@link DEFAULT_RUNTIME_RENDER_CHECK}'s behaviour.
 */
export function createRuntimeRenderCheck(
  config: RuntimeRenderProbeConfig = {}
): RuntimeRenderCheck {
  const limit = createSlotLimiter(config.maxConcurrent);
  const options = toRenderCheckOptions(config);
  return {
    id: "runtime-render",
    run: async (input) => {
      const { sourceCode, compiledCode, contract, fixtureProps } = input;

      // Nothing to render / no contract surface to verify — the probe has
      // no subject, which is different from the probe failing to run.
      if (compiledCode === null) {
        return { status: "not-applicable", issues: [], reason: "no compiled code" };
      }
      if (!contract) {
        return { status: "not-applicable", issues: [], reason: "no contract surface" };
      }

      const mockup = prepareMockupProps({ contract, fixtureProps });

      // ggui#1380 — the adapter's own clock around the check: every status
      // that reached the check (`ran`, `timed-out`, `infra-skipped`) reports
      // how long it took, so a reader of the probe meta can tell a 2 s probe
      // from a 30 s one on the same status. The two not-applicable returns
      // above carry nothing: nothing ran.
      const t0 = Date.now();
      let result;
      try {
        result = await limit(() =>
          runRenderCheck(
            {
              sourceCode,
              mockupProps: mockup.props,
              contract,
            },
            options
          )
        );
      } catch (e) {
        // Triad audit (2026-04-27): every error that escapes `runRenderCheck`
        // is an INFRA problem — happy-dom import failure, ESM/CJS interop
        // (`Dynamic require of "events"`), bundler name collision (`Window2
        // is not a constructor`), missing `@testing-library/react`, etc.
        // Component-level failures are caught and emitted as `RenderCheckIssue`
        // entries from inside `runRenderCheck`; they don't propagate out.
        //
        // An infra failure must never become an eval issue (the coding
        // agent can't fix the environment — pre-2026-04-27 that phantom
        // issue dragged every score-below-80 cell's eval-fix loop), but it
        // must also never be silent to scoring: ggui#403 found the bench
        // reporting `probe_pass 3/3` on cells where this branch fired on
        // every invocation. The `infra-skipped` status is the No-Silent-
        // Block channel — consumers surface it as did-not-run, never pass.
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[runtime-render] probe skipped — infra failure: ${message}`);
        return { status: "infra-skipped", issues: [], reason: message, elapsedMs: Date.now() - t0 };
      }

      const hostLoad = result.stats.hostLoad;
      const load = hostLoad !== undefined ? { hostLoad } : {};

      // ggui#1299: a check that ran out of wall-clock time is not a verdict on
      // the component. It becomes the `timed-out` status (did-not-run, never a
      // pass, never a crash), never an eval issue — so the coding agent is never
      // told to fix a crash that did not happen.
      if (result.incomplete !== undefined) {
        const { elapsedMs, boundMs } = result.incomplete;
        const loadNote =
          hostLoad !== undefined
            ? `; host load ${hostLoad.start.toFixed(1)} → ${hostLoad.end.toFixed(1)} on ${hostLoad.cores} CPUs`
            : "";
        const reason = `render check did not finish within ${boundMs} ms (stopped at ${elapsedMs} ms)${loadNote}`;
        console.warn(`[runtime-render] probe timed out — ${reason}`);
        // One clock for every status that reached the worker: the adapter's
        // wall-clock around the check. The worker's own reading survives in
        // `reason` ("stopped at N ms").
        return { status: "timed-out", issues: [], reason, elapsedMs: Date.now() - t0, ...load };
      }

      return {
        status: "ran",
        issues: result.issues.map(toEvalIssue).filter((x): x is EvalIssue => x !== null),
        elapsedMs: Date.now() - t0,
        renderMs: result.stats.renderMs,
        ...load,
      };
    },
  };
}

/** The evaluation lane's instance: the host's default bounds, no concurrency cap. */
export const DEFAULT_RUNTIME_RENDER_CHECK: RuntimeRenderCheck = createRuntimeRenderCheck();

/**
 * Map a runtime-render crash reason to a class-specific fix string.
 *
 * The default fix ("add null guards on optional props…") is too generic
 * for the LLM to act on. Observed crash classes from n=3 benches:
 *   - "Too many re-renders" / "Maximum update depth exceeded" — setState
 *     during render, or in a useEffect with missing/unstable deps. The
 *     diagnosis MUST point at useEffect/useState patterns, not null guards.
 *   - "Cannot access 'X' before initialization" — TDZ, usually from
 *     referencing a `let`/`const` in a useEffect deps array (or default
 *     value) before its declaration line. Fix is reorder, not null-guard.
 *   - "X is not defined" — typo or missing destructure. Fix is grep + fix
 *     the symbol, not null-guard.
 *   - "X is not iterable" / "Cannot read property … of undefined/null" —
 *     defaulting/optional-chaining; the original generic fix applies.
 */
/**
 * Public probe-classification surface for the in-loop runtime probe.
 *
 * Two helpers:
 *   - `classifyRenderCrashFix(reason)` returns the class-specific fix
 *     string. Exported so the eval-round runner can build a
 *     `[runtime]` violation for the coding agent at exit-decision time.
 *   - `isRecoverableRenderCrash(reason)` is a boolean variant — true
 *     when `classifyRenderCrashFix` returns a CLASS-SPECIFIC string
 *     (i.e., one of: re-render loop, TDZ, undeclared symbol, non-array
 *     iteration, null/undefined access). False when the reason falls
 *     through to the generic fallback.
 *
 * "Recoverable" is harness terminology, not a runtime certainty: it
 * means the LLM has a reasonable chance of fixing the crash given the
 * class-specific advice. The generic fallback ("add null guards on
 * optional props…") is too vague to recover from in one turn.
 */
const CLASS_SPECIFIC_PATTERNS: ReadonlyArray<RegExp> = [
  /too many re-renders/i,
  /maximum update depth/i,
  /infinite render loop/i,
  /cannot access\s+'[^']+'\s+before initialization/i,
  /\b\w+ is not defined\b/i,
  /is not iterable/i,
  /symbol\(symbol\.iterator\)/i,
  /cannot read propert(?:y|ies) of (?:undefined|null)/i,
  /undefined is not/i,
  /null is not/i,
];

export function isRecoverableRenderCrash(reason: string): boolean {
  return CLASS_SPECIFIC_PATTERNS.some((rx) => rx.test(reason));
}

export function classifyRenderCrashFix(reason: string): string {
  const r = reason.toLowerCase();
  if (
    r.includes("too many re-renders") ||
    r.includes("maximum update depth") ||
    r.includes("infinite render loop")
  ) {
    return (
      "Find the setState/dispatch call in your render body or useEffect. " +
      "Either: (a) move the setState into an event handler, (b) add a proper " +
      "useEffect dependency array so it doesn't fire every render, or (c) " +
      "guard the setState with an equality check `if (next !== current) setX(next)`. " +
      "Do NOT call setState in render or useEffect-without-deps."
    );
  }
  if (r.includes("cannot access") && r.includes("before initialization")) {
    const symMatch = reason.match(/'([^']+)'/);
    const sym = symMatch ? symMatch[1] : "the variable";
    return (
      `Temporal-dead-zone error on \`${sym}\`. You're referencing ${sym} ` +
      `(likely in a useEffect dependency array or a default value) BEFORE ` +
      `its \`const\`/\`let\` declaration. Move the declaration of ${sym} ` +
      `to the top of the component body, before any useEffect/useMemo/` +
      `useCallback that reads it.`
    );
  }
  if (r.includes("is not defined")) {
    const symMatch = reason.match(/(\w+) is not defined/);
    const sym = symMatch ? symMatch[1] : "the symbol";
    return (
      `ReferenceError: \`${sym}\` is used in JSX/expression but never ` +
      `declared. Either: (a) add a \`const ${sym} = ...\` declaration in ` +
      `the component body, (b) destructure it from props/state, or (c) ` +
      `fix the typo if you meant a similarly-named local.`
    );
  }
  if (r.includes("is not iterable") || r.includes("symbol(symbol.iterator)")) {
    return (
      "Render iterated over a non-array. Find the `for...of`, `[...spread]`, " +
      "or `.map`/`.filter`/`.reduce` call that crashed and either: (a) " +
      "default the value to `[]` (`const items = props.items ?? []`), or " +
      "(b) check it's an array before iterating (`Array.isArray(x) && ...`)."
    );
  }
  if (r.includes("cannot read") || r.includes("undefined is not") || r.includes("null is not")) {
    return (
      "Null/undefined access. Add optional chaining (`obj?.field`) and " +
      "default values for optional props/state before reading nested fields. " +
      "Check your destructure patterns — destructuring undefined throws."
    );
  }
  // Fallback for unrecognized crash classes — keep the original advice.
  return (
    "Add null guards on optional props, handle empty arrays/strings, " +
    "and verify all hook outputs before destructuring."
  );
}

/** The prefix every probe issue's subcategory carries: `runtime:<check>[:<subject>]`. */
const RUNTIME_SUBCATEGORY_PREFIX = "runtime:";

/**
 * The check a probe issue's subcategory names (ggui#1380) — the inverse of
 * the `runtime:<check>[:<subject>]` form {@link toEvalIssue} writes, so a
 * round can list WHICH checks failed from the issues alone. `undefined` for
 * anything that is not a probe subcategory naming a member of
 * {@link RENDER_CHECK_KINDS} (an axis check's subcategory, a did-not-run
 * code such as `runtime:probe-timeout`, a bare check name).
 */
export function parseRuntimeSubcategory(subcategory: string): RenderCheckKind | undefined {
  if (!subcategory.startsWith(RUNTIME_SUBCATEGORY_PREFIX)) return undefined;
  const rest = subcategory.slice(RUNTIME_SUBCATEGORY_PREFIX.length);
  const separator = rest.indexOf(":");
  const check = separator === -1 ? rest : rest.slice(0, separator);
  return RENDER_CHECK_KINDS.find((kind) => kind === check);
}

/**
 * One probe finding → the eval issue the loop feeds back and the metadata
 * counts. Exported for the pin that every switch case below is a member of
 * {@link RENDER_CHECK_KINDS} and round-trips through
 * {@link parseRuntimeSubcategory}.
 */
export function toEvalIssue(issue: RenderCheckIssue): EvalIssue | null {
  // verified → no issue (silent pass)
  if (issue.outcome === "verified" || issue.outcome === "skipped") return null;

  // unverified → warn (non-blocking — wiring may exist, just not deterministically simulable)
  // failed     → fail (blocker — strong evidence the wiring should work but didn't)
  const result: "fail" | "warn" = issue.outcome === "failed" ? "fail" : "warn";

  const subject = issue.subject ?? "";
  const subcategory = subject ? `runtime:${issue.check}:${subject}` : `runtime:${issue.check}`;
  const elementHint = issue.elementHint ? ` (element: ${issue.elementHint})` : "";

  // Build a diagnostic suffix that gives the coding agent observable context.
  const diag = issue.diagnostics;
  const diagParts: string[] = [];
  if (diag?.observedNativeProps?.length) {
    diagParts.push(`native props: ${diag.observedNativeProps.join(", ")}`);
  }
  if (diag?.observedCustomProps?.length) {
    diagParts.push(`custom props: ${diag.observedCustomProps.join(", ")}`);
  }
  if (diag?.observedJsxElements?.length) {
    diagParts.push(`elements: ${diag.observedJsxElements.slice(0, 4).join(", ")}`);
  }
  if (diag?.actionsFiredFromClicks?.length) {
    diagParts.push(`other actions fired from clicks: ${diag.actionsFiredFromClicks.join(", ")}`);
  }
  if (diag?.inputPriming) {
    // ggui#1187: an input-gated action that "did not dispatch" reads
    // differently beside "primed 0" / a priming error than beside "primed 1".
    diagParts.push(
      "primed" in diag.inputPriming
        ? `input priming: ${diag.inputPriming.primed} control(s) filled before the click`
        : `input priming failed: ${diag.inputPriming.error}`
    );
  }
  const diagSuffix = diagParts.length ? ` [observed: ${diagParts.join("; ")}]` : "";

  switch (issue.check) {
    case "render-no-throw":
      return {
        tier: 0,
        result,
        category: "crash",
        subcategory,
        severity: "critical",
        description: `Component crashed at runtime: ${issue.reason}`,
        fix: classifyRenderCrashFix(issue.reason),
      };

    case "optional-props-omitted":
      // Same crash class as render-no-throw, surfaced by the second
      // render pass with optional props stripped (ggui#528): the wire
      // gate only requires `required: true` props, so a legitimate
      // render may omit these and the component must survive it.
      return {
        tier: 0,
        result,
        category: "crash",
        subcategory,
        severity: "critical",
        description: `Component crashed when optional props were omitted: ${issue.reason}`,
        fix:
          `Guard every optional prop before member access (props.${subject.split(",")[0]?.trim() ?? "x"}?.map(...), ` +
          `a default via destructuring, or an early empty-state return). Optional props (no \`required: true\` in the contract) ` +
          `may be absent at runtime even though the harness fills them.`,
      };

    case "action-wiring": {
      const fix =
        issue.outcome === "unverified"
          ? `Source shows the action callback flowing into a non-native or custom-component prop. If wiring is intentional (e.g., Dropdown.onChange, drag-drop), this warn is informational — manual/browser verification is required to confirm. Otherwise wire to a native onClick={() => ${subject}(payload)} on <button> or design-system <Button>.`
          : `Wire ${subject}() to a native event prop. Common fix: <Button onClick={() => ${subject}(payload)}>Label</Button>. Source-AST analysis didn't find this wiring in your JSX.`;
      return {
        tier: 0,
        result,
        category: "contract",
        subcategory,
        severity: result === "fail" ? "critical" : "major",
        description: `${issue.reason}${elementHint}${diagSuffix}`,
        fix,
      };
    }

    case "selection-identity":
      return {
        tier: 0,
        result,
        category: "contract",
        subcategory,
        severity: "critical",
        description: `${issue.reason}${elementHint}${diagSuffix}`,
        fix:
          `Key the action payload (and any selection state) on the item's ID from the data, never on its display text. ` +
          `Common fix: map over items and pass the item's id into the handler — onClick={() => ${subject}({ ...payload, id: item.id })} — ` +
          `and store selection as the id (setSelected(item.id)), not the label.`,
      };

    case "prop-sensitivity":
      return {
        tier: 0,
        result,
        category: "contract",
        subcategory,
        severity: "critical",
        description: `${issue.reason}${diagSuffix}`,
        fix:
          `Derive the display AND any logic from props.${subject} — render {props.${subject}} and branch on the prop's value, ` +
          `never on the literal value the request happened to mention (e.g. props.${subject} ?? 'January' followed by ` +
          `January-special-cased logic bakes the request into the component). The contract delivers the value; trust it.`,
      };

    case "prop-coverage":
      return {
        tier: 0,
        result,
        category: "contract",
        subcategory,
        description: `${issue.reason}${diagSuffix}`,
        fix: `Render props.${subject} somewhere in the JSX (e.g., <Text>{props.${subject}}</Text>). If you display a derived/formatted version, this warn may be a false positive.`,
      };

    case "stream-rerender":
      return {
        tier: 0,
        result,
        category: "contract",
        subcategory,
        description: `${issue.reason}${diagSuffix}`,
        fix: `Subscribe with const ${subject} = useStream('${subject}'); render ${subject}.latest && <Text>{${subject}.latest.field}</Text> or .all.map(...).`,
      };
  }
}
