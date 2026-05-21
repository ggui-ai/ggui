/**
 * Hand-curated synthesizer bench corpus.
 *
 * Each entry pairs a natural-language intent with the structural
 * contract shape we expect the synthesizer to produce. The shape is
 * intentionally coarse — we assert what specs MUST appear, what specs
 * MUST be absent, and (when applicable) which action / slot names are
 * acceptable. Exact action labels and schema details are out of scope
 * because LLM phrasing varies.
 *
 * Entries carry no hand-labeled archetype — the protocol thinks in
 * contract SHAPE, not interaction-pattern categories. The bench
 * report groups entries by `contractShape(entry.expected)`, derived
 * from which specs the expected contract declares: `props-only`,
 * `context-only`, `context+action`, `stream`, `with-gadgets`.
 *
 * Used by:
 *   - run-synth-bench.ts (live LLM probe — opt-in, costs ~$0.001/entry)
 *   - structure-bench.test.ts (deterministic validator-only check)
 */

import type { GadgetDescriptor } from '@ggui-ai/protocol';

export interface BenchEntry {
  readonly id: string;
  readonly intent: string;
  readonly expected: BenchExpectation;
  /**
   * Per-entry registered gadget catalog. When set, the runner
   * forwards this to `synthesizeContract`'s `appGadgets` option so
   * the synth LLM sees the same "AVAILABLE GADGETS" prompt block a
   * production server emits for an operator that registered these
   * gadget packages in `App.gadgets`.
   *
   * Use for `capability-plugin` cases that test whether the synth
   * reaches for an OPERATOR-REGISTERED 3rd-party gadget (Leaflet,
   * Mapbox, …) — distinct from the STDLIB `capability` cases which
   * rely on the hardcoded stdlib hint baked into the synth system
   * prompt.
   *
   * Pre-plugin entries leave this absent — synth falls through to
   * the static stdlib hint.
   */
  readonly appGadgets?: readonly GadgetDescriptor[];
}

export interface BenchExpectation {
  readonly hasActionSpec: boolean;
  readonly hasContextSpec: boolean;
  readonly hasStreamSpec: boolean;
  readonly hasProps: boolean;
  /**
   * EE+ wire-shape v2 surfaces (added 2026-05-11). Default to `false`
   * on legacy entries so the bench stays strict on the new shape only
   * where the corpus opts in.
   */
  readonly hasClientCapabilities?: boolean;
  readonly hasAgentTools?: boolean;
  /** Action names the synthesizer MAY emit. Match: at least one
   *  synthesized action name contains, or is contained by, an allowed
   *  name (case-insensitive — `nextStep` matches `next`). When
   *  `hasActionSpec=false`, this MUST be empty / omitted. */
  readonly actionNames?: readonly string[];
  /** Context slot names the synthesizer MAY emit. Match: at least one
   *  synthesized slot name contains, or is contained by, an allowed
   *  name (case-insensitive). Extra intent-specific slots are
   *  tolerated — the check verifies the synth landed a recognizable
   *  slot, not that it produced ONLY enumerated ones. */
  readonly contextSlots?: readonly string[];
  /** Gadget export names (hook or component) the synthesizer MAY
   *  declare on `clientCapabilities.gadgets` (the inner export key).
   *  Match is case-insensitive set-membership over the union of
   *  accepted names. Only checked when `hasClientCapabilities=true`. */
  readonly capabilityHooks?: readonly string[];
  /**
   * Gadget export names the synthesizer MUST NOT declare on
   * `clientCapabilities.gadgets`. Stricter dual of
   * `capabilityHooks` — catches the failure mode "intent doesn't
   * call for the gadget but the LLM over-eagerly attached it
   * anyway." Case-insensitive set-membership; checked
   * unconditionally (a contract with no clientCapabilities trivially
   * passes). Used by distractor cases where a gadget is REGISTERED
   * but the intent doesn't justify using it.
   */
  readonly forbiddenCapabilityHooks?: readonly string[];
  /** AgentTool catalog keys the synthesizer MAY emit. Used for
   *  source-fed-stream + action-nextStep cases. Match: at least one
   *  synthesized tool name contains, or is contained by, an allowed
   *  name (case-insensitive — `fetch_pending_jobs` matches `jobs`);
   *  the synth guesses these names, so paraphrase is tolerated, as
   *  with `actionNames`. Only checked when `hasAgentTools=true`. */
  readonly agentToolNames?: readonly string[];
  /** True when the corpus tolerates either shape (hard cases). When
   *  set, the bench reports the entry as `tolerated` regardless of
   *  hasActionSpec / hasContextSpec mismatches. */
  readonly tolerateEitherShape?: boolean;
  readonly notes?: string;
}

