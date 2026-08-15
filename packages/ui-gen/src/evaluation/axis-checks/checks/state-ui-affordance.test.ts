// Pins for `state.ui_affordance.state_aria_present` (ggui#408).
//
// The fixture shapes are the Experiment-53 baseline's real
// true-positive / true-negative classes (prototype: precision 1.00,
// recall 0.80 on the 27-cell corpus) plus its two named false
// negatives, closed here: lowercase tags (`<div as={Clickable}>`) and
// callback-prop indirection in extracted subcomponents.

import { describe, expect, it } from "vitest";
import type { Classification } from "../../../classifier/axes.js";
import type { AxisCheckInput } from "../types.js";
import { STATE_UI_AFFORDANCE_CHECKS } from "./state-ui-affordance.js";

const CHECK = STATE_UI_AFFORDANCE_CHECKS.find(
  (c) => c.id === "state.ui_affordance.state_aria_present",
)!;

function classification(): Classification {
  return {
    vector: {
      render: "list",
      state: "ui-affordance",
      writes: "none",
      writeTrigger: "click",
      realtime: "none",
      fetch: "none",
      layout: "single",
      tooling: "none",
    },
    provenance: {
      render: "default",
      state: "default",
      writes: "default",
      writeTrigger: "default",
      realtime: "default",
      fetch: "default",
      layout: "default",
      tooling: "default",
    },
    riskTier: "low",
  };
}

function makeInput(sourceCode: string): AxisCheckInput {
  return {
    sourceCode,
    compiledCode: sourceCode,
    originalPrompt: "",
    classification: classification(),
  };
}

describe("state.ui_affordance.state_aria_present", () => {
  it("gates on state=ui-affordance", () => {
    expect(CHECK.axis).toBe("state");
    expect(CHECK.values).toEqual(["ui-affordance"]);
  });

  it("fires on the canonical defect: selection carried by styling only (the periodic-table shape)", () => {
    const src = `
const [selectedId, setSelectedId] = useState<string | null>(null);
return items.map((el) => (
  <Box as={Clickable} onClick={() => setSelectedId(el.id)}
    style={{ boxShadow: selectedId === el.id ? "0 0 0 2px" : "none" }}>
    <Text>{el.name}</Text>
  </Box>
));`;
    const issues = CHECK.run(makeInput(src));
    expect(issues).toHaveLength(1);
    expect(issues[0].result).toBe("fail");
    expect(issues[0].subcategory).toBe("state.ui_affordance.state_aria_present");
  });

  it("fires through handler indirection (setter called inside a local handler)", () => {
    const src = `
const [openId, setOpenId] = useState<string | null>(null);
const handleToggle = (id: string) => { setOpenId(openId === id ? null : id); };
return notes.map((n) => (
  <Card as={Clickable} onClick={() => handleToggle(n.id)}>
    <Icon name="chevron" />
  </Card>
));`;
    expect(CHECK.run(makeInput(src))).toHaveLength(1);
  });

  it("fires on lowercase tags — the inert-as variant (closed FN #1)", () => {
    const src = `
const [selected, setSelected] = useState("");
return <div as={Clickable} onClick={() => setSelected(id)}>cell</div>;`;
    expect(CHECK.run(makeInput(src))).toHaveLength(1);
  });

  it("fires on callback-prop indirection in an extracted subcomponent (closed FN #2)", () => {
    const src = `
function ReleaseCard({ note, onToggleExpand }) {
  return (
    <Card as={Clickable} onClick={() => onToggleExpand(note.id)}>
      <Text>{note.title}</Text>
    </Card>
  );
}`;
    expect(CHECK.run(makeInput(src))).toHaveLength(1);
  });

  it("stays silent when the element carries state ARIA", () => {
    const src = `
const [done, setDone] = useState(false);
return <Box as={Clickable} role="checkbox" aria-checked={done} onClick={() => setDone(!done)} />;`;
    expect(CHECK.run(makeInput(src))).toHaveLength(0);
  });

  it("stays silent when aria-selected carries the state (no role needed)", () => {
    const src = `
const [tab, setTab] = useState(0);
return <Box as={Clickable} aria-selected={tab === i} onClick={() => setTab(i)} />;`;
    expect(CHECK.run(makeInput(src))).toHaveLength(0);
  });

  it("never demands ARIA on a wrapper whose subtree contains a state-carrying primitive", () => {
    // The judge FAILS duplicate wrapper ARIA (todo-toggle/claude/run2);
    // demanding it here would push generations into that defect.
    const src = `
const [done, setDone] = useState(false);
return (
  <Card onClick={() => setDone(!done)}>
    <Checkbox checked={done} label="Done" />
  </Card>
);`;
    expect(CHECK.run(makeInput(src))).toHaveLength(0);
  });

  it("never flags semantics-owning primitives", () => {
    const src = `
const [open, setOpen] = useState(false);
return <Button onClick={() => setOpen(!open)}>More</Button>;`;
    expect(CHECK.run(makeInput(src))).toHaveLength(0);
  });

  it("stays silent when onClick does not mutate the affordance state", () => {
    const src = `
const [items] = useState([]);
return <Box as={Clickable} onClick={() => console.log("noop")}>row</Box>;`;
    expect(CHECK.run(makeInput(src))).toHaveLength(0);
  });

  it("emits nothing when compilation failed (compiledCode null)", () => {
    const input = { ...makeInput("<Box onClick={() => setX(1)} />"), compiledCode: null };
    expect(CHECK.run(input)).toHaveLength(0);
  });
});
