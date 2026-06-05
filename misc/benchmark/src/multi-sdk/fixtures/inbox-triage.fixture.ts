// core/src/benchmarks/multi-sdk/fixtures/inbox-triage.fixture.ts

import type { BenchmarkFixture } from "./types";

export const inboxTriage: BenchmarkFixture = {
  id: "inbox-triage",
  name: "Inbox Triage",
  description: "Swipe-based card stack for rapid email disposition",
  complexity: "medium",
  expectedMinScore: 55,
  shellType: "fullscreen",
  screen: "mobile",

  prompt: `Build a swipe-based inbox triage screen.

Layout:
- One email at a time, displayed as a full-screen card with sender, subject, snippet, and timestamp.
- Show a peek of the next 1-2 cards behind it so the stack is visible.
- Counter at the top showing "X of Y" remaining.

Interactions — the user disposes of each email with a swipe gesture:
- Swipe right: reply action (opens quick reply).
- Swipe left: archive action.
- Swipe up: convert to a task.

Each swipe removes the current card and reveals the next. Infinite scroll: when fewer than 5 cards remain, fetch older emails via the loadOlder tool.

Requirements:
- Initial emails come from props.
- Visual feedback during drag (card tilts, colored indicator showing disposition).
- Use design system CSS variables.`,

  contract: {
    intent: "Rapid email triage via swipe gestures",
    propsSpec: {
      properties: {
        emails: {
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                sender: { type: "string" },
                subject: { type: "string" },
                snippet: { type: "string" },
                timestamp: { type: "string" },
                labels: { type: "array", items: { type: "string" } },
              },
            },
          },
          required: true,
          description: "Emails queued for triage",
        },
      },
    },
    actionSpec: {
      reply: {
        label: "Reply",
        description: "Send a quick reply and archive",
        nextStep: "gmail_send_reply",
        example: { emailId: "e1", body: "Thanks, will review." },
      },
      archive: {
        label: "Archive",
        description: "Archive without reply",
        nextStep: "gmail_archive",
        example: { emailId: "e1" },
      },
      convertToTask: {
        label: "Convert to Task",
        description: "Create a todoist task from the email",
        nextStep: "todoist_create_from_email",
        example: { emailId: "e1", title: "Follow up on Q2 review", dueDate: "2026-04-20" },
      },
    },
    agentCapabilities: {
      tools: {
        loadOlder: {
          toolInfo: {
            description: "Fetch older emails when the swipe stack runs low",
            inputSchema: {
              type: "object",
              properties: {
                before: { type: "string" },
                limit: { type: "number" },
              },
            },
            outputSchema: {
              type: "object",
              properties: {
                emails: { type: "array", items: { type: "object" } },
                hasMore: { type: "boolean" },
              },
            },
          },
          example: {
            input: { before: "2026-04-10T00:00:00Z", limit: 20 },
            output: { emails: [], hasMore: true },
          },
        },
      },
    },
  },

  props: {
    emails: [
      { id: "e1", sender: "Alice", subject: "Q2 goals review", snippet: "Can we meet Thu to...", timestamp: "2026-04-14T09:00:00Z", labels: ["work"] },
      { id: "e2", sender: "Bob", subject: "Design doc ready", snippet: "Doc is in Figma, please...", timestamp: "2026-04-14T08:30:00Z", labels: ["design"] },
      { id: "e3", sender: "Charlie", subject: "Lunch tomorrow?", snippet: "Free at noon?", timestamp: "2026-04-14T08:10:00Z", labels: [] },
      { id: "e4", sender: "Newsletter", subject: "Weekly digest", snippet: "5 stories you might have missed", timestamp: "2026-04-14T07:00:00Z", labels: ["newsletter"] },
    ],
  },

  blueprint: {
    mechanic: "swipe",
    layoutHint: "modal-card-stack",
  },

  expected: {
    vector: {
      render: "static",
      state: "merge",
      writes: "per-item",
      writeTrigger: "swipe",
      realtime: "none",
      fetch: "pagination",
      layout: "modal",
    tooling: "wired",
    },
    riskTier: "high",
    provenance: {
      render: "blueprint",
      state: "contract",
      writes: "contract",
      writeTrigger: "blueprint",
      realtime: "contract",
      fetch: "contract",
      layout: "blueprint",
    tooling: "contract",
    },
  },

  whyNotReducible: `
    - writeTrigger=swipe: first fixture using swipe. No prior fixture exercises
      gesture-based write dispatch where the gesture direction selects one of N actions.
    - state=ui-affordance + writes=per-item: unusual combination. Current card
      index is ui-affordance state; dispositions are per-item actions. Not merge
      (the stack isn't mutated live; it's walked through).
    - render=static with a stack peek: one entity visible at a time despite arr<obj>
      input. Different from list/grid where all items render simultaneously.
    - fetch=pagination triggered by stack-running-low, not scroll-to-bottom.
    - layout=modal: first non-single, non-multi-step, non-overlay layout.
  `.trim(),

  evalGoals: [
    "Current card shows one email from props.emails at a time (not all as list)",
    "ui-state tracks current index (useState<number>)",
    "Swipe handlers mapped: right=reply, left=archive, up=convertToTask",
    "Each action invoked with the correct emailId and payload shape",
    "Card transitions advance index, revealing next email",
    "Stack peek shows next 1-2 cards behind current",
    "loadOlder fetched when remaining cards < threshold",
    "Visual feedback during swipe (drag indicator, color/tilt)",
    "No hardcoded emails in render",
  ],
};

export default inboxTriage;
