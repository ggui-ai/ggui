// core/src/benchmarks/multi-sdk/fixtures/flight-status.fixture.ts

import type { BenchmarkFixture } from "./types";

export const flightStatus: BenchmarkFixture = {
  id: "flight-status",
  name: "Flight Status Widget",
  description: "Compact flight tracker with live status updates",
  complexity: "simple",
  expectedMinScore: 60,
  shellType: "chat",
  screen: "universal",

  prompt: `Build a compact flight status widget that lives inline in a chat conversation.

Layout (single card, no full-screen takeover):
- Top: flight number, airline, and route (origin → destination) with airport codes.
- Center: big status badge ("On time", "Delayed 15m", "Boarding", "In air", "Landed"). Color-coded by status.
- Below status: gate, scheduled departure, and estimated departure times.
- Bottom: an ETA progress bar if in-air, or a countdown to boarding if scheduled.

Real-time updates:
- Flight status changes arrive via stream — the banner and badge update automatically.
- Delays and gate changes should flash briefly to draw attention.

Requirements:
- Initial flight data comes from props. Never hardcode flight numbers or times.
- Compact enough to embed in a chat message. Do not take over the screen.
- Use design system CSS variables.`,

  contract: {
    intent: "Track a single flight's real-time status",
    propsSpec: {
      properties: {
        flight: {
          schema: {
            type: "object",
            properties: {
              number: { type: "string" },
              airline: { type: "string" },
              origin: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  city: { type: "string" },
                },
              },
              destination: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  city: { type: "string" },
                },
              },
              status: {
                type: "string",
                enum: ["scheduled", "boarding", "departed", "in-air", "landed", "delayed", "cancelled"],
              },
              scheduledDeparture: { type: "string" },
              estimatedDeparture: { type: "string" },
              gate: { type: "string" },
              terminal: { type: "string" },
              delayMinutes: { type: "number" },
              progress: { type: "number" },
            },
          },
          required: true,
          description: "Flight detail for the tracked flight",
        },
      },
    },
    streamSpec: {
      flightUpdate: {
        description: "Status, gate, or timing changes",
        schema: {
          type: "object",
          properties: {
            flightNumber: { type: "string" },
            status: {
              type: "string",
              enum: ["scheduled", "boarding", "departed", "in-air", "landed", "delayed", "cancelled"],
            },
            gate: { type: "string" },
            estimatedDeparture: { type: "string" },
            delayMinutes: { type: "number" },
            progress: { type: "number" },
          },
        },
        example: {
          flightNumber: "UA342",
          status: "delayed",
          delayMinutes: 18,
          estimatedDeparture: "2026-04-14T14:18:00Z",
        },
      },
    },
  },

  props: {
    flight: {
      number: "UA342",
      airline: "United Airlines",
      origin: { code: "SFO", city: "San Francisco" },
      destination: { code: "JFK", city: "New York" },
      status: "boarding",
      scheduledDeparture: "2026-04-14T14:00:00Z",
      estimatedDeparture: "2026-04-14T14:00:00Z",
      gate: "B23",
      terminal: "2",
      delayMinutes: 0,
      progress: 0,
    },
  },

  expected: {
    vector: {
      render: "static",
      state: "merge",
      writes: "none",
      writeTrigger: "click",
      // flightUpdate has flightNumber + status enum + other fields.
      // Entity-targeted (flight singleton) → merge, not status.
      // 'status' is reserved for non-entity singleton state like marketStatus.
      realtime: "merge",
      fetch: "none",
      layout: "single",
    tooling: "none",
    },
    riskTier: "medium",
    provenance: {
      render: "contract",
      state: "contract",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "default",
    tooling: "default",
    },
  },

  whyNotReducible: `
    - realtime=status (singleton replace) in isolation: stock-ticker has mixed
      streams; uber-ride has mixed (merge+status). This is a clean single-kind
      status-only stream, testing that the classifier distinguishes pure-status
      from merge-style updates.
    - render=static + state=merge without an entity list: the tracked flight is a
      single object prop, not arr<obj>. Merge state applies even without a
      collection — state seeded from props.flight, updated via stream.
    - shellType=chat: first widget-shaped fixture meant to embed inline in a chat
      message. Layout should stay compact.
  `.trim(),

  evalGoals: [
    "useState seeded from props.flight, updated on flightUpdate stream",
    "Status badge reflects current state, not props directly",
    "Delay and gate fields update when stream fires",
    "No entity merge-by-id (flight is a singleton, just replace)",
    "Flash or transition animation on status change",
    "Component is compact (chat-embed sized), not full-screen takeover",
    "No hardcoded flight number or times in source",
  ],
};

export default flightStatus;
