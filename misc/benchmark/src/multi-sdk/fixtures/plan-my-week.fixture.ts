// core/src/benchmarks/multi-sdk/fixtures/plan-my-week.fixture.ts

import type { BenchmarkFixture } from "./types";

export const planMyWeek: BenchmarkFixture = {
  id: "plan-my-week",
  name: "Plan My Week",
  description: "Drag tasks from todoist onto a 7-day calendar grid",
  complexity: "complex",
  expectedMinScore: 50,
  shellType: "fullscreen",
  screen: "desktop",

  prompt: `Build a weekly planner that lets the user drag tasks onto a calendar to schedule them.

Layout:
- Left pane (1/3 width): a scrollable list of unscheduled tasks. Each task card shows title, priority badge, and a "due date" label if present.
- Right pane (2/3 width): a 7-day × 12-hour calendar grid for the upcoming week. Existing calendar events render as blocks in their time cells.

Interactions:
- The user drags a task card from the left pane onto a cell in the calendar grid. Dropping schedules the task at that time — the task is removed from the unscheduled list and a new calendar event appears in the grid. Fires the scheduleTask action with taskId, start, and end.
- Clicking a scheduled event on the calendar removes it from the grid and sends it back to the task list (unschedule).
- Keep the two panes in sync: when a task is scheduled, it should immediately disappear from the left pane and appear on the calendar.

Requirements:
- Initial tasks and events come from props.
- Use design system CSS variables. Show a clear visual drop target while dragging.
- Time slots should be 1-hour cells.`,

  contract: {
    intent: "Schedule todoist tasks onto a weekly calendar via drag-and-drop",
    propsSpec: {
      properties: {
        tasks: {
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                priority: { type: "string", enum: ["low", "medium", "high"] },
                dueDate: { type: "string" },
                estimatedMinutes: { type: "number" },
              },
            },
          },
          required: true,
          description: "Unscheduled tasks from todoist",
        },
        events: {
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                start: { type: "string" },
                end: { type: "string" },
                sourceTaskId: { type: "string" },
              },
            },
          },
          required: true,
          description: "Existing calendar events for the displayed week",
        },
        weekStart: {
          schema: { type: "string" },
          required: true,
          description: "ISO date of Monday of the displayed week",
        },
      },
    },
    actionSpec: {
      scheduleTask: {
        label: "Schedule Task",
        description:
          "Create a calendar event from a task and mark the task as scheduled. Fires todoist_update_task and gcal_create_event via the agent.",
        nextStep: "plan_schedule_task",
        example: {
          taskId: "t1",
          start: "2026-04-15T09:00:00Z",
          end: "2026-04-15T10:00:00Z",
        },
      },
      unscheduleEvent: {
        label: "Unschedule Event",
        description:
          "Remove the calendar event and return the task to the unscheduled list.",
        nextStep: "plan_unschedule",
        example: { eventId: "e1", taskId: "t1" },
      },
    },
  },

  props: {
    weekStart: "2026-04-14",
    tasks: [
      { id: "t1", title: "Review Q2 goals", priority: "high", dueDate: "2026-04-18", estimatedMinutes: 60 },
      { id: "t2", title: "Write design doc", priority: "high", estimatedMinutes: 120 },
      { id: "t3", title: "Email recruiter", priority: "medium", estimatedMinutes: 15 },
      { id: "t4", title: "1:1 with Alex", priority: "low", estimatedMinutes: 30 },
    ],
    events: [
      { id: "e1", title: "Sprint planning", start: "2026-04-14T10:00:00Z", end: "2026-04-14T11:00:00Z" },
      { id: "e2", title: "Team lunch", start: "2026-04-16T12:00:00Z", end: "2026-04-16T13:00:00Z" },
    ],
  },

  blueprint: {
    mechanic: "drag",
    layoutHint: "master-detail-split",
  },

  expected: {
    vector: {
      render: "master-detail", // list on left, calendar grid on right
      state: "merge", // both tasks[] and events[] held as live state
      writes: "compose", // scheduleTask references both taskId (from tasks) and creates event
      writeTrigger: "drag",
      realtime: "none", // no stream events declared
      fetch: "none",
      layout: "master-detail",
    tooling: "none",
    },
    riskTier: "high", // writeTrigger=drag auto-promotes to high
    provenance: {
      render: "blueprint",
      state: "contract",
      // unscheduleEvent payload {eventId, taskId} references two entity
      // collections (events + tasks) — contract alone identifies compose.
      writes: "contract",
      writeTrigger: "blueprint",
      realtime: "contract",
      fetch: "contract",
      layout: "blueprint",
    tooling: "default",
    },
  },

  whyNotReducible: `
    - writes=compose: first fixture where a single trigger produces an action whose
      semantic is cross-service (todoist update + gcal create). Contract shows only
      one ActionEntry but the payload pulls from two entity collections (tasks AND
      events).
    - writeTrigger=drag: first drag-shaped fixture. kanban implicitly uses drag in
      the prompt but the contract gives no gesture signal; this fixture uses the
      blueprint field for the first time.
    - render/layout=master-detail: no prior fixture splits into two panes.
    - state=merge without realtime: stock-ticker has merge via streams, kanban has
      merge via actions. plan-my-week has merge via both action types without any
      stream, so state inference must work from entity-list + mutating action alone.
  `.trim(),

  evalGoals: [
    "Two separate useState calls seed tasks[] and events[] from props",
    "Drag handlers (onDragStart on task cards, onDrop on calendar cells) exist",
    "Drop on a calendar cell: removes task from tasks state AND adds event to events state",
    "scheduleTask action invoked with correct taskId, start, end from the drop target",
    "Click on a calendar event invokes unscheduleEvent and restores the task to tasks[]",
    "Calendar grid renders 7 columns × 12 rows (or equivalent) positioned layout",
    "Task cards and events each use stable keys (item.id)",
    "No hardcoded task or event data in the render body",
    "Visual drop-target indicator during drag (prompt requirement)",
  ],
};

export default planMyWeek;