/**
 * Contract-shape bucket of an expected contract — the grouping the
 * bench report rolls precision up by, replacing the retired
 * interaction-archetype categories. Priority-ordered so each entry
 * lands in exactly one bucket: the most distinctive declared spec
 * wins (a gadget-bearing contract is `with-gadgets` regardless of
 * what else it declares; a stream-bearing one is `stream`; …).
 */
export function contractShape(expected: BenchExpectation): string {
  if (expected.hasClientCapabilities) return 'with-gadgets';
  if (expected.hasStreamSpec) return 'stream';
  if (expected.hasActionSpec) return 'context+action';
  if (expected.hasContextSpec) return 'context-only';
  if (expected.hasProps) return 'props-only';
  return 'empty';
}

/**
 * Canonical registered-package descriptor for the gadget-bearing
 * corpus cases. Mirrors what `@ggui-samples/gadget-leaflet` ships —
 * a single COMPONENT export (`<LeafletMap>`). The bench keeps the
 * descriptor inline so the corpus is self-contained — no workspace
 * cross-dependency.
 */
const LEAFLET_DESCRIPTOR: GadgetDescriptor = {
  package: '@ggui-samples/gadget-leaflet',
  version: '0.0.1',
  exports: [
    {
      component: 'LeafletMap',
      description:
        'Render an interactive Leaflet map with a tile layer, pan/zoom controls, and markers. The component owns the container, sizing, and lifecycle.',
      usage:
        'Render `<LeafletMap center={[lat, lng]} zoom={2..20} />` when the intent names a rendered map (location browsing, route preview, delivery tracking, points-of-interest grid).',
    },
  ],
};

/**
 * Registered mixed-package descriptor for the `capability-plugin` HOOK
 * case. Mirrors `@ggui-samples/gadget-chart` — a `Chart` COMPONENT
 * export plus a `useChartTheme` companion HOOK export. Exercises
 * whether synth declares a registered third-party HOOK (not just a
 * component) under `clientCapabilities.gadgets` — the dual of the
 * Leaflet (component-only) cases.
 */
const CHART_DESCRIPTOR: GadgetDescriptor = {
  package: '@ggui-samples/gadget-chart',
  version: '0.0.1',
  exports: [
    {
      component: 'Chart',
      description:
        'Render a responsive SVG bar chart from labelled magnitudes.',
      usage:
        'Render `<Chart data={[{ label, value }]} />` when the intent names a bar chart or a metric breakdown.',
    },
    {
      hook: 'useChartTheme',
      description:
        'Read the active ggui theme and return resolved chart colors — a categorical palette plus axis / label / grid colors.',
      usage:
        'Call `const theme = useChartTheme();` when a charted visualization should track the operator-selected app theme; pass `theme.palette[*]` as the series colors.',
    },
  ],
};

