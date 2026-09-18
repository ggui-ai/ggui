/**
 * universal.action_label_dropped (ggui#1190 — the transcription-drop GUARD).
 *
 * The model transcribes an actionSpec label onto a control but drops a special
 * character ("Confirm & Schedule" -> "Confirm Schedule"). This check NAMES that
 * class on the bench; the fix (carry the verbatim label / render from data)
 * lands separately. FALSE-POSITIVE SAFETY is the hard requirement — the RED
 * case flags, and every control shape (verbatim, data-driven, icon+aria,
 * no-special-char, entity-encoded, wholesale-different, label===name) must NOT.
 *
 * Corpus note: the ideal FP corpus (the 96 n=6 generations) was NOT retrievable
 * — the benchmark-results JSONs persist only sourceCodeBytes, and the per-cell
 * logs are gone. So FP-safety is shown here two ways: (1) the control cases
 * below, and (2) NORMAL_CORPUS — realistic normal components (incl. special-char
 * labels rendered correctly) — asserting ZERO flags across all of them.
 */
import { describe, expect, it } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import type { AxisCheckInput } from "../types.js";
import { classifyAxes } from "../../../classifier/index.js";
import { UNIVERSAL_CHECKS, findDroppedActionLabels } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.action_label_dropped")!;

const contract = (actions: Record<string, string>): DataContract =>
  ({ actionSpec: Object.fromEntries(Object.entries(actions).map(([n, label]) => [n, { label }])) }) as DataContract;

const comp = (body: string): string => `
import { useAction } from '@ggui-ai/wire';
export default function Component() {
  const confirmSchedule = useAction('confirmSchedule');
  return (${body});
}`;

const flags = (src: string, c: DataContract): ReadonlyArray<{ name: string; label: string }> =>
  findDroppedActionLabels(src, c);

const C = contract({ confirmSchedule: "Confirm & Schedule" });

describe("universal.action_label_dropped (ggui#1190) — RED case", () => {
  it("flags a dropped '&' — label 'Confirm & Schedule' rendered 'Confirm Schedule'", () => {
    const src = comp(`<button onClick={() => confirmSchedule({})}>Confirm Schedule</button>`);
    const hits = flags(src, C);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ name: "confirmSchedule", label: "Confirm & Schedule" });
  });

  it("surfaces as a WARN issue through the registered check", () => {
    const src = comp(`<button onClick={() => confirmSchedule({})}>Confirm Schedule</button>`);
    const input: AxisCheckInput = {
      sourceCode: src,
      compiledCode: "x",
      contract: C,
      originalPrompt: "a scheduling card",
      classification: classifyAxes({ contract: {}, prompt: "a scheduling card" }),
    };
    const issues = check.run(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.result).toBe("warn");
    expect(issues[0]!.subcategory).toBe("universal.action_label_dropped");
  });
});

describe("universal.action_label_dropped (ggui#1190) — must NOT flag (FP-safety)", () => {
  it("label rendered verbatim (the '&' is there)", () => {
    expect(flags(comp(`<button onClick={() => confirmSchedule({})}>Confirm & Schedule</button>`), C)).toHaveLength(0);
  });
  it("label rendered from DATA ({.label}) — data-vs-behavior correct", () => {
    expect(flags(comp(`<button onClick={() => confirmSchedule({})}>{confirmSchedule.label}</button>`), C)).toHaveLength(0);
  });
  it("icon control with the label verbatim in aria-label", () => {
    expect(flags(comp(`<button aria-label="Confirm & Schedule" onClick={() => confirmSchedule({})}><Icon name="check" /></button>`), C)).toHaveLength(0);
  });
  it("entity-encoded &amp; (a correct rendering)", () => {
    expect(flags(comp(`<button onClick={() => confirmSchedule({})}>Confirm &amp; Schedule</button>`), C)).toHaveLength(0);
  });
  it("no-special-char label is never flaggable", () => {
    const c = contract({ confirmSchedule: "Confirm Schedule" });
    expect(flags(comp(`<button onClick={() => confirmSchedule({})}>Confirm Schedule</button>`), c)).toHaveLength(0);
  });
  it("wholesale-different button text (words not present) is not a 'drop'", () => {
    expect(flags(comp(`<button onClick={() => confirmSchedule({})}>Book it</button>`), C)).toHaveLength(0);
  });
  it("label equal to the action id (no real label)", () => {
    const c = contract({ confirmSchedule: "confirmSchedule" });
    expect(flags(comp(`<button onClick={() => confirmSchedule({})}>Go</button>`), c)).toHaveLength(0);
  });
  it("label rendered with an icon prefix (label is a substring)", () => {
    expect(flags(comp(`<button onClick={() => confirmSchedule({})}>✓ Confirm & Schedule</button>`), C)).toHaveLength(0);
  });
  it("no actionSpec at all", () => {
    expect(findDroppedActionLabels(comp(`<div>hi</div>`), {} as DataContract)).toHaveLength(0);
  });
});

describe("universal.action_label_dropped (ggui#1190) — NORMAL_CORPUS zero over-flags", () => {
  // Realistic normal generations, incl. special-char labels rendered correctly.
  const NORMAL_CORPUS: ReadonlyArray<{ src: string; c: DataContract }> = [
    { c: contract({ save: "Save & Exit" }), src: `export default function C(){const save=useAction('save');return <button onClick={()=>save({})}>Save & Exit</button>;}` },
    { c: contract({ port: "Import / Export" }), src: `export default function C(){const port=useAction('port');return <button onClick={()=>port({})}>Import / Export</button>;}` },
    { c: contract({ addRow: "Add Row +" }), src: `export default function C(){const addRow=useAction('addRow');return <button onClick={()=>addRow({})}>Add Row +</button>;}` },
    { c: contract({ send: "Send" }), src: `export default function C(){const send=useAction('send');return <button onClick={()=>send({})}>Send</button>;}` },
    { c: contract({ pay: "Pay $29" }), src: `export default function C(){const pay=useAction('pay');return <button onClick={()=>pay({})}>Pay $29</button>;}` },
    { c: contract({ del: "Delete…" }), src: `export default function C(){const del=useAction('del');return <button onClick={()=>del({})}>Delete…</button>;}` },
    { c: contract({ fav: "Favorite ★" }), src: `export default function C(){const fav=useAction('fav');return <button aria-label="Favorite ★" onClick={()=>fav({})}><Star/></button>;}` },
    { c: contract({ next: "Next →" }), src: `export default function C(){const next=useAction('next');return <button onClick={()=>next({})}>{next.label}</button>;}` },
    { c: contract({ ok: "OK" }), src: `export default function C(){const ok=useAction('ok');return <button onClick={()=>ok({})}>OK</button>;}` },
    { c: contract({ retry: "Try again" }), src: `export default function C(){const retry=useAction('retry');return <button onClick={()=>retry({})}>Try again</button>;}` },
  ];
  it("flags none of the normal components", () => {
    const total = NORMAL_CORPUS.reduce((n, { src, c }) => n + findDroppedActionLabels(src, c).length, 0);
    expect(total).toBe(0);
  });
});
