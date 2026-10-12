// packages/ui-gen/src/harness/check/runtime-render/warmup-kinds.test.ts
//
// ggui#1839 — code-property pin on `warmupRuntimeRenderWorker`'s source: every
// `ok: false` exit names a `kind`, and the kinds the exits name are exactly the
// exported kind list. A new exit without a kind, or a kind the list does not
// declare (or a declared kind no exit uses), fails here, before a caller's
// exhaustive switch has to find out.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNTIME_RENDER_WARMUP_FAILURE_KINDS } from "./index.js";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** The body of `warmupRuntimeRenderWorker`, from its signature to the next top-level declaration. */
function warmupBody(): string {
  const start = source.indexOf("export async function warmupRuntimeRenderWorker(");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export |function |const |\/\*\*)/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Each object literal returned with `ok: false`, from `return {` to its closing `};`. */
function failureReturns(body: string): string[] {
  return [...body.matchAll(/return \{([^;]*?ok: false[^;]*?)\};/gs)].map((m) => m[1]);
}

describe("warmupRuntimeRenderWorker: every ok:false exit carries a kind (ggui#1839)", () => {
  const returns = failureReturns(warmupBody());

  it("finds the function's failure exits (control: the scan is not empty)", () => {
    expect(returns.length).toBeGreaterThanOrEqual(3);
  });

  it("each failure exit names exactly one kind", () => {
    for (const r of returns) expect(r.match(/\bkind: "/g) ?? []).toHaveLength(1);
  });

  it("the kinds the exits name equal the exported kind list", () => {
    const named = returns.map((r) => /\bkind: "([^"]+)"/.exec(r)?.[1]);
    expect(new Set(named)).toEqual(new Set(RUNTIME_RENDER_WARMUP_FAILURE_KINDS));
  });
});
