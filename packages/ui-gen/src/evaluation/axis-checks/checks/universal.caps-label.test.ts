// Pin (ggui#1075 Track A): `universal.caps_label_invented` names a caps label
// whose whole content is a literal — copy the props do not supply. RED
// fixture = the served hello's own eyebrow (a minted source: `<Text size="xs"
// weight="semibold" caps tone="emphasized">Let’s begin</Text>`, no prop
// behind it). A label bound to an expression passes; no label passes.
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS, findInventedCapsLabels } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.caps_label_invented")!;
const input = (sourceCode: string): AxisCheckInput => ({
  sourceCode,
  compiledCode: "compiled",
  originalPrompt: "a welcome card",
  classification: classifyAxes({ contract: {}, prompt: "a welcome card" }),
});

const INVENTED = `
export default function C(props: Props) {
  return (<Card surface="hero"><Stack gap="sm">
    <Text size="xs" weight="semibold" caps tone="emphasized">Let’s begin</Text>
    <Heading level={1}>{props.heading ?? 'Welcome'}</Heading>
  </Stack></Card>);
}`;
const BOUND = INVENTED.replace("caps tone=\"emphasized\">Let’s begin</Text>", "caps tone=\"emphasized\">{props.section}</Text>");
const FALLBACK_BOUND = INVENTED.replace(">Let’s begin</Text>", ">{props.section ?? 'Section'}</Text>");
const NONE = INVENTED.replace(/<Text[^>]*caps[^>]*>[\s\S]*?<\/Text>\n/, "");

describe("universal.caps_label_invented", () => {
  it("RED: the served hello's own eyebrow — a caps label that is nothing but a literal", () => {
    expect(findInventedCapsLabels(INVENTED)).toEqual(["Let’s begin"]);
    const issues = check.run(input(INVENTED));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ tier: 0, result: "fail", subcategory: "universal.caps_label_invented" });
    expect(issues[0]!.description).toContain('"Let’s begin"');
  });

  it("a label bound to a prop (with or without a literal fallback inside the expression) passes", () => {
    expect(check.run(input(BOUND))).toEqual([]);
    expect(check.run(input(FALLBACK_BOUND))).toEqual([]);
  });

  it("no caps label at all passes; a null compile stands down", () => {
    expect(check.run(input(NONE))).toEqual([]);
    expect(check.run({ ...input(INVENTED), compiledCode: null })).toEqual([]);
  });

  it("counts every invented label once, in source order", () => {
    const two = INVENTED.replace("</Stack>", `<Text caps size="xs">Selected card</Text></Stack>`);
    expect(findInventedCapsLabels(two)).toEqual(["Let’s begin", "Selected card"]);
  });
});
