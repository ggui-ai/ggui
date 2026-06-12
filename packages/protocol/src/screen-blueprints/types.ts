/**
 * ScreenBlueprint — authored design for a ggui screen.
 *
 * A blueprint describes:
 *   - which MCP tools provide the data
 *   - which MCP tools the agent SHOULD call after each user gesture
 *     (`actionSpec[*].nextStep` hints surfaced on `ggui_consume`)
 *   - the intent, interaction mechanic, and a free-form layout hint
 *
 * Blueprints compile deterministically into {@link DataContract}. They are the
 * authoring surface of the Screen Designer pipeline — every producer emits the
 * same shape and stamps its provenance as a {@link BlueprintSource}.
 */
import type { JsonSchema } from "../types/data-contract.js";
import type { BlueprintSource } from "../types/blueprint-source.js";

/**
 * UI interaction mechanic hint. Tiny enum — generation uses it to select
 * primitives (live-polling hook vs static form). Layout details live in
 * {@link ScreenBlueprint.layoutHint} (free text). The `drag` / `swipe`
 * members were deleted in draft-2026-06-12 — no authored blueprint ever
 * used them (the generator's gesture classification infers drag/swipe
 * from the prompt instead); they re-enter when a real blueprint does.
 */
export type ScreenMechanic = "static" | "live" | "form";

/**
 * Data source for a single prop slot. The tool's outputSchema becomes the
 * prop's schema (optionally unwrapped via `pick`). For `live` mechanic,
 * `refresh` declares polling/subscription cadence.
 */
export interface ScreenBlueprintDataSource {
  /** MCP tool name that produces this prop's data. */
  tool: string;
  /**
   * Optional field path into the tool's outputSchema to use as the prop.
   * Example: `tool: "todoist_list_tasks"` returns `{ tasks, nextPageToken }`.
   * `pick: "tasks"` uses just the `tasks` array schema as the prop.
   */
  pick?: string;
  /**
   * Refresh cadence for live widgets. Only meaningful with `mechanic: "live"`.
   * `poll` = seconds between re-fetches. `subscribe` = agent pushes via stream.
   */
  refresh?: { poll?: number; subscribe?: boolean };
}

/**
 * Direct action — one user interaction fires one MCP tool call. By convention,
 * the payload keys match the tool's inputSchema keys (identity mapping). If a
 * future blueprint needs to reshape the payload before dispatch, add a
 * `payloadMapping` field here AND wire it through the compiler + contract in
 * the same change.
 */
export interface ScreenBlueprintDirectAction {
  /** MCP tool to invoke when the user triggers this action. */
  tool: string;
  /** Human-readable description; drives the button label fallback. */
  description?: string;
  /**
   * Optional JSON Schema for the user-side payload. If omitted, the tool's
   * inputSchema is used as the payload shape directly.
   */
  payload?: JsonSchema;
  /** Show confirmation prompt before firing. */
  confirm?: boolean;
}

/**
 * Orchestrated action — one user interaction fires N MCP tool calls.
 * Dispatch is agent-owned: the host renders the interaction and emits a
 * consume event; the agent receives the event + `fires` hint and
 * sequences the tool calls itself. No multi-tool dispatch protocol in v1.
 */
export interface ScreenBlueprintOrchestratedAction {
  /** Human-readable description; drives the button label. Required here. */
  description: string;
  /** User-side payload shape. Required — the agent needs it to orchestrate. */
  payload: JsonSchema;
  /**
   * Advisory hint: which MCP tools the agent is expected to fire. Not
   * dispatched by the host — metadata for docs, admin UI, and the agent's
   * orchestration reasoning.
   */
  fires: string[];
  /** Show confirmation prompt before firing. */
  confirm?: boolean;
}

/** Deep-link-only action — opens a URL, no tool call. */
export interface ScreenBlueprintDeepLinkAction {
  /** URL template. May contain placeholders `{prop.path}` resolved at render. */
  deepLink: string;
  /** Human-readable description; drives the button label. */
  description?: string;
}

/**
 * Action variants — the three ways a user interaction can be wired.
 *
 * Discriminated by presence of `tool` / `fires` / `deepLink`. Compiler
 * uses the discriminator to pick an ActionEntry shape.
 */
export type ScreenBlueprintAction =
  | ScreenBlueprintDirectAction
  | ScreenBlueprintOrchestratedAction
  | ScreenBlueprintDeepLinkAction;

/**
 * A screen blueprint — the authored design record.
 *
 * @example
 * ```ts
 * export default defineScreenBlueprint({
 *   id: "plan-my-week",
 *   server: "_composed",
 *   displayName: "Plan My Week",
 *   intent: "Drag tasks onto a weekly calendar to schedule focus blocks",
 *   data: {
 *     tasks:  { tool: "todoist_list_tasks", pick: "tasks" },
 *     events: { tool: "gcal_list_events",    pick: "events" },
 *   },
 *   actions: {
 *     scheduleTask: {
 *       description: "Schedule a task as a calendar focus block",
 *       payload: { type: "object", properties: { ... } },
 *       fires: ["todoist_update_task", "gcal_create_event"],
 *     },
 *     completeTask: { tool: "todoist_complete_task" },
 *   },
 *   layoutHint: "Left: task cards. Right: 7-day grid. Drag to schedule.",
 *   source: { kind: "curated" },
 * });
 * ```
 */
export interface ScreenBlueprint {
  /** Unique identifier within `server`. URL-safe. */
  id: string;
  /**
   * Owning MCP server's `serverId`, or `"_composed"` for cross-server
   * blueprints (blueprints that draw from multiple servers, like Plan My Week
   * using Todoist + Google Calendar).
   */
  server: string;
  /** Human-readable name shown in admin UI / docs. */
  displayName: string;
  /** Concise purpose — becomes `DataContract.intent`. Used for caching. */
  intent: string;
  /** Interaction mechanic hint for the generator. Defaults to `"static"`. */
  mechanic?: ScreenMechanic;
  /**
   * Data sources keyed by prop name. Each source's tool outputSchema becomes
   * the prop schema (optionally unwrapped via `pick`).
   */
  data: Record<string, ScreenBlueprintDataSource>;
  /** User-triggerable actions keyed by action name. */
  actions?: Record<string, ScreenBlueprintAction>;
  /** Free-form layout guidance passed to the generator as prompt context. */
  layoutHint?: string;
  /**
   * Provenance — who authored this blueprint ({@link BlueprintSource}).
   * Required: every producer stamps its own arm at mint time, and the
   * match ranker weighs it. Unlabeled blueprints are not a real state.
   */
  source: BlueprintSource;
}
