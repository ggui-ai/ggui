// core/src/benchmarks/multi-sdk/fixtures/chat-interface.fixture.ts

import { retrofit } from "./retrofit";

export const chatInterface = retrofit("chat-interface", {
  expected: {
    vector: {
      render: "list",
      state: "merge",
      writes: "commit", // sendMessage creates a new entity; not mutating an existing one
      writeTrigger: "click",
      realtime: "mixed",
      streamKinds: { message: "append", typing: "presence" },
      fetch: "pagination",
      layout: "single",
      tooling: "wired",
    },
    riskTier: "high",
    provenance: {
      render: "contract",
      state: "contract",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "default",
    tooling: "contract",
    },
  },
  evalGoals: [
    "messages state seeded from props.messages, appended from message stream",
    "Typing indicator rendered conditionally from typing stream",
    "sendMessage invoked with {text, timestamp} on send",
    "loadHistory invoked when scrolled near top for pagination",
    "Grouped-by-sender rendering per prompt",
    "Stable keys on message elements",
  ],
  whyNotReducible:
    "Canonical mixed realtime: append (new messages) + presence (typing). " +
    "writes=commit (not per-item) because sendMessage creates new entity without targeting existing. " +
    "Auto-promoted to high by realtime=mixed.",
});

export default chatInterface;
