// Pin (ggui#1015): `universal.icon_name_known` flags every string-literal
// `<Icon name>` outside the design system's curated Lucide subset (the
// primitive renders an empty box for those), skips dynamic names and
// emoji, and normalises like the primitive's resolver.
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS, findUnknownIconNames, isKnownIconName } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.icon_name_known")!;

function input(sourceCode: string): AxisCheckInput {
  return {
    sourceCode,
    compiledCode: "compiled",
    originalPrompt: "a greeting card",
    classification: classifyAxes({ contract: {}, prompt: "a greeting card" }),
  };
}

const SRC = `
import { Icon } from '@ggui-ai/design';
export default function Component(props: Props) {
  return (
    <div>
      <Icon name="sparkles" />
      <Icon name='trash-2' size={16} />
      <Icon name="Trash2" />
      <Icon name={"arrow-up-right"} />
      <Icon name="☀️" />
      <Icon name={props.items[0].icon} />
      <Icon name="nope-nope" />
      <Icon tone="muted" name="rocket-launch" />
    </div>
  );
}`;

describe("universal.icon_name_known", () => {
  it("is registered on every render value", () => {
    expect(check).toBeDefined();
    expect(check.values).toContain("static");
    expect(check.values).toContain("list");
  });

  it("names exactly the unknown literals — known, normalised, emoji and dynamic names pass", () => {
    expect(findUnknownIconNames(SRC)).toEqual(["nope-nope", "rocket-launch"]);
    expect(isKnownIconName("sparkles")).toBe(true);
    expect(isKnownIconName("ArrowUpRight")).toBe(true);
    expect(isKnownIconName("arrow_up_right")).toBe(true);
    expect(isKnownIconName("sparkles-ai")).toBe(false);
  });

  it("emits one tier-0 fail listing the unknown names, with the icon tool as the fix", () => {
    const issues = check.run(input(SRC));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.subcategory).toBe("universal.icon_name_known");
    expect(issues[0]!.result).toBe("fail");
    expect(issues[0]!.description).toContain('"nope-nope"');
    expect(issues[0]!.description).toContain('"rocket-launch"');
    expect(issues[0]!.fix).toContain("get_available_icons");
  });

  it("stays silent on a source whose every icon literal is in the subset", () => {
    expect(check.run(input(`<Icon name="sparkles" /><Icon name="check" />`))).toEqual([]);
    expect(check.run(input(`no icons here`))).toEqual([]);
  });

  it("does not run when the cell did not compile", () => {
    expect(check.run({ ...input(SRC), compiledCode: null })).toEqual([]);
  });
});
