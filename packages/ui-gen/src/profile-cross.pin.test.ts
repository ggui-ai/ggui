// CROSS-PIN (ggui#1059): base ⊕ profile = the served prompt, and nothing else.
// The profile is ONE additive section spliced at a fixed anchor: removing that
// section from the served prompt yields the byte-identical base prompt, on both
// arms, for any profile. A profile that rewrote a base section would red this
// pin. It is what lets a profile-only change ship without re-benching cold-gen:
// the base digests (`design-mode.pin.test.ts`) cannot move when only the profile
// does. `effort` renders no prompt text at all; an `aesthetic` reference renders
// only when the caller resolved it to a brief.
import { APP_GENERATION_PROFILE_EFFORTS } from "@ggui-ai/protocol";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./boilerplate/system-prompt.js";
import {
  AESTHETIC_BRIEF_MAX_CHARS,
  STYLING_PROFILE_TRUNCATION_MARKER,
  buildStylingProfileJudgeBlock,
  buildStylingProfileSection,
  hasProfile,
  renderProfileQuote,
  type GenerationProfileInput,
} from "./boilerplate/styling-profile.js";
import type { DesignMode } from "./design-mode.js";

const BASE = { userRequest: "A weather card for Seoul", shellType: "fullscreen", screen: "desktop" } as const;
const ARMS: readonly DesignMode[] = ["constrained", "free"];
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const TEXT_MEMBERS: GenerationProfileInput = {
  styling: "dense data-ops console: flat surfaces, compact rows, monospace figures, one accent",
  density: "compact",
  layout: "two-pane master/detail",
  direction: "brand hero panel, then rows with arrows; no icons, no helper text",
};
const AESTHETIC: GenerationProfileInput = {
  aesthetic: { id: "quiet-editorial", version: "3" },
  aestheticBrief: "generous margins, serif display, one warm accent\nrules, not boxes",
};
const PROFILES: ReadonlyArray<readonly [string, GenerationProfileInput]> = [
  ["four text members", TEXT_MEMBERS],
  ["resolved aesthetic only", AESTHETIC],
  ["everything", { ...TEXT_MEMBERS, ...AESTHETIC, effort: "high" }],
];

/** The exact splice each arm performs — `withStylingProfile` (constrained) and the free prompt's section join. */
function stripSection(arm: DesignMode, served: string, section: string): string {
  const wrapped = arm === "constrained" ? `\n${section}\n` : `\n\n${section}`;
  expect(served.split(section)).toHaveLength(2);
  return served.replace(wrapped, "");
}

describe("CROSS-PIN — base ⊕ profile = served prompt (ggui#1059)", () => {
  for (const arm of ARMS) {
    const base = buildSystemPrompt({ ...BASE, designMode: arm });
    for (const [name, profile] of PROFILES) {
      it(`${arm}: ${name} — removing the one profile section yields the byte-identical base`, () => {
        const served = buildSystemPrompt({ ...BASE, designMode: arm, profile });
        const section = buildStylingProfileSection(profile);
        expect(section.length).toBeGreaterThan(0);
        expect(served).not.toBe(base);
        expect(stripSection(arm, served, section)).toBe(base);
        expect(sha(stripSection(arm, served, section))).toBe(sha(base));
      });
    }

    it(`${arm}: effort renders NO prompt text — every level is byte-identical to the base`, () => {
      for (const effort of APP_GENERATION_PROFILE_EFFORTS) {
        expect(buildSystemPrompt({ ...BASE, designMode: arm, profile: { effort } })).toBe(base);
      }
      expect(hasProfile({ effort: "ultra" })).toBe(false);
    });

    it(`${arm}: an aesthetic reference WITHOUT a resolved brief renders nothing (non-fatal by construction)`, () => {
      expect(buildSystemPrompt({ ...BASE, designMode: arm, profile: { aesthetic: { id: "quiet-editorial" } } })).toBe(base);
      expect(hasProfile({ aesthetic: { id: "quiet-editorial" } })).toBe(false);
    });
  }

  it("a resolved aesthetic renders under its `id@version` header, multi-line quoted, bounded like the other members", () => {
    const quote = renderProfileQuote(AESTHETIC);
    expect(quote).toBe("> **Aesthetic** (`quiet-editorial@3`): generous margins, serif display, one warm accent\n> rules, not boxes");
    expect(renderProfileQuote({ aesthetic: { id: "quiet-editorial" }, aestheticBrief: "x" })).toBe("> **Aesthetic** (`quiet-editorial`): x");
    const long = renderProfileQuote({ aesthetic: { id: "q" }, aestheticBrief: "a".repeat(AESTHETIC_BRIEF_MAX_CHARS + 50) });
    expect(long.endsWith(STYLING_PROFILE_TRUNCATION_MARKER)).toBe(true);
    expect(long.length).toBeLessThan(AESTHETIC_BRIEF_MAX_CHARS + 100);
    // A brief with no reference is not a member — nothing renders.
    expect(renderProfileQuote({ aestheticBrief: "orphan text" })).toBe("");
  });

  it("the judge reads the same quote the generator was given", () => {
    for (const [, profile] of PROFILES) {
      const quote = renderProfileQuote(profile);
      expect(buildStylingProfileSection(profile).endsWith(quote)).toBe(true);
      expect(buildStylingProfileJudgeBlock(profile).endsWith(quote)).toBe(true);
    }
  });
});
