// Pin (ggui#1443): `universal.form_submit_control` — a `<form onSubmit>` whose buttons cannot submit it. The design
// Button defaults to type="button", so a form with buttons and no `type="submit"` control (or `<input type="submit">`)
// is a control that does not work: one FAIL per such form, the fix naming type="submit". A submitting control beside
// type="button" secondaries passes; a form without onSubmit is not read; no form → stand-down.
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS, submitForms } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.form_submit_control")!;
const PROMPT = "Build a chat composer with a Send button";
function input(sourceCode: string): AxisCheckInput {
  return { sourceCode, compiledCode: "compiled", originalPrompt: PROMPT, classification: classifyAxes({ contract: {}, prompt: PROMPT }) };
}
const BAD = `export default function C() {
  return (
    <form onSubmit={handleSubmit}>
      <Input value={text} onChange={setText} />
      <Button variant="primary" disabled={!text.trim()}>
        Send Message
      </Button>
    </form>
  );
}`;
const GOOD = BAD.replace('<Button variant="primary"', '<Button type="submit" variant="primary"');
const CANCEL_BESIDE = BAD.replace("</Button>\n", '</Button>\n      <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>\n').replace('<Button variant="primary"', '<Button type="submit" variant="primary"');
const INPUT_SUBMIT = BAD.replace(/<Button[\s\S]*?<\/Button>/, '<input type="submit" value="Send" />');
const BRACED = BAD.replace('<Button variant="primary"', "<Button type={'submit'} variant=\"primary\"");

describe("universal.form_submit_control (ggui#1443)", () => {
  it("is registered on every render value", () => {
    expect(check).toBeDefined();
    expect(check.axis).toBe("render");
  });
  it("finds every <form onSubmit> block, verbatim, and nothing else", () => {
    expect(submitForms(BAD)).toHaveLength(1);
    expect(submitForms(BAD)[0]).toContain("Send Message");
    expect(submitForms("<form><Button>x</Button></form>")).toEqual([]);
    expect(submitForms(`${BAD}\n${GOOD}`)).toHaveLength(2);
  });
  it("a form whose only Button is type-less FAILS once, naming type=\"submit\" in the fix", () => {
    const issues = check.run(input(BAD));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ result: "fail", subcategory: "universal.form_submit_control", tier: 0 });
    expect(issues[0]!.description).toContain('defaults to type="button"');
    expect(issues[0]!.fix).toContain('type="submit"');
  });
  it("a submitting control passes: type=\"submit\" (quoted or braced), an <input type=\"submit\">, or beside type=\"button\" secondaries", () => {
    expect(check.run(input(GOOD))).toEqual([]);
    expect(check.run(input(BRACED))).toEqual([]);
    expect(check.run(input(INPUT_SUBMIT))).toEqual([]);
    expect(check.run(input(CANCEL_BESIDE))).toEqual([]);
  });
  it("stands down without a form, without onSubmit, without any control, or without a build; two forms with one bad → one issue", () => {
    expect(check.run(input("<div><Button>Go</Button></div>"))).toEqual([]);
    expect(check.run(input("<form><Button>Go</Button></form>"))).toEqual([]);
    expect(check.run(input("<form onSubmit={s}><Input value={v} /></form>"))).toEqual([]);
    expect(check.run({ ...input(BAD), compiledCode: null })).toEqual([]);
    expect(check.run(input(`${GOOD}\n${BAD}`))).toHaveLength(1);
  });
});
