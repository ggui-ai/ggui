/**
 * Provisional (A2UI preview) renderer for the iframe runtime.
 *
 * Port of `@ggui-ai/react::components/ProvisionalRenderer.tsx` with
 * the React-hook consumer stripped. The A2UI reduce + adjacency-list
 * render is preserved verbatim; the inputs + mount lifecycle differ:
 *
 *   - Host-SDK version reads via `useChannelStream(PREVIEW_CHANNEL)`
 *     (a React hook subscribed to a live-channel bridge event).
 *   - Iframe-renderer version is driven by an explicit
 *     `pushEnvelope(env)` entry point invoked by `subscribe.ts` on
 *     every validated inbound `data` envelope whose channel is
 *     `_ggui:preview`. The caller (runtime.ts) forwards envelopes
 *     after the reserved-channel A2UI validator has accepted them.
 *
 * Visual language: `PreviewSurface` / `PreviewFragmentEnter` /
 * `StreamingText` from `@ggui-ai/design/preview`; primitive mapping
 * from `@ggui-ai/design/primitives`. Matches the host-SDK output
 * 1:1 — operator-visible preview DOM is identical on both paths.
 *
 * Lifecycle:
 *
 *   - `mountProvisional(container)` → `{pushEnvelope, suspend,
 *     resume, unmount}` handle. The container renders the default
 *     loading fallback until A2UI's `root` fragment arrives; then
 *     the adjacency tree paints.
 *   - `suspend()` hides the surface (used when the authoritative
 *     render takes over — the render dispatcher in Commit 4
 *     toggles this on ReactComponentRenderer mount).
 *   - `resume()` re-shows. Envelopes keep accumulating in state
 *     while suspended, matching host-SDK behavior.
 */
import React, { createElement, Fragment, useEffect, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StreamEnvelope } from '@ggui-ai/protocol';

/**
 * Spec-canonical A2UI preview channel name (from
 * `@ggui-ai/protocol::PREVIEW_CHANNEL`). Inlined here so this
 * module's runtime imports stay off the protocol root barrel —
 * importing the constant from `@ggui-ai/protocol` pulls in
 * `openrouter-models` + the entire zod validation graph via the
 * root re-export chain, adding ~250 KB gz to the renderer bundle.
 * The value is a stable string literal (`isKnownReservedChannel`
 * and the spec both reference `_ggui:preview` directly); re-declaring
 * it here is shape-preserving and covered by the structural-lock
 * test in the source module.
 */
const PREVIEW_CHANNEL = '_ggui:preview';
import {
  parseServerMessage,
  type Component as A2uiComponent,
  type ServerMessage as A2uiServerMessage,
} from '@ggui-ai/preview-a2ui';
import {
  Button,
  Card,
  Checkbox,
  Divider,
  Heading,
  Icon,
  Image,
  Input,
  Row,
  Select,
  Spinner,
  Stack,
  Text,
} from '@ggui-ai/design/primitives';
import {
  PreviewFragmentEnter,
  PreviewSurface,
  StreamingText,
} from '@ggui-ai/design/preview';

const A2UI_ROOT_ID = 'root';

// =============================================================================
// Reducer — ports ProvisionalRenderer's reduce/reduceAll verbatim.
// =============================================================================

interface ProvisionalState {
  readonly surfaceId: string | null;
  readonly fragments: ReadonlyMap<string, A2uiComponent>;
}

const EMPTY_STATE: ProvisionalState = {
  surfaceId: null,
  fragments: new Map(),
};

function reduce(state: ProvisionalState, msg: A2uiServerMessage): ProvisionalState {
  if ('createSurface' in msg) {
    return {
      surfaceId: msg.createSurface.surfaceId,
      fragments: new Map(),
    };
  }
  if ('updateComponents' in msg) {
    if (state.surfaceId !== msg.updateComponents.surfaceId) return state;
    const next = new Map(state.fragments);
    for (const component of msg.updateComponents.components) {
      next.set(component.id, component);
    }
    return { ...state, fragments: next };
  }
  if ('deleteSurface' in msg) {
    if (state.surfaceId !== msg.deleteSurface.surfaceId) return state;
    return EMPTY_STATE;
  }
  return state;
}

function reduceAll(envelopes: readonly StreamEnvelope[]): ProvisionalState {
  let state: ProvisionalState = EMPTY_STATE;
  for (const envelope of envelopes) {
    const parsed = parseServerMessage(envelope.payload);
    if (!parsed.ok) continue;
    state = reduce(state, parsed.value);
  }
  return state;
}

// =============================================================================
// A2UI component → primitives renderer — ports renderComponent verbatim.
// =============================================================================

function UnresolvedPlaceholder(): ReactNode {
  return createElement('div', {
    style: {
      minHeight: 24,
      minWidth: 32,
      borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
      backgroundColor: 'var(--ggui-color-outlineVariant, rgba(148, 163, 184, 0.18))',
    },
    'aria-hidden': 'true',
  });
}

