/**
 * `universal.prop_seed_no_resync` (#480 CHECK leg) — the complement of
 * `universal.no_prop_mirror`: a prop-seeded `useState` whose setter IS
 * used (real optimistic state) but which nothing re-seeds when the
 * agent repaints the prop. Without the re-seed effect, a `ggui_amend`
 * `props_update` applies new props that never reach the display —
 * the live class of bug probe 13 caught on claude.ai (ggui#480).
 */
import { describe, expect, it } from "vitest";
import type { Classification } from "../../../classifier/axes.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS } from "./universal.js";

const check = UNIVERSAL_CHECKS.find(
  (c) => c.id === "universal.prop_seed_no_resync",
);
if (check === undefined) throw new Error("check not registered");

function classification(): Classification {
  return {
    vector: {
      render: "static",
      state: "none",
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

describe("universal.prop_seed_no_resync (#480)", () => {
  it("flags a mutated prop-seeded state with no re-seed effect", () => {
    const issues = check.run(
      makeInput(`
        const [count, setCount] = useState(props.count ?? 0);
        return <button onClick={() => setCount(count + 1)}>{count}</button>;
      `),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.subcategory).toBe("universal.prop_seed_no_resync");
    expect(issues[0]?.description).toContain("ggui_amend");
    expect(issues[0]?.fix).toContain("[props.count]");
  });

  it("passes when a useEffect re-seeds on [props.X]", () => {
    const issues = check.run(
      makeInput(`
        const [count, setCount] = useState(props.count ?? 0);
        useEffect(() => setCount(props.count ?? 0), [props.count]);
        return <button onClick={() => setCount(count + 1)}>{count}</button>;
      `),
    );
    expect(issues).toHaveLength(0);
  });

  it("leaves the never-mutated mirror to no_prop_mirror (no double-fire)", () => {
    const issues = check.run(
      makeInput(`
        const [count, setCount] = useState(props.count ?? 0);
        return <span>{count}</span>;
      `),
    );
    expect(issues).toHaveLength(0);
  });

  it("ignores state not seeded from props", () => {
    const issues = check.run(
      makeInput(`
        const [open, setOpen] = useState(false);
        return <button onClick={() => setOpen(!open)}>{String(open)}</button>;
      `),
    );
    expect(issues).toHaveLength(0);
  });

  it("handles optional-chained props seeds (props?.x)", () => {
    const issues = check.run(
      makeInput(`
        const [items, setItems] = useState(props?.items ?? []);
        const add = () => setItems([...items, {}]);
        return <div onClick={add}>{items.length}</div>;
      `),
    );
    expect(issues).toHaveLength(1);
  });
});
