// core/src/benchmarks/multi-sdk/fixtures/activity-feed.fixture.ts

import type { BenchmarkFixture } from "./types";

export const activityFeed: BenchmarkFixture = {
  id: "activity-feed",
  name: "Team Activity Feed",
  description: "Timeline of team activity with live append + pagination",
  complexity: "medium",
  expectedMinScore: 55,
  shellType: "fullscreen",
  screen: "universal",

  prompt: `Build a team activity feed that shows a chronological timeline of events.

Layout:
- Vertical timeline. Each entry shows an actor avatar, the action verb, the subject, a relative timestamp ("2m ago", "1h ago"), and a small icon keyed to the action type.
- Group entries by day with a sticky date header.
- Newest at the top.

Realtime:
- New activities arrive via stream and are prepended to the list with a subtle slide-in animation.
- Show an unread count badge if the user has scrolled away from the top.

Pagination:
- Infinite scroll from the bottom: when the user scrolls near the end, fetch older activities via the loadOlder tool.
- Show a small loader at the bottom while fetching.

Requirements:
- Initial activities come from props.
- Time formatting uses relative style for recent items, absolute for older.
- Use design system CSS variables.`,

  contract: {
    intent: "Show a live team activity timeline with pagination",
    propsSpec: {
      properties: {
        activities: {
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                type: {
                  type: "string",
                  enum: ["commit", "comment", "review", "merge", "release", "mention"],
                },
                actor: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    avatar: { type: "string" },
                  },
                },
                subject: { type: "string" },
                timestamp: { type: "string" },
                link: { type: "string" },
              },
            },
          },
          required: true,
          description: "Initial activity entries, newest first",
        },
      },
    },
    streamSpec: {
      newActivity: {
        description: "A new activity was recorded — prepend to the list",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: ["commit", "comment", "review", "merge", "release", "mention"],
            },
            actor: {
              type: "object",
              properties: {
                name: { type: "string" },
                avatar: { type: "string" },
              },
            },
            subject: { type: "string" },
            timestamp: { type: "string" },
            link: { type: "string" },
          },
        },
        example: {
          id: "a101",
          type: "comment",
          actor: { name: "Dana", avatar: "" },
          subject: "Left a comment on PR #234",
          timestamp: "2026-04-14T10:00:00Z",
          link: "https://x.test/pr/234",
        },
      },
    },
    agentCapabilities: {
      tools: {
        loadOlder: {
          description: "Fetch older activities for infinite scroll",
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
              activities: { type: "array", items: { type: "object" } },
              hasMore: { type: "boolean" },
            },
          },
          example: {
            input: { before: "2026-04-10T00:00:00Z", limit: 50 },
            output: { activities: [], hasMore: true },
          },
        },
      },
    },
  },

  props: {
    activities: [
      { id: "a1", type: "commit", actor: { name: "Alice", avatar: "" }, subject: "Pushed 3 commits to main", timestamp: "2026-04-14T09:55:00Z", link: "" },
      { id: "a2", type: "review", actor: { name: "Bob", avatar: "" }, subject: "Approved PR #232", timestamp: "2026-04-14T09:40:00Z", link: "" },
      { id: "a3", type: "comment", actor: { name: "Charlie", avatar: "" }, subject: "Commented on issue #211", timestamp: "2026-04-14T09:10:00Z", link: "" },
      { id: "a4", type: "merge", actor: { name: "Dana", avatar: "" }, subject: "Merged PR #230 to main", timestamp: "2026-04-13T17:00:00Z", link: "" },
      { id: "a5", type: "release", actor: { name: "CI", avatar: "" }, subject: "Released v2.3.1", timestamp: "2026-04-13T16:00:00Z", link: "" },
    ],
  },

  expected: {
    vector: {
      render: "timeline",
      state: "merge",
      writes: "none",
      writeTrigger: "click",
      realtime: "append",
      fetch: "pagination",
      layout: "single",
    tooling: "wired",
    },
    riskTier: "medium",
    provenance: {
      render: "prompt",
      state: "contract",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "default",
    tooling: "contract",
    },
  },

  whyNotReducible: `
    - render=timeline: first timeline fixture. Contract is arr<obj> with timestamps,
      but the classifier needs prompt signal ("vertical timeline", "grouped by day")
      to distinguish timeline from list.
    - realtime=append in isolation: chat-interface has append mixed with presence;
      this is a pure append stream without any other kind, testing that the
      classifier handles single-kind append correctly.
    - fetch=pagination via infinite-scroll-at-bottom: inbox-triage paginates at
      stack-bottom (swipe-driven); this paginates at scroll-position (list-driven).
      Same axis value, different trigger context — relevant for harness fragments
      but the classifier axis is the same.
    - state=merge with both stream append AND pagination append: two sources add
      to the live list. The harness runtime must handle both without double-adding.
  `.trim(),

  evalGoals: [
    "useState seeded from props.activities, prepended on newActivity stream",
    "Timeline visual layout (vertical stream with timestamps, not flat list)",
    "Date-group headers (sticky or inline) separating days",
    "New-activity animation on stream arrival",
    "Scroll-near-bottom triggers loadOlder and appends results",
    "Loader indicator during pagination fetch",
    "No duplicate entries when stream fires (dedupe by id)",
    "No hardcoded activity data in source",
  ],
};

export default activityFeed;
