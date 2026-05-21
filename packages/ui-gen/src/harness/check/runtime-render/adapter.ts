// packages/ui-gen/src/harness/check/runtime-render/adapter.ts
//
// Adapter: convert RenderCheckResult → EvalIssue[] so runtime-render
// integrates with the rest of the eval pipeline (axisChecks, tierChecks,
// llmEvaluator). Fits the RuntimeRenderCheck interface from harness/types.ts.

import type { EvalIssue } from "../../../evaluation/types-public.js";
import type { RuntimeRenderCheck } from "../../types-public.js";
import { runRenderCheck, type RenderCheckIssue } from "./render-check.js";
import { prepareMockupProps } from "./prepare-mockup.js";

export const DEFAULT_RUNTIME_RENDER_CHECK: RuntimeRenderCheck = {
  id: "runtime-render",
  run: async input => {
    const { sourceCode, compiledCode, contract, fixtureProps } = input;

    // Skip if compile failed — nothing to render.
    if (compiledCode === null) return [];
    // Skip if no contract — runtime check needs a contract surface to verify.
    if (!contract) return [];

    const mockup = prepareMockupProps({ contract, fixtureProps });

    let result;
    try {
      result = await runRenderCheck({
        sourceCode,
        mockupProps: mockup.props,
        contract,
      });
    } catch (e) {
      // Triad audit (2026-04-27): every error that escapes `runRenderCheck`
      // is an INFRA problem — happy-dom import failure, ESM/CJS interop
      // (`Dynamic require of "events"`), bundler name collision (`Window2
      // is not a constructor`), missing `@testing-library/react`, etc.
      // Component-level failures are caught and emitted as `RenderCheckIssue`
      // entries from inside `runRenderCheck`; they don't propagate out.
      //
      // Pre-fix: this branch emitted a tier-0 `crash` fail, which (1)
      // dragged every score-below-80 cell's eval-fix loop with a phantom
      // issue the coding agent couldn't fix, and (2) showed up correlated
      // with score-just-below-threshold cells across the bench, since
      // setup-only failures were being mis-attributed to the component.
      //
      // Post-fix: log the infra failure to stderr (devs see it) but emit
      // ZERO eval issues. The probe is opportunistic — if it can't run,
      // skip silently rather than penalize the LLM for an env mismatch.
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        `[runtime-render] probe skipped — infra failure: ${message}`,
      );
      return [];
    }

    return result.issues
      .map(toEvalIssue)
      .filter((x): x is EvalIssue => x !== null);
  },
};

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
  if (
    r.includes("cannot read") ||
    r.includes("undefined is not") ||
    r.includes("null is not")
  ) {
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

function toEvalIssue(issue: RenderCheckIssue): EvalIssue | null {
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
  if (diag?.resolvedTool) {
    diagParts.push(`server-side routes to MCP tool: ${diag.resolvedTool}`);
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

    case "action-wiring": {
      const fix = issue.outcome === "unverified"
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

    case "wiredTool-wiring": {
      const fix = issue.outcome === "unverified"
        ? `Source shows useWiredTool('${subject}').call flowing into a non-native or custom-component prop. If intentional (e.g., wired into a design-system component's onClick that doesn't forward to a real <button>), this warn is informational. Otherwise call ${subject}.call(args) from <button onClick={...}>.`
        : `Wire ${subject}.call(args) to a native onClick. Source-AST analysis didn't find ${subject}.call referenced in any JSX event prop.`;
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

    case "clientTool-registration":
      return {
        tier: 0,
        result,
        category: "contract",
        subcategory,
        severity: result === "fail" ? "critical" : "major",
        description: issue.reason,
        fix: `Register the handler: useClientTool('${subject}', (args) => { return { ...response matching contract } });`,
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