function UnsupportedComponentShell({ name }: { name: string }): ReactNode {
  return createElement(
    Card,
    { padding: 12, shadow: 'none', border: true },
    createElement(Text, { variant: 'caption' }, `[${name}]`),
  );
}

// Stable noop so React doesn't warn about switching onChange identity.
function noopOnChange(): void {
  // intentionally empty — provisional controls are non-interactive
}

function renderComponent(
  component: A2uiComponent,
  all: ReadonlyMap<string, A2uiComponent>,
): ReactNode {
  const resolveChildren = (
    childIds: readonly string[] | undefined,
  ): ReactNode[] => {
    if (!childIds) return [];
    return childIds.map((id) => {
      const child = all.get(id);
      if (!child) return createElement(UnresolvedPlaceholder, { key: id });
      return renderComponent(child, all);
    });
  };

  const { id } = component;
  const wrap = (children: ReactNode): ReactNode =>
    createElement(PreviewFragmentEnter, { key: id, children });

  switch (component.component) {
    case 'Row':
      return wrap(
        createElement(
          Row,
          {
            gap: component.gap,
            align: component.align ?? 'stretch',
            justify: component.justify ?? 'start',
          },
          ...resolveChildren(component.children),
        ),
      );
    case 'Column':
      return wrap(
        createElement(
          Stack,
          {
            direction: 'vertical',
            gap: component.gap,
            align: component.align ?? 'stretch',
            justify: component.justify ?? 'start',
          },
          ...resolveChildren(component.children),
        ),
      );
    case 'List':
      return wrap(
        createElement(
          Stack,
          { direction: 'vertical', gap: 8 },
          ...resolveChildren(component.children),
        ),
      );
    case 'Card': {
      const child = component.child ? all.get(component.child) : undefined;
      const cardContent =
        component.child && !child
          ? createElement(UnresolvedPlaceholder)
          : child
          ? renderComponent(child, all)
          : null;
      return wrap(
        createElement(Card, { padding: 16, shadow: 'sm' }, cardContent),
      );
    }
    case 'Divider':
      return wrap(
        createElement(Divider, { orientation: component.orientation ?? 'horizontal' }),
      );
    case 'Text': {
      const variant = component.variant ?? 'body';
      const headingMatch = /^h([1-6])$/.exec(variant);
      if (headingMatch) {
        const level = Number(headingMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6;
        return wrap(
          createElement(
            Heading,
            { level },
            createElement(StreamingText, null, component.text),
          ),
        );
      }
      const textVariant =
        variant === 'label' || variant === 'caption' ? variant : 'body';
      return wrap(
        createElement(
          Text,
          { variant: textVariant },
          createElement(StreamingText, null, component.text),
        ),
      );
    }
    case 'Image':
      return wrap(createElement(Image, { src: component.src, alt: component.alt ?? '' }));
    case 'Icon':
      return wrap(createElement(Icon, { name: component.name }));
    case 'Button':
      return wrap(createElement(Button, { disabled: true }, component.label));
    case 'TextField':
      return wrap(
        createElement(Input, {
          disabled: true,
          label: component.label,
          placeholder: component.placeholder,
          value: component.value ?? '',
          onChange: noopOnChange,
        }),
      );
    case 'CheckBox':
      return wrap(
        createElement(Checkbox, {
          disabled: true,
          label: component.label ?? '',
          checked: component.checked ?? false,
          onChange: noopOnChange,
        }),
      );
    case 'ChoicePicker': {
      const options = component.options ?? [];
      return wrap(
        createElement(Select, {
          disabled: true,
          label: component.label,
          value: component.value ?? '',
          options,
          onChange: noopOnChange,
        }),
      );
    }
    default: {
      const unknown = component as { component: string };
      return wrap(createElement(UnsupportedComponentShell, { name: unknown.component }));
    }
  }
}

// =============================================================================
// Mount API
// =============================================================================

export interface ProvisionalMount {
  /**
   * Feed a stream envelope. Ignores non-PREVIEW_CHANNEL envelopes
   * silently so callers can forward their full inbound stream
   * without filtering first. Caller MUST run reserved-channel
   * validation before pushing — the provisional renderer treats the
   * payload as trusted.
   */
  pushEnvelope(envelope: StreamEnvelope): void;
  /** Hide the surface (authoritative render takes over). */
  suspend(): void;
  /** Re-show the surface. */
  resume(): void;
  /** Tear down the React root + release retained state. */
  unmount(): void;
}

interface ProvisionalRootProps {
  readonly envelopes: readonly StreamEnvelope[];
  readonly suspended: boolean;
  readonly fallback?: ReactNode;
}

/**
 * Inner React component — drives the adjacency-list render against
 * the accumulated envelope list. Re-render on suspend/resume or on
 * new envelope is governed by the component's own useState setter in
 * `ProvisionalController`.
 */
function ProvisionalRoot({ envelopes, suspended, fallback }: ProvisionalRootProps): ReactNode {
  const state = reduceAll(envelopes);
  if (suspended) return null;
  const root = state.fragments.get(A2UI_ROOT_ID);
  if (!root) {
    return createElement(
      Fragment,
      null,
      fallback ?? createElement(DefaultFallback),
    );
  }
  return createElement(PreviewSurface, null, renderComponent(root, state.fragments));
}

function DefaultFallback(): ReactNode {
  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 80,
      },
    },
    createElement(Spinner),
  );
}

