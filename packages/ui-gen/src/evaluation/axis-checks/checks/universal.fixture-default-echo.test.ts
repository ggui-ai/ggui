// Pin (ggui#1285): `universal.fixture_default_echo` — a literal in the source that equals a prose-like fixture value
// the request never stated is the fixture echo (baked judging data a visitor sees when the prop is left out): one
// WARN per value. A value the request or the contract's own text states is rule 3's territory and never a hit; a
// short value or one without a space is never a hit; without fixture props the check stands down.
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { MIN_ECHO_CHARS, UNIVERSAL_CHECKS, fixtureOnlyStrings } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.fixture_default_echo")!;
const PROMPT = "Build a welcome card for Harbor Books with a greeting and a short line about this week's arrivals";
const FIXTURE = {
  heading: "Welcome back",
  message: "You are the assistant for Harbor Books; answer as the bookseller would.",
  city: "Tokyo",
  bookingId: "bk_7f3a",
  quickReplies: [{ label: "Browse this week's new arrivals" }, { label: "Go" }],
};
function input(sourceCode: string, overrides: Partial<AxisCheckInput> = {}): AxisCheckInput {
  return {
    sourceCode,
    compiledCode: "compiled",
    originalPrompt: PROMPT,
    classification: classifyAxes({ contract: {}, prompt: PROMPT }),
    fixtureProps: FIXTURE,
    ...overrides,
  };
}

describe("universal.fixture_default_echo", () => {
  it("is registered on every render value", () => {
    expect(check).toBeDefined();
    expect(check.axis).toBe("render");
  });

  it("the fixture-only prose values: long enough, with a space, not stated by the request or the contract, deduped", () => {
    // "Welcome back" is 12 chars with a space — exactly at the floor, stated nowhere — so it is a candidate too.
    expect(fixtureOnlyStrings(input(""))).toEqual([
      "Welcome back",
      "You are the assistant for Harbor Books; answer as the bookseller would.",
      "Browse this week's new arrivals",
    ]);
    expect(MIN_ECHO_CHARS).toBe(12);
    expect(fixtureOnlyStrings(input("", { fixtureProps: { heading: "Welcome" } }))).toEqual([]);
    expect(fixtureOnlyStrings(input("", { fixtureProps: { id: "bk_7f3a-and-then-some" } }))).toEqual([]);
  });

  it("a literal equal to a fixture-only value is one WARN per value, quoting it", () => {
    const src = `export default function C({ message = "You are the assistant for Harbor Books; answer as the bookseller would." }: Props) {
      return <div><h1>{props.heading ?? 'Welcome back'}</h1><p>{message}</p><button>Browse this week's new arrivals</button></div>;
    }`;
    const issues = check.run(input(src));
    expect(issues.map((i) => [i.subcategory, i.result])).toEqual([
      ["universal.fixture_default_echo", "warn"],
      ["universal.fixture_default_echo", "warn"],
      ["universal.fixture_default_echo", "warn"],
    ]);
    expect(issues[0]!.description).toContain('"Welcome back"');
    // long values are cut at 57 characters + an ellipsis in the description
    expect(issues[1]!.description).toContain('"You are the assistant for Harbor Books; answer as the boo…"');
    expect(issues[2]!.description).toContain('"Browse this week\'s new arrivals"');
    expect(issues[0]!.fix).toContain("Take that copy from the prop it renders");
  });

  it("a value the request states is rule 3's, never a hit; so is one the contract's own text states", () => {
    const src = `const line = "Browse this week's new arrivals";`;
    expect(check.run(input(src, { originalPrompt: `${PROMPT}. Offer: Browse this week's new arrivals` }))).toEqual([]);
    const contract = { actionSpec: { browse: { label: "Browse this week's new arrivals", example: {} } } };
    expect(check.run(input(src, { contract }))).toEqual([]);
    expect(check.run(input(src))).toHaveLength(1);
  });

  it("stands down without fixture props or a build", () => {
    const src = `const line = "Browse this week's new arrivals";`;
    expect(check.run(input(src, { fixtureProps: undefined }))).toEqual([]);
    expect(check.run(input(src, { compiledCode: null }))).toEqual([]);
  });
});
