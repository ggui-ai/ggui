/**
 * universal.root_width_cap (ggui#1117 — the eval leg ggui#1113 left out).
 *
 * FRAME_SIZING's width half, enforced where it can matter: a width cap on the OUTERMOST returned
 * element is the defect on a wide canvas and a no-op in a chat bubble, so the check reads the
 * canvas #1117 threads — stands down with none (never a guess) and below `md`, fires as a WARN
 * only for a cap smaller than the canvas. The sanctioned shape — the root fills, the measure sits
 * on an inner column — never fires.
 */
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { CanvasClass } from "../../../design-mode.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS, findRootWidthCap } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.root_width_cap")!;
const classification = classifyAxes({ contract: {}, prompt: "a welcome card" });

const component = (root: string): string => `
import { Box, Container, Stack, Heading, Text } from '@ggui-ai/design';
interface Props { heading: string }
export default function Component(props: Props) {
  return (
    ${root}
  );
}`;

const input = (sourceCode: string, canvas?: CanvasClass): AxisCheckInput => ({
  sourceCode,
  compiledCode: "x",
  originalPrompt: "a welcome card",
  classification,
  ...(canvas !== undefined ? { canvas } : {}),
});

const CAPPED_ROOT = component(`<Container maxWidth="sm" padding="lg"><Heading level={1}>{props.heading}</Heading></Container>`);
const SANCTIONED = component(`<Box padding="lg" style={{ flex: 1 }}><Container maxWidth="sm"><Heading level={1}>{props.heading}</Heading></Container></Box>`);
const BARE_CONTAINER = component(`<Container padding="lg"><Text>{props.heading}</Text></Container>`);
const STYLE_CAP = component(`<Stack gap="lg" style={{ maxWidth: '480px', margin: '0 auto' }}><Text>{props.heading}</Text></Stack>`);
const CLASS_CAP = component(`<div className="mx-auto max-w-md"><p>{props.heading}</p></div>`);
const FULL = component(`<Container maxWidth="full"><Text>{props.heading}</Text></Container>`);

describe("findRootWidthCap — what the outermost returned element carries", () => {
  it("reads a Container preset, an inline px, a max-w-* class, and the bare-Container default; a filling root reads null", () => {
    expect(findRootWidthCap(CAPPED_ROOT)).toEqual({ element: "Container", cap: 'maxWidth="sm"', px: 480 });
    expect(findRootWidthCap(STYLE_CAP)).toEqual({ element: "Stack", cap: "maxWidth: '480px'", px: 480 });
    expect(findRootWidthCap(CLASS_CAP)).toEqual({ element: "div", cap: "max-w-md", px: null });
    expect(findRootWidthCap(BARE_CONTAINER)).toEqual({ element: "Container", cap: "lg (Container default)", px: 768 });
    expect(findRootWidthCap(SANCTIONED)).toBeNull();
    expect(findRootWidthCap(FULL)).toBeNull();
    expect(findRootWidthCap(component(`<div className="max-w-full"><p>x</p></div>`))).toBeNull();
  });

  it("only the OUTERMOST element counts: a cap on an inner column is the sanctioned shape; a fragment root has no cap; a parenthesis-free return is read", () => {
    expect(findRootWidthCap(SANCTIONED)).toBeNull();
    expect(findRootWidthCap(component(`<><Container maxWidth="sm">x</Container></>`))).toBeNull();
    expect(findRootWidthCap(`export default function Component() {\n  return <Container maxWidth="md">x</Container>;\n}`)).toEqual({ element: "Container", cap: 'maxWidth="md"', px: 640 });
  });
});

describe("universal.root_width_cap — fires only where the cap binds", () => {
  it("stands down with no canvas — never a guess — and on the narrow canvases", () => {
    expect(check.run(input(CAPPED_ROOT))).toEqual([]);
    expect(check.run(input(CAPPED_ROOT, "xs-chat-card"))).toEqual([]);
    expect(check.run(input(CAPPED_ROOT, "mobile-fullscreen-small"))).toEqual([]);
  });

  it("a 480px root cap on md / lg / xl: one WARN naming the element, the cap and the canvas", () => {
    for (const canvas of ["md", "lg", "xl"] as const) {
      const issues = check.run(input(CAPPED_ROOT, canvas));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ subcategory: "universal.root_width_cap", result: "warn" });
      expect(issues[0]!.description).toContain("<Container>");
      expect(issues[0]!.description).toContain('maxWidth="sm"');
      expect(issues[0]!.description).toContain("480px on a");
    }
  });

  it("a bare <Container> is an implicit 768px cap: silent on md (768 never binds), a WARN on lg and xl", () => {
    expect(check.run(input(BARE_CONTAINER, "md"))).toEqual([]);
    expect(check.run(input(BARE_CONTAINER, "lg"))).toHaveLength(1);
    expect(check.run(input(BARE_CONTAINER, "xl"))).toHaveLength(1);
  });

  it("inline style and class caps fire; `maxWidth=\"full\"` and the sanctioned inner-column shape never do", () => {
    expect(check.run(input(STYLE_CAP, "lg"))).toHaveLength(1);
    expect(check.run(input(CLASS_CAP, "md"))).toHaveLength(1);
    expect(check.run(input(FULL, "xl"))).toEqual([]);
    expect(check.run(input(SANCTIONED, "xl"))).toEqual([]);
  });

  it("a null compile runs nothing", () => {
    expect(check.run({ ...input(CAPPED_ROOT, "lg"), compiledCode: null })).toEqual([]);
  });
});
