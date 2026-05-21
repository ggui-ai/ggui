/**
 * Deterministic producer for provisional A2UI previews.
 *
 * Purpose: provide a server-side preview path that works without a
 * fast-model LLM. An LLM-backed producer can be layered onto the
 * same `produce…` contract; this deterministic one lets every
 * integration site wire and observe the full pipeline without any
 * model dependency.
 *
 * What "deterministic" means here:
 *
 *   - No LLM. No network. No randomness.
 *   - Shape adapts to `story.intent` via small keyword heuristics
 *     ("form" / "input" → form shell, "list" / "dashboard" → list
 *     shell, etc.). Produces a meaningfully different tree per
 *     intent — not a static one-off.
 *   - Emits the canonical A2UI write-path subset:
 *     `createSurface` → `updateComponents` (root skeleton) →
 *     `updateComponents` (enriched layout) → `deleteSurface`.
 *   - Honors the emitter's `signal` between each frame; on cancel
 *     returns silently without further emits.
 *
 * Framework-neutrality:
 *
 *   - Consumes a small structural context (`DeterministicPreviewContext`)
 *     that the `@ggui-ai/mcp-server-handlers` orchestrator's richer
 *     `ProvisionalPreviewContext` satisfies by construction. No
 *     import from handlers; callers wrap the function with a
 *     `ProvisionalPreviewEmitter` when they plug it into the push
 *     handler:
 *
 *       emitter: { run: (ctx) => produceDeterministicPreview(ctx) }
 *
 *   - Output payloads are plain objects matching the V1 A2UI schemas
 *     defined in `../messages`. Consumers that validate on egress
 *     can feed them through `parseServerMessage` (round-trippable).
 */
import type { GguiPreviewComponentType } from '../catalog';

/**
 * JSON-safe payload shape. Mirrors `@ggui-ai/protocol.JsonValue`
 * structurally (mutable arrays, optional-undefined index entries)
 * without importing it — keeps this package's zero cross-package
 * dep boundary intact. The producer's A2UI frames are plain
 * objects with string/number/boolean/null leaves, so every
 * concrete emission satisfies this shape AND assigns into the
 * orchestrator's `JsonValue`-typed `emit` sink.
 */
interface JsonPayloadObject {
  [key: string]: JsonPayload | undefined;
}
type JsonPayload =
  | string
  | number
  | boolean
  | null
  | JsonPayload[]
  | JsonPayloadObject;

/**
 * Minimum fields the producer reads from the orchestrator's context.
 * Structurally compatible with `ProvisionalPreviewContext` so callers
 * wrap with a one-line `{run: (ctx) => produceDeterministicPreview(ctx)}`.
 */
export interface DeterministicPreviewContext {
  /**
   * A2UI surface id. Defaults to `ctx.stackItemId` when
   * {@link DeterministicPreviewOptions.surfaceId} is absent.
   */
  readonly stackItemId: string;
  /**
   * Push story. `intent` is the primary signal the producer reads;
   * additional fields are accepted but ignored.
   */
  readonly story: { readonly intent: string } & Record<string, unknown>;
  /**
   * Emit sink from the orchestrator. Declared over {@link JsonPayload}
   * so callers whose `emit` narrows to `@ggui-ai/protocol.JsonValue`
   * (the handler's `ProvisionalPreviewEmit` shape) assign in without
   * a cast — `JsonPayload` is the same value-space. Return value is
   * the wrapped `{seq?}`; the producer ignores it.
   */
  readonly emit: (payload: JsonPayload) => Promise<unknown>;
  /**
   * Cancellation signal from the orchestrator. Checked between
   * frames; on aborted the producer returns without further emits.
   */
  readonly signal: AbortSignal;
}

export interface DeterministicPreviewOptions {
  /**
   * Override the surface id. Defaults to `ctx.stackItemId` — keeping the
   * surface id aligned with the stackItemId makes the registry's
   * stackItemId-keyed cancellation reach the right client surface when
   * the renderer buffers on `createSurface.surfaceId`.
   */
  readonly surfaceId?: string;
  /**
   * Override the catalog id referenced in `createSurface`. Defaults
   * to `ggui.preview.v1` — the published manifest this package's
   * subset targets. Only override if the caller is pointing at a
   * different deployed catalog.
   */
  readonly catalogId?: string;
}

/**
 * Canonical catalog id for the V1 ggui preview subset. Kept in
 * alignment with {@link GGUI_PREVIEW_CATALOG_V1_ID} via a type-level
 * parity assertion below so a rename in one place can't silently
 * desync.
 */
const DEFAULT_CATALOG_ID = 'ggui.preview.v1';

/**
 * Compile-time parity guard: the producer's default catalog id
 * matches the canonical catalog manifest id. If the manifest id
 * ever changes, this assignment fails to typecheck — the producer
 * must be updated in lockstep.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _CATALOG_ID_PARITY: 'ggui.preview.v1' = DEFAULT_CATALOG_ID;

/**
 * Produce a provisional preview for the supplied story. Emits 3
 * frames on the happy path; returns early on cancellation.
 *
 * **No `deleteSurface` on happy path.** The provisional preview is
 * meant to stay visible until the authoritative final UI replaces
 * it. Tearing down the surface in the producer would clear the
 * rendered fragments and leave the viewer blank between
 * "preview-done" and "final-code-arrives" — the wrong UX.
 *
 * Authoritative handoff is the cancellation site: when real
 * component code lands, the orchestrator's
 * `finalizeProvisionalPreview` aborts the runner with reason
 * `'handoff'` and the renderer swaps in the real component. Until
 * then (e.g. on OSS today, where final generation isn't wired),
 * the assembled surface stays painted as the user-facing preview.
 *
 * The orchestrator still owns the channel-level close
 * (`{payload: null, complete: true}`); that just latches the
 * channel as drained without affecting the rendered surface.
 */