/**
 * Controller component — bridges imperative `pushEnvelope` / `suspend`
 * / `resume` calls with React state. Accepts a `controlRef` that it
 * populates during mount so the mount handle can drive updates.
 */
interface ControllerRef {
  pushEnvelope: (envelope: StreamEnvelope) => void;
  suspend: () => void;
  resume: () => void;
}

interface ProvisionalControllerProps {
  readonly controlRef: { current: ControllerRef | null };
  /**
   * Callback the controller fires inside its `useEffect` once
   * `controlRef.current` is populated. Lets the imperative
   * {@link mountProvisional} handle drain any envelopes that arrived
   * BEFORE React's first effect ran — without it, a one-shot
   * `queueMicrotask(drainPending)` races React's mount and silently
   * abandons the queue when the microtask wins. The race is real:
   * the iframe-runtime forwards reserved-channel replay frames to
   * `pushEnvelope` synchronously from the WS message handler, before
   * React's commit phase fires for the freshly-rendered controller.
   */
  readonly onAttach?: () => void;
  readonly fallback?: ReactNode;
}

function ProvisionalController({
  controlRef,
  onAttach,
  fallback,
}: ProvisionalControllerProps): ReactNode {
  const [envelopes, setEnvelopes] = useState<readonly StreamEnvelope[]>([]);
  const [suspended, setSuspended] = useState<boolean>(false);

  useEffect(() => {
    controlRef.current = {
      pushEnvelope: (env) => {
        if (env.channel !== PREVIEW_CHANNEL) return;
        setEnvelopes((prev) => [...prev, env]);
      },
      suspend: () => setSuspended(true),
      resume: () => setSuspended(false),
    };
    onAttach?.();
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, onAttach]);

  return createElement(ProvisionalRoot, {
    envelopes,
    suspended,
    ...(fallback !== undefined ? { fallback } : {}),
  });
}

/**
 * Mount the provisional surface into `container`. Returns a handle
 * callers use to push envelopes + suspend/resume + unmount.
 *
 * Synchronous-ish — the React root renders on next microtask, so
 * the `controlRef` is populated by the time the caller's next
 * microtask runs. Tests use `await Promise.resolve()` to sync.
 */
export function mountProvisional(
  container: HTMLElement,
  opts: { fallback?: ReactNode } = {},
): ProvisionalMount {
  container.replaceChildren();
  const root: Root = createRoot(container);
  const controlRef: { current: ControllerRef | null } = { current: null };

  // Buffer envelopes that arrive before React's first effect runs.
  // Once `controlRef.current` exists we drain the buffer in order;
  // same for suspend/resume calls. Matches ProvisionalRenderer's
  // pre-mount semantics (envelopes are reduced in arrival order
  // regardless of mount timing).
  //
  // Drain trigger: React fires `onAttach` from the controller's
  // `useEffect` once `controlRef.current` is populated. Pre-fix this
  // path scheduled `queueMicrotask(drainPending)` from `pushEnvelope`,
  // which raced React's commit — when the microtask won, the queue
  // was abandoned because `controlRef.current` was still null and the
  // microtask never re-fired. The reserved-channel replay path on the
  // iframe-runtime delivers WS frames synchronously from the WS
  // message handler, so this race fired every time on a freshly-
  // navigated viewer.
  const pending: StreamEnvelope[] = [];
  let pendingSuspendState: boolean | null = null;

  function drainPending(): void {
    const ref = controlRef.current;
    if (ref === null) return;
    for (const env of pending) ref.pushEnvelope(env);
    pending.length = 0;
    if (pendingSuspendState === true) ref.suspend();
    if (pendingSuspendState === false) ref.resume();
    pendingSuspendState = null;
  }

  root.render(
    createElement(ProvisionalController, {
      controlRef,
      onAttach: drainPending,
      ...(opts.fallback !== undefined ? { fallback: opts.fallback } : {}),
    }),
  );

  return {
    pushEnvelope(envelope) {
      if (controlRef.current === null) {
        pending.push(envelope);
        return;
      }
      controlRef.current.pushEnvelope(envelope);
    },
    suspend() {
      if (controlRef.current === null) {
        pendingSuspendState = true;
        return;
      }
      controlRef.current.suspend();
    },
    resume() {
      if (controlRef.current === null) {
        pendingSuspendState = false;
        return;
      }
      controlRef.current.resume();
    },
    unmount() {
      root.unmount();
      container.replaceChildren();
    },
  };
}

// Re-export React for internal symmetry with react-renderer.ts.
export { React };
