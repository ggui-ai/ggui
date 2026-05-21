// packages/ui-gen/src/classifier/axes.ts
//
// Multi-axis authoring classification types.
//
// Pure type module, zero runtime, zero dependencies.

// =============================================================================
// Axis 1: render — how data is visually presented
// =============================================================================

export type RenderShape =
  | "static"         // single-entity detail card (weather card, product page, profile)
  | "list"           // items as rows/cards (task list, inbox, forecast strip)
  | "grid"           // 2D tile layout (icon grid, periodic table, image gallery)
  | "spatial"        // geo/coord-driven (map, floor plan, room layout)
  | "timeline"       // temporal axis (schedule, activity feed, git history)
  | "chart"          // numeric → visual (line, bar, pie)
  | "master-detail"; // list + adjacent detail panel (inbox + email, explorer)

// =============================================================================
// Axis 2: state — what local state the component owns
// =============================================================================

export type StateShape =
  | "none"          // props → JSX, no useState
  | "ui-affordance" // filter text / selected id / active tab / quantity
  | "merge"         // live entity state: useState(props.X) + useStream merge
  | "payload"       // accumulating form data with validation/step
  | "draft";        // editing ONE item in-place

// =============================================================================
// Axis 3: writes — what write surface exists
// =============================================================================

export type WriteShape =
  | "none"         // read-only
  | "commit"       // single small-payload action (product-page: addToCart)
  | "multi-commit" // multiple unrelated single-commits (Uber: cancel/change/contact)
  | "per-item"     // entity list with per-row actions (todoist toggle)
  | "submit"       // terminal form submit with assembled payload
  | "compose";     // one trigger → action referencing ids from multiple entities

// Orthogonal: how the write is triggered
export type WriteTrigger =
  | "click"      // standard button
  | "drag"       // drag-drop (libraries, coord tracking, visual feedback)
  | "swipe"      // gesture → one of N actions
  | "keystroke" // keyboard shortcut
  | "auto";      // effect-driven (autosave, debounced)

// =============================================================================
// Axis 4: realtime — stream semantics
// =============================================================================

export type RealtimeShape =
  | "none"
  | "merge"      // stream payload has id → update entity by id
  | "append"     // new entity added (chat new message)
  | "status"     // singleton state replace (market open/closed, ride status)
  | "presence"   // ephemeral per-user state (typing, cursor, online)
  | "mixed";     // multiple streams of different kinds

export type StreamEventKind = "merge" | "append" | "status" | "presence" | "other";

// =============================================================================
// Axis 5: fetch — on-demand data loading
// =============================================================================

export type FetchShape =
  | "none"
  | "pagination"  // loadMore / nextPage (request has cursor/offset)
  | "search"      // query → results (request has `query`)
  | "drill-down"  // click entity → fetch detail (request has `id`)
  | "refresh";    // pull-to-refresh / periodic poll

// =============================================================================
// Axis 6: layout — structural composition
// =============================================================================

export type LayoutShape =
  | "single"        // one screen
  | "multi-step"    // wizard/stepper
  | "master-detail" // list + detail panel
  | "overlay"       // controls on top of content
  | "modal";        // dialog / sheet / drawer

// =============================================================================
// Axis 7: tooling — agent-side catalog / client-side capability presence
// =============================================================================

export type ToolingShape =
  | "none"    // contract has no agentCapabilities.tools and no clientCapabilities.libraries
  | "wired"   // agentCapabilities.tools present (catalog referenced via actionSpec.nextStep / streamSpec.source.tool)
  | "client"  // clientCapabilities.libraries present (browser-capability hooks the component imports)
  | "both";   // contract exposes both catalogs

// =============================================================================
// AxisVector — descriptive, no policy
// =============================================================================

export interface AxisVector {
  render: RenderShape;
  state: StateShape;
  writes: WriteShape;
  writeTrigger: WriteTrigger;
  realtime: RealtimeShape;
  /** When realtime === 'mixed', per-event kind breakdown. */
  streamKinds?: Record<string, StreamEventKind>;
  fetch: FetchShape;
  layout: LayoutShape;
  tooling: ToolingShape;
}

// =============================================================================
// Provenance — which signal source decided each axis
// =============================================================================

export type AxisSource =
  | "contract"
  | "blueprint"
  | "prompt"
  | "heuristic"
  | "default";

export interface AxisProvenance {
  render: AxisSource;
  state: AxisSource;
  writes: AxisSource;
  writeTrigger: AxisSource;
  realtime: AxisSource;
  fetch: AxisSource;
  layout: AxisSource;
  tooling: AxisSource;
}

// =============================================================================
// Risk tier — harness eval policy, derived from AxisVector
// =============================================================================

export type RiskTier = "low" | "medium" | "high";

// =============================================================================
// Classification — the classifier's full output
// =============================================================================

export interface Classification {
  vector: AxisVector;
  provenance: AxisProvenance;
  riskTier: RiskTier;
}