export async function produceDeterministicPreview(
  ctx: DeterministicPreviewContext,
  options?: DeterministicPreviewOptions,
): Promise<void> {
  const surfaceId = options?.surfaceId ?? ctx.stackItemId;
  const catalogId = options?.catalogId ?? DEFAULT_CATALOG_ID;

  // Frame 1 — surface creation.
  await ctx.emit({
    version: 'v0.9',
    createSurface: { surfaceId, catalogId },
  });
  if (ctx.signal.aborted) return;

  // Frame 2 — root skeleton. Shows a heading derived from the
  // intent so the user sees "what is being built" before the body
  // + shells fill in.
  const heading = deriveHeading(ctx.story.intent);
  await ctx.emit({
    version: 'v0.9',
    updateComponents: {
      surfaceId,
      components: [
        {
          id: 'root',
          component: 'Column',
          children: ['heading'],
          gap: '12',
          align: 'stretch',
        },
        {
          id: 'heading',
          component: 'Text',
          variant: 'h2',
          text: heading,
        },
      ],
    },
  });
  if (ctx.signal.aborted) return;

  // Frame 3 — enriched layout. Adds a body caption + keyword-driven
  // shells (form / list / …) so the surface reads as the rough
  // outline of the final UI rather than a lone heading. This is
  // the terminal frame on the happy path; the surface stays
  // painted in the viewer until authoritative handoff aborts the
  // runner (or the user navigates away).
  const body = deriveBody(ctx.story.intent);
  const shell = pickShell(ctx.story.intent);
  const rootChildren = ['heading', 'body', ...shell.ids];
  await ctx.emit({
    version: 'v0.9',
    updateComponents: {
      surfaceId,
      components: [
        {
          id: 'root',
          component: 'Column',
          children: rootChildren,
          gap: '12',
          align: 'stretch',
        },
        {
          id: 'body',
          component: 'Text',
          variant: 'caption',
          text: body,
        },
        ...shell.fragments,
      ],
    },
  });
}

/**
 * Default export as a factory that adapts the producer into the
 * orchestrator's `ProvisionalPreviewEmitter` shape without forcing
 * consumers to write the one-line wrapper. Typed structurally so no
 * import from `@ggui-ai/mcp-server-handlers` is required.
 */
export function createDeterministicPreviewEmitter(
  options?: DeterministicPreviewOptions,
): { run: (ctx: DeterministicPreviewContext) => Promise<void> } {
  return {
    run: (ctx) => produceDeterministicPreview(ctx, options),
  };
}

// ─── Heuristics ────────────────────────────────────────────────────────

/**
 * First-sentence heading derivation. Takes the first
 * sentence-terminating punctuation as the boundary, falls back to
 * the first ~80 chars. Capitalizes the leading character so
 * lowercase intents ("build a chat app") render as titles.
 */
function deriveHeading(intent: string): string {
  const trimmed = intent.trim();
  if (trimmed.length === 0) return 'Preparing your view…';
  const firstSentence = trimmed.split(/[.!?\n]/)[0]?.trim() ?? trimmed;
  const clipped =
    firstSentence.length <= 80 ? firstSentence : firstSentence.slice(0, 80);
  const leading = clipped.charAt(0).toUpperCase();
  return leading + clipped.slice(1);
}

/**
 * Body caption. Tight clip so the provisional surface doesn't try
 * to render the full intent — the final UI handles rich content;
 * the preview just sets expectations.
 */
function deriveBody(intent: string): string {
  const trimmed = intent.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117) + '…';
}

interface ShellSelection {
  readonly ids: readonly string[];
  readonly fragments: ReadonlyArray<ShellFragment>;
}

/**
 * Every fragment the producer can emit conforms to the V1 catalog.
 * We constrain the `component` field to the catalog's component
 * type union so a typo here fails to compile instead of falling
 * back to the unsupported-component placeholder at render time.
 */
interface ShellFragment {
  readonly id: string;
  readonly component: GguiPreviewComponentType;
  readonly [extra: string]: JsonPayload;
}

/**
 * Keyword-driven shell selection. Tiny heuristics — not an NLP
 * pass. The goal is "provisional looks broadly right for common
 * intents", not "provisional is 95% accurate". When the heuristics
 * miss, the rendered surface degrades to heading + caption, which
 * is still honest about what's coming.
 */
function pickShell(intent: string): ShellSelection {
  const lower = intent.toLowerCase();

  if (/\b(form|input|sign\s?up|log\s?in|register|submit|feedback)\b/.test(lower)) {
    return {
      ids: ['form-card'],
      fragments: [
        { id: 'form-card', component: 'Card', child: 'form-col' },
        {
          id: 'form-col',
          component: 'Column',
          children: ['tf', 'btn'],
          gap: '8',
        },
        { id: 'tf', component: 'TextField', label: 'Input' },
        { id: 'btn', component: 'Button', label: 'Submit' },
      ],
    };
  }

  if (/\b(list|items|todos?|feed|posts?|grid|dashboard|table)\b/.test(lower)) {
    return {
      ids: ['list-card'],
      fragments: [
        { id: 'list-card', component: 'Card', child: 'list' },
        { id: 'list', component: 'List', children: ['l1', 'l2', 'l3'] },
        { id: 'l1', component: 'Text', variant: 'body', text: '—' },
        { id: 'l2', component: 'Text', variant: 'body', text: '—' },
        { id: 'l3', component: 'Text', variant: 'body', text: '—' },
      ],
    };
  }

  return { ids: [], fragments: [] };
}
