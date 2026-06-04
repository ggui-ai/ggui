import { describe, it, expect } from "vitest";
import { matchBlueprint, type MatchableBlueprint } from "./match.js";

const bp = (partial: Partial<MatchableBlueprint> & Pick<MatchableBlueprint, "blueprintId" | "dataTools">): MatchableBlueprint => ({
  serverId: "platform_test",
  status: "active",
  source: "curated",
  ...partial,
});

describe("matchBlueprint — subset matching", () => {
  it("returns null when no candidate matches", () => {
    const result = matchBlueprint(
      [bp({ blueprintId: "a", dataTools: ["tool_x"] })],
      ["tool_y"],
    );
    expect(result).toBeNull();
  });

  it("returns the blueprint when its dataTools are a subset of sourceTools", () => {
    const result = matchBlueprint(
      [bp({ blueprintId: "inbox", dataTools: ["get_tasks"] })],
      ["get_tasks", "calendar_list_events"],
    );
    expect(result?.blueprintId).toBe("inbox");
  });

  it("agent bringing extra tools does not exclude a blueprint with fewer dataTools", () => {
    const result = matchBlueprint(
      [bp({ blueprintId: "inbox", dataTools: ["get_tasks"] })],
      ["get_tasks", "gmail_search_messages", "slack_list_channels"],
    );
    expect(result?.blueprintId).toBe("inbox");
  });

  it("empty sourceTools → null", () => {
    expect(matchBlueprint([bp({ blueprintId: "x", dataTools: ["a"] })], [])).toBeNull();
  });

  it("empty candidates → null", () => {
    expect(matchBlueprint([], ["tool_x"])).toBeNull();
  });
});

describe("matchBlueprint — ranking", () => {
  it("blueprint with MORE dataTools wins (more specific match)", () => {
    const result = matchBlueprint(
      [
        bp({ blueprintId: "general", dataTools: ["get_tasks"] }),
        bp({ blueprintId: "plan-my-week", dataTools: ["get_tasks", "calendar_list_events"] }),
      ],
      ["get_tasks", "calendar_list_events"],
    );
    expect(result?.blueprintId).toBe("plan-my-week");
  });

  it("curated outranks llm outranks heuristic on equal overlap + score", () => {
    const byHeuristic = matchBlueprint(
      [
        bp({ blueprintId: "bp_h", dataTools: ["a"], source: "heuristic" }),
        bp({ blueprintId: "bp_l", dataTools: ["a"], source: "llm" }),
        bp({ blueprintId: "bp_c", dataTools: ["a"], source: "curated" }),
      ],
      ["a"],
    );
    expect(byHeuristic?.blueprintId).toBe("bp_c");

    const byLlm = matchBlueprint(
      [
        bp({ blueprintId: "bp_h", dataTools: ["a"], source: "heuristic" }),
        bp({ blueprintId: "bp_l", dataTools: ["a"], source: "llm" }),
      ],
      ["a"],
    );
    expect(byLlm?.blueprintId).toBe("bp_l");
  });

  it("a high-score llm blueprint can beat a low-overlap curated one", () => {
    const result = matchBlueprint(
      [
        // curated, overlap 1, score default (1): rank = 1 × 3 × 1 = 3
        bp({ blueprintId: "curated_shallow", dataTools: ["a"], source: "curated" }),
        // llm, overlap 1, score 10: rank = 1 × 2 × 10 = 20
        bp({ blueprintId: "llm_proven", dataTools: ["a"], source: "llm", score: 10 }),
      ],
      ["a"],
    );
    expect(result?.blueprintId).toBe("llm_proven");
  });

  it("stable tie-break preserves input order on identical rank", () => {
    const result = matchBlueprint(
      [
        bp({ blueprintId: "first", dataTools: ["a"] }),
        bp({ blueprintId: "second", dataTools: ["a"] }),
      ],
      ["a"],
    );
    expect(result?.blueprintId).toBe("first");
  });
});

describe("matchBlueprint — status filtering", () => {
  it("stale and retired blueprints are ignored", () => {
    const result = matchBlueprint(
      [
        bp({ blueprintId: "stale", dataTools: ["a"], status: "stale" }),
        bp({ blueprintId: "retired", dataTools: ["a"], status: "retired" }),
        bp({ blueprintId: "active", dataTools: ["a"], status: "active" }),
      ],
      ["a"],
    );
    expect(result?.blueprintId).toBe("active");
  });

  it("all candidates inactive → null", () => {
    const result = matchBlueprint(
      [
        bp({ blueprintId: "stale", dataTools: ["a"], status: "stale" }),
        bp({ blueprintId: "retired", dataTools: ["a"], status: "retired" }),
      ],
      ["a"],
    );
    expect(result).toBeNull();
  });
});

describe("matchBlueprint — plan-my-week vs sibling hypothetical", () => {
  it("prefers the 2-tool Plan My Week over a 1-tool fallback when both qualify", () => {
    // Real scenario: render arrives with sourceTools: [get_tasks, calendar_list_events].
    // Two candidates — a composed Plan My Week and a solo tasks-list screen.
    // Composed wins by overlap.
    const candidates: MatchableBlueprint[] = [
      bp({
        blueprintId: "todoist-list",
        serverId: "platform_todoist",
        dataTools: ["get_tasks"],
      }),
      bp({
        blueprintId: "plan-my-week",
        serverId: "_composed",
        dataTools: ["get_tasks", "calendar_list_events"],
      }),
    ];
    const result = matchBlueprint(candidates, ["get_tasks", "calendar_list_events"]);
    expect(result?.blueprintId).toBe("plan-my-week");
    expect(result?.serverId).toBe("_composed");
  });
});
