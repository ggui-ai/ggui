// Pin: the render axis is read from the PROMPT the generator is given, not
// from the judge's or the operator's wording. A board contract (columns of
// cards) with a placeholder prompt classifies as `list`; the same contract
// with the operator's sentence classifies as `grid` — so every consumer that
// composes a generation prompt must hand the request's intent through, or the
// grid gate never admits the board checks and the prompt teaches a list.
import type { DataContract } from "@ggui-ai/protocol";
import { describe, expect, it } from "vitest";
import { classifyAxes } from "./index.js";

const BOARD: DataContract = {
  propsSpec: {
    properties: {
      columns: {
        required: true,
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              cards: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } } },
            },
          },
        },
      },
    },
  },
  actionSpec: {
    moveCard: { label: "Move card", description: "Move a card to another column", schema: { type: "object", properties: { cardId: { type: "string" }, toColumnId: { type: "string" } } } },
  },
};

describe("render axis follows the generation prompt (board contract)", () => {
  it("a placeholder prompt classifies the board as `list`", () => {
    const c = classifyAxes({ contract: BOARD, prompt: "Operator-authored blueprint variant" });
    expect(c.vector.render).toBe("list");
  });

  it("the request's own sentence classifies it as `grid`", () => {
    const c = classifyAxes({ contract: BOARD, prompt: "a kanban board for this week" });
    expect(c.vector.render).toBe("grid");
  });
});
