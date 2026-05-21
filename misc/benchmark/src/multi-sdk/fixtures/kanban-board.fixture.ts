// core/src/benchmarks/multi-sdk/fixtures/kanban-board.fixture.ts

import { retrofit } from "./retrofit";

export const kanbanBoard = retrofit("kanban-board", {
  expected: {
    vector: {
      render: "grid",
      state: "merge",
      writes: "per-item",
      // prompt says "move button or dropdown" — explicit click, not drag
      writeTrigger: "click",
      realtime: "merge",
      // Single-kind stream → streamKinds omitted (only emitted for mixed)
      fetch: "none",
      layout: "single",
      tooling: "none",
    },
    riskTier: "high",
    provenance: {
      // prompt describes 3-column grouped layout; contract has arr<obj> columns
      render: "prompt",
      state: "contract",
      writes: "contract",
      // No explicit drag/swipe in prompt → classifier defaults to click
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "default",
      tooling: "default",
    },
  },
  evalGoals: [
    "tasks state seeded from props.tasks",
    "Stream handler for taskChanged merges by task.id (not append-only)",
    "taskUpdate invoked with correct {action, taskId, data} payload",
    "Grouping by column memoized (useMemo), not recomputed every render",
    "Each task card uses key={task.id}",
    "Move controls are explicit buttons/dropdowns (per prompt, not drag)",
  ],
  whyNotReducible:
    "Canonical active-mutation collection with stream reconciliation. " +
    "Explicit click-based writeTrigger (not drag) distinguishes this from plan-my-week. " +
    "Auto-promoted to high by state=merge + writes=per-item rule.",
});

export default kanbanBoard;
