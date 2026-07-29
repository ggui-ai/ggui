// @vitest-environment node
// packages/ui-gen/src/harness/check/runtime-render/probe-prewarm.test.ts
//
// Regression pin for ggui#403 defect 1: the probe must survive its own
// pre-warm. `warmupRuntimeRenderProbe()` imports the probe's runtime
// deps at dispatch entry — BEFORE any DOM exists. user-event v14
// captures `globalThis.document` into its module-scope setup defaults
// at MODULE LOAD, so a bare `userEvent.setup()` after a DOM-less
// pre-warm received `document: undefined` and crashed every probe with
//   Cannot read properties of undefined
//     (reading 'Symbol(Node prepared with document state workarounds)')
// The fix passes the live document explicitly (`setup({ document })`),
// making the probe immune to import order.
//
// This file MUST run in the node environment (no ambient DOM) and MUST
// be its own file: the poisoning is a module-load-order property, and
// vitest's per-file isolation is what makes the order deterministic.

import { describe, expect, it } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import { warmupRuntimeRenderProbe } from "./index.js";
import { DEFAULT_RUNTIME_RENDER_CHECK } from "./adapter.js";

const CONTRACT: DataContract = {
  actionSpec: {
    save: { label: "Save" },
  },
};

const SOURCE = `
import React from 'react';
import { useAction } from '@ggui-ai/wire';
export default function Card(props: { title: string }) {
  const save = useAction('save');
  return (
    <div>
      <h1>{props.title}</h1>
      <button onClick={() => save({})}>Save</button>
    </div>
  );
}
`;

describe("runtime-render probe after DOM-less pre-warm (ggui#403)", () => {
  it("probe still RUNS when user-event was imported before any DOM existed", async () => {
    // Mimic generation-dispatch: warm the deps with no DOM up.
    expect(globalThis.document).toBeUndefined();
    const warm = await warmupRuntimeRenderProbe();
    expect(warm.missing).toBe(0);

    const outcome = await DEFAULT_RUNTIME_RENDER_CHECK.run({
      sourceCode: SOURCE,
      compiledCode: "compiled-by-probe",
      contract: CONTRACT,
    });

    // Pre-fix this was `infra-skipped` (user-event's frozen
    // `document: undefined` default) on every single invocation.
    expect(outcome.status).toBe("ran");
    // The action IS wired natively — the probe's click simulation must
    // have actually executed, not been skipped: a verified wiring
    // produces no issue for `save`.
    const saveIssues = outcome.issues.filter((i) => i.subcategory?.includes("save"));
    expect(saveIssues).toEqual([]);
  });
});