export const BENCH_CORPUS: readonly BenchEntry[] = [
  // ─── mutator-only: contextSpec mirror is the wire ─────────────────
  {
    id: 'mut-counter-1',
    intent: 'a simple counter widget with increment, decrement, and reset',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['count'],
      notes:
        'load-bearing case. Slot mirror IS the wire; declaring increment/decrement/reset actions creates a parallel wire path the generator wires up incorrectly.',
    },
  },
  {
    id: 'mut-counter-2',
    intent: 'make me a counter that goes up and down',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['count'],
    },
  },
  {
    id: 'mut-counter-3',
    intent: 'a labeled counter with a custom step size',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['count', 'step', 'label'],
      tolerateEitherShape: true,
      notes:
        'the live `count` is contextSpec; the static `label` + `step` are a genuine props-or-context judgment call — either shape is accepted.',
    },
  },
  {
    id: 'mut-toggle-1',
    intent: 'a dark-mode toggle switch',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['darkMode', 'enabled', 'mode'],
    },
  },
  {
    id: 'mut-toggle-2',
    intent: 'an on/off switch for notifications',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['enabled', 'notifications', 'on'],
    },
  },
  {
    id: 'mut-slider-1',
    intent: 'a volume slider that goes from 0 to 100',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['volume', 'value'],
    },
  },
  {
    id: 'mut-slider-2',
    intent: 'a brightness control slider',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['brightness', 'value'],
    },
  },
  {
    id: 'mut-picker-1',
    intent: 'a tab picker with home, profile, and settings tabs',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['selectedTab', 'tab', 'activeTab'],
    },
  },
  {
    id: 'mut-picker-2',
    intent: 'a color picker with red, green, blue, and yellow swatches',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['color', 'selectedColor'],
    },
  },
  {
    id: 'mut-search-livetype',
    intent: 'a search box that filters results live as the user types',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['query', 'searchText'],
      notes:
        'live-filter UIs do not need a discrete search action — the agent watches the query slot stream.',
    },
  },

  // ─── form: contextSpec for draft + actionSpec for submit ──────────
  {
    id: 'form-feedback-1',
    intent: 'a feedback form with a 5-star rating and a free-text comment',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['submit', 'submitFeedback', 'send'],
      contextSlots: ['rating', 'comment', 'draft', 'feedback'],
    },
  },
  {
    id: 'form-contact-1',
    intent: 'a contact form with name, email, and message fields',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['submit', 'send', 'submitContact'],
      contextSlots: ['name', 'email', 'message', 'draft', 'formData'],
    },
  },
  {
    id: 'form-login-1',
    intent: 'a login form with username and password and a sign-in button',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['signIn', 'login', 'submit', 'authenticate'],
      contextSlots: ['username', 'password', 'draft'],
    },
  },
  {
    id: 'form-notepad-save',
    intent: 'a notepad I can save',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['save', 'saveNote'],
      contextSlots: ['noteText', 'note', 'text', 'draft'],
    },
  },
  {
    id: 'form-confirm-1',
    intent: 'a confirmation dialog with confirm and cancel buttons',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['confirm', 'cancel'],
    },
  },
  {
    id: 'form-search-button',
    intent: 'a search box with a search button that runs on click',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['search', 'submitSearch', 'submit'],
      contextSlots: ['query', 'searchText'],
      notes:
        'explicit search button — discrete event with payload. Distinguish from live-filter (mut-search-livetype).',
    },
  },
  {
    id: 'form-survey-1',
    intent: 'a quick survey with three multiple-choice questions and a submit button',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['submit', 'submitSurvey', 'send'],
      notes:
        'no contextSlots assertion — a survey decomposes into per-question slots (question1, question2, …) or one aggregate; the names are intent-specific and cannot be enumerated.',
    },
  },
  {
    id: 'form-newsletter-1',
    intent: 'a newsletter signup with an email field and subscribe button',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['subscribe', 'submit', 'signUp'],
      contextSlots: ['email', 'draft'],
    },
  },

  // ─── list: many local-only lists need NO actionSpec ───────────────
  {
    id: 'list-todo-local',
    intent: 'a todo list where I can add and remove items',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['todos', 'items'],
      tolerateEitherShape: true,
      notes:
        'local-only todos need NO actionSpec. Synthesizer often emits add/delete actions here — the validator flags them as redundant-action. Tolerated either way; preferred shape is contextSpec only.',
    },
  },
  {
    id: 'list-shopping-local',
    intent: 'a shopping list',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['items', 'list'],
      tolerateEitherShape: true,
    },
  },
  {
    id: 'list-todo-agent-backed',
    intent: 'an agent-backed todo list that persists across sessions',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['addTodo', 'deleteTodo', 'add', 'delete', 'create', 'remove'],
      contextSlots: ['todos', 'items'],
      notes:
        'agent-backed = explicit persistence = each add/delete IS a discrete event the agent must witness.',
    },
  },
  {
    id: 'list-message-thread',
    intent: 'a message thread showing a list of messages',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
      tolerateEitherShape: true,
      notes:
        'static thread — props with messages array. Live thread would be broadcast/converse.',
    },
  },
  {
    id: 'list-file-browser',
    intent: 'a file browser showing the contents of a directory',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
      tolerateEitherShape: true,
      notes: 'agent passes file list as props; user reads.',
    },
  },
  {
    id: 'list-checklist-local',
    intent: 'a checklist where I tick off items',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['items', 'checked', 'completed'],
      tolerateEitherShape: true,
    },
  },

  // ─── display: static props-only ───────────────────────────────────
  {
    id: 'display-weather-1',
    intent: 'a weather card for Tokyo with temperature and an icon',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
    },
  },
  {
    id: 'display-weather-2',
    intent: 'a weather widget showing today and tomorrow',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
    },
  },
  {
    id: 'display-profile-1',
    intent: 'a profile card with name, avatar, and bio',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
    },
  },
  {
    id: 'display-stat-1',
    intent: 'a single big number stat for revenue this month',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
    },
  },
  {
    id: 'display-status-1',
    intent: 'a deployment status panel showing service name and current state',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
    },
  },
  {
    id: 'display-quote-1',
    intent: 'a quote card with the quote text and the author',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
    },
  },
  {
    id: 'display-recipe-1',
    intent: 'a recipe card with title, ingredients, and steps',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
    },
  },
  {
    id: 'display-event-1',
    intent: 'an event ticket card with date, location, and seat',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
    },
  },

  // ─── broadcast: agent → UI live ───────────────────────────────────
  {
    id: 'bcast-clock-1',
    intent: 'a live clock that updates every second',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
    },
  },
  {
    id: 'bcast-ticker-1',
    intent: 'a stock ticker showing live price updates',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
    },
  },
  {
    id: 'bcast-dashboard-1',
    intent: 'a live system dashboard with CPU, memory, and request-rate metrics streaming in',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
    },
  },
  {
    id: 'bcast-feed-1',
    intent: 'a live notifications feed showing alerts as they arrive',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
    },
  },
  {
    id: 'bcast-progress-1',
    intent: 'a progress bar showing live build progress from the agent',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
    },
  },

  // ─── converse: bidirectional ──────────────────────────────────────
  {
    id: 'conv-chat-1',
    intent: 'a chat with the agent showing live messages',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
      actionNames: ['sendMessage', 'send', 'submit'],
      tolerateEitherShape: true,
      notes: 'contextSpec for draftText is optional but valid.',
    },
  },
  {
    id: 'conv-copilot-1',
    intent: 'a coding copilot session where I send prompts and see streamed responses',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
      actionNames: ['sendMessage', 'sendPrompt', 'submit', 'send'],
      tolerateEitherShape: true,
    },
  },
  {
    id: 'conv-support-1',
    intent: 'a customer support chat with an AI agent',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
      actionNames: ['sendMessage', 'send', 'submit'],
      tolerateEitherShape: true,
    },
  },

  // ─── flow: multi-step wizards ─────────────────────────────────────
  {
    id: 'flow-onboarding-1',
    intent: 'a 3-step onboarding wizard for setting up a profile',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['next', 'back', 'finish', 'submit', 'previous'],
      contextSlots: ['step', 'currentStep', 'draft', 'profile'],
    },
  },
  {
    id: 'flow-checkout-1',
    intent: 'a checkout flow with shipping, payment, and review steps',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['step', 'currentStep', 'draft', 'order'],
      notes:
        'no actionNames assertion — a checkout-completion action has an unbounded valid vocabulary (finish / complete / completePurchase / placeOrder / …). Spec-presence + placement verify the shape; an exact-name allow-list only generates false negatives.',
    },
  },
  {
    id: 'flow-survey-multistep',
    intent: 'a multi-step survey where each section is its own page',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['next', 'back', 'finish', 'submit', 'previous'],
      contextSlots: ['step', 'currentStep', 'answers', 'draft', 'responses'],
    },
  },
  {
    id: 'flow-tutorial-1',
    intent: 'a tutorial wizard that walks through the app features',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['next', 'back', 'finish', 'skip', 'previous'],
      contextSlots: ['step', 'currentStep'],
    },
  },

  // ─── modal / settings / navigation (collect with discrete events) ─
  {
    id: 'misc-settings-1',
    intent: 'a settings panel with several toggles and a save button',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['save', 'submit', 'apply'],
      notes:
        'no contextSlots assertion — one context slot per toggle is the idiomatic shape, and the exact per-toggle names are intent-specific (notificationsEnabled, darkMode, …) so cannot be enumerated.',
    },
  },
  {
    id: 'misc-modal-confirm',
    intent: 'a delete-confirmation modal with confirm and cancel actions',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['confirm', 'cancel', 'delete'],
    },
  },
  {
    id: 'misc-nav-1',
    intent: 'a navigation drawer with home, search, and inbox links',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: [
        'route',
        'currentRoute',
        'page',
        'selectedRoute',
        'activeLink',
        'active',
        'link',
      ],
      tolerateEitherShape: true,
      notes:
        'navigation is route mutation; the slot mirror IS the wire. Tolerated either way because some intents read "navigate" as a discrete event. The active-nav slot has many reasonable names (route / activeLink / …).',
    },
  },
  {
    id: 'misc-share-button',
    intent: 'an article view with a share button',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
      actionNames: ['share'],
      notes: 'share IS a discrete event the agent must witness.',
    },
  },
  {
    id: 'misc-publish-button',
    intent: 'a draft post editor with a publish button',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['publish', 'submit', 'send'],
      notes:
        'no contextSlots assertion — a draft-text slot has an unbounded valid vocabulary (draft / body / content / postText / …). hasContextSpec verifies the slot exists; an exact-name allow-list only generates false negatives.',
    },
  },

  // ─── hard cases: tolerate either author or refuse ────────────────
  {
    id: 'hard-color-stream',
    intent:
      'a color picker that streams the chosen color back to the agent in real time',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      contextSlots: ['color', 'selectedColor'],
      tolerateEitherShape: true,
      notes:
        'streaming back to the agent IS the contextSpec mirror. Synth often misreads "streams" as needing streamSpec — bench tolerates both.',
    },
  },
  {
    id: 'hard-multi-user-chat',
    intent: 'a multi-user chat room with three participants',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
      tolerateEitherShape: true,
      notes:
        'multi-user is outside the agent-as-counterparty model. Synth may shape it as converse with sendMessage; that is acceptable.',
    },
  },
  {
    id: 'hard-collaborative-doc',
    intent: 'a collaborative document where multiple users edit at once',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      tolerateEitherShape: true,
      notes:
        'CRDT semantics are out of scope. Single-user shape (contextSpec.docText) is acceptable.',
    },
  },
  {
    id: 'hard-game-controller',
    intent: 'a game controller with directional pad and action buttons',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      tolerateEitherShape: true,
      notes:
        'each button press IS a discrete event (jump, fire) — actionSpec valid. Direction may be slot OR per-press action.',
    },
  },
  {
    id: 'hard-file-upload',
    intent: 'a file uploader with drag-and-drop',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      actionNames: ['upload', 'submit', 'addFile', 'send', 'filesSelected', 'select'],
      contextSlots: ['files', 'queue', 'draft'],
      tolerateEitherShape: true,
    },
  },
  {
    id: 'hard-realtime-quiz',
    intent: 'a real-time multiplayer quiz with a leaderboard that updates live',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
      tolerateEitherShape: true,
      notes:
        'leaderboard is broadcast; answer submission is action. Synth may shape as converse or broadcast — both acceptable.',
    },
  },

  // ─── capability: browser-capability hook declarations (EE-runtime) ───
  // The capability output is a UI-side side effect that surfaces to the
  // agent ONLY when threaded into a contextSpec slot or actionSpec
  // payload. The synth output is expected to declare
  // `clientCapabilities.gadgets[X].hook` for the named hook from
  // `@ggui-ai/gadgets`. `tolerateEitherShape` is set on every
  // entry — synth prompts haven't been retrained on these yet (Slice
  // EE-runtime triad subtask 5f), so the corpus records the EXPECTED
  // shape without failing legacy synth runs.

  {
    id: 'cap-location-1',
    intent: 'show my current location on a map',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      hasClientCapabilities: true,
      capabilityHooks: ['useGeolocation'],
      contextSlots: ['location', 'coords', 'position'],
      tolerateEitherShape: true,
      notes:
        'geolocation read is a one-shot capability; the resolved coords land on a contextSpec slot the map renders from.',
    },
  },
  {
    id: 'cap-voice-1',
    intent: 'let me record a voice memo and send it',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      hasClientCapabilities: true,
      capabilityHooks: ['useMicrophone'],
      actionNames: ['send', 'submit', 'record'],
      tolerateEitherShape: true,
      notes:
        'mic capture is a UI-owned lifecycle; the resulting Blob URL surfaces via contextSpec, sending is a discrete action.',
    },
  },
  {
    id: 'cap-photo-1',
    intent: 'take a selfie and let me caption it before posting',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      hasClientCapabilities: true,
      capabilityHooks: ['useCamera'],
      actionNames: ['post', 'submit'],
      contextSlots: ['photo', 'caption', 'image', 'draft'],
      tolerateEitherShape: true,
    },
  },
  {
    id: 'cap-clipboard-write-1',
    intent: 'a copy-to-clipboard button for a generated code snippet',
    expected: {
      hasActionSpec: true,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
      hasClientCapabilities: true,
      capabilityHooks: ['useClipboardWrite'],
      actionNames: ['copy', 'copied'],
      tolerateEitherShape: true,
      notes:
        'clipboard write is component-only mechanic; the agent observes only that the user pressed "copy" (actionSpec.copy).',
    },
  },
  {
    id: 'cap-clipboard-paste-1',
    intent: 'paste my saved password into the login form',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      hasClientCapabilities: true,
      capabilityHooks: ['useClipboardPaste'],
      contextSlots: ['password', 'pastedText', 'value'],
      tolerateEitherShape: true,
    },
  },
  {
    id: 'cap-file-1',
    intent: 'upload a PDF for me to review',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      hasClientCapabilities: true,
      capabilityHooks: ['useFilePicker'],
      actionNames: ['upload', 'submit'],
      contextSlots: ['file', 'files', 'attachment'],
      tolerateEitherShape: true,
    },
  },
  {
    id: 'cap-notifications-1',
    intent:
      'send me a system notification when my long-running task finishes',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      hasClientCapabilities: true,
      capabilityHooks: ['useNotifications'],
      notes:
        'no contextSlots assertion — the slot tracking the watched task (taskStatus, …) is intent-specific; capabilityHooks pins the real check (the useNotifications gadget).',
      tolerateEitherShape: true,
    },
  },

  // ─── source-fed-stream: agentCapabilities-driven live channels (EE-runtime) ─
  // The synth should declare `streamSpec[X].source = {tool, args?}` and
  // a matching `agentCapabilities.tools[<source.tool>]` catalog entry. The
  // runtime decides transport (WebSocket subscribe vs polling); the
  // contract doesn't care. Tolerated until the prompt revision (subtask
  // 5e) lands.

  {
    id: 'src-stream-ticker-1',
    intent: 'a live-refreshing AAPL stock ticker',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
      hasAgentTools: true,
      agentToolNames: ['fetch_quote', 'get_quote', 'list_quotes', 'quote'],
      tolerateEitherShape: true,
      notes:
        'ticker streams price updates; the agent-side tool feeds the channel. No actionSpec because nothing the user does drives a turn.',
    },
  },
  {
    id: 'src-stream-dashboard-1',
    intent: 'a real-time dashboard of incoming chat messages',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
      hasAgentTools: true,
      agentToolNames: ['list_messages', 'fetch_messages', 'messages'],
      tolerateEitherShape: true,
    },
  },
  {
    id: 'src-stream-polling-table-1',
    intent:
      "a polling table of pending jobs that refreshes every few seconds",
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: true,
      hasProps: false,
      hasAgentTools: true,
      agentToolNames: ['list_jobs', 'fetch_jobs', 'jobs'],
      tolerateEitherShape: true,
      notes:
        'polling table needs a source-fed stream; agent-tool name varies by intent vocabulary.',
    },
  },

  // ─── capability-plugin: operator-registered 3rd-party wrappers ──────────────
  // STDLIB capability cases above test the 7 first-party hooks the
  // synth's static system prompt always knows about. These cases test
  // the per-app `appGadgets` channel — does the synth READ the
  // "AVAILABLE GADGETS" prompt block emitted by
  // `composeAvailableGadgetsSection` when an operator has registered
  // a wrapper at `App.gadgets`? Three shapes:
  //
  //   - **positive**: intent matches the registered wrapper → expect
  //     `clientCapabilities.gadgets[*].hook` to reference it.
  //   - **negative**: intent doesn't justify a map at all → expect NO
  //     `clientCapabilities.gadgets` (registry shouldn't trigger
  //     attaching a wrapper that doesn't fit).
  //   - **distractor**: intent could go either way → forbid the
  //     wrapper unless its semantics are an exact match. Catches the
  //     "LLM attaches everything in the catalog regardless" failure.
  //
  // `tolerateEitherShape: true` on all entries — the synth's catalog-
  // reading behavior is relatively new, so these cases would fail
  // strictly until it is fully tuned. The bench captures the baseline
  // + regression signal without breaking CI.

  {
    id: 'capplug-leaflet-positive-1',
    intent:
      'show my running route from this morning on an interactive map with the start and end pinned',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
      hasClientCapabilities: true,
      capabilityHooks: ['LeafletMap'],
      tolerateEitherShape: true,
      notes:
        'positive: registered Leaflet wrapper should be referenced when the intent names an interactive map render.',
    },
    appGadgets: [LEAFLET_DESCRIPTOR],
  },
  {
    id: 'capplug-leaflet-positive-2',
    intent:
      'plot the delivery destinations for the day with a marker per stop on a map',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
      hasClientCapabilities: true,
      capabilityHooks: ['LeafletMap'],
      tolerateEitherShape: true,
    },
    appGadgets: [LEAFLET_DESCRIPTOR],
  },
  {
    id: 'capplug-leaflet-negative-1',
    intent:
      'let me edit my profile name, email, and avatar in a simple form',
    expected: {
      hasActionSpec: true,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      hasClientCapabilities: false,
      forbiddenCapabilityHooks: ['LeafletMap'],
      tolerateEitherShape: true,
      notes:
        'negative: form-editing intent has no map surface; LLM must NOT attach the registered wrapper just because it appears in the catalog.',
    },
    appGadgets: [LEAFLET_DESCRIPTOR],
  },
  {
    id: 'capplug-leaflet-distractor-1',
    intent:
      'show me the GPS coordinates of my current position as a labelled lat/lng pair',
    expected: {
      hasActionSpec: false,
      hasContextSpec: true,
      hasStreamSpec: false,
      hasProps: false,
      hasClientCapabilities: true,
      capabilityHooks: ['useGeolocation'],
      forbiddenCapabilityHooks: ['LeafletMap'],
      contextSlots: ['coords', 'position', 'location', 'latitude', 'longitude'],
      tolerateEitherShape: true,
      notes:
        'distractor: GPS-coords intent needs `useGeolocation` (STDLIB) but does NOT need the registered Leaflet wrapper — render is text, not map.',
    },
    appGadgets: [LEAFLET_DESCRIPTOR],
  },
  {
    id: 'capplug-chart-hook-positive-1',
    intent:
      'a bar chart of quarterly revenue whose bar colors follow the current app theme',
    expected: {
      hasActionSpec: false,
      hasContextSpec: false,
      hasStreamSpec: false,
      hasProps: true,
      hasClientCapabilities: true,
      // Registered third-party HOOK export — the dual of the Leaflet
      // component cases. The `Chart` component may also be declared;
      // this case pins that the registered HOOK is reached for.
      capabilityHooks: ['useChartTheme'],
      tolerateEitherShape: true,
      notes:
        'positive: registered third-party HOOK gadget. A theme-aware chart intent should pull the `useChartTheme` hook export from the registered chart package — the component-only Leaflet cases never exercise a registered hook.',
    },
    appGadgets: [CHART_DESCRIPTOR],
  },
];
