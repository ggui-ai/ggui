/**
 * ProvisionalRenderer — consumes the reserved `_ggui:preview` channel
 * and paints the assembling A2UI surface as shimmering, non-interactive
 * shells.
 *
 * Boundary discipline:
 *
 *   * Stream transport — `useChannelStream` (internal seam) subscribes
 *     to the ambient `<GguiRender>` StreamBus filtered to
 *     `_ggui:preview`; the bus's reserved-channel replay ring catches
 *     this component up even when it mounts after the frames arrived.
 *   * Message schema — `parseServerMessage` from `@ggui-ai/preview-a2ui`
 *     validates each envelope payload as a V1 A2UI server message.
 *     Messages that fail the parser are silently dropped (the stream
 *     is upstream-owned; we never crash the host on malformed frames).
 *   * Visual language — `PreviewSurface`, `PreviewFragmentEnter`, and
 *     `StreamingText` from `@ggui-ai/design/preview` carry the glass /
 *     shimmer / disabled affordance. This component knows only about
 *     structure.
 *   * Catalog mapping — A2UI `Component` types dispatch to
 *     `@ggui-ai/design/primitives` (and a `Heading` escape for Text
 *     fragments with an `h1`..`h6` variant). Unknown component types
 *     (or unresolvable child refs) render a neutral shell placeholder
 *     rather than crashing the tree — Haiku may emit catalog types we
 *     don't support yet and the fallback keeps the surface alive.
 *
 * State model mirrors A2UI's adjacency-list shape: a `Map<id, Component>`
 * reduced from the in-order envelope sequence via replace-by-id
 * (`updateComponents`) with `createSurface` starting a fresh surface and
 * `deleteSurface` tearing it down. The component renders only when a
 * fragment with `id: "root"` is present — before that we degrade to the
 * neutral loading fallback the host was already showing.
 */
import { useMemo, type ReactNode } from 'react';
import { PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import {
  parseServerMessage,
  type Component,
  type ServerMessage,
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
import { useChannelStream } from '../hooks/useChannelStream';

/** Key used by A2UI to identify the root component of a surface. */
const A2UI_ROOT_ID = 'root';

export interface ProvisionalRendererProps {
  /**
   * When `true`, the preview surface is hidden — even if envelopes are
   * still arriving. Consumers set this once the authoritative render
   * takes over (e.g. `componentCode` lands on the render and the
   * renderer has swapped in the final component). Does NOT tear down
   * internal state; envelopes keep accumulating in case the consumer
   * toggles back.
   */
  suspended?: boolean;

  /**
   * Content shown while the preview is waiting for the A2UI `root`
   * fragment to arrive. Also shown after `deleteSurface` clears the
   * surface. Defaults to a centred Spinner.
   */
  fallback?: ReactNode;
}

/**
 * Internal reducer state. `fragments` is an immutable snapshot of the
 * surface's current adjacency list keyed by A2UI component id;
 * `surfaceId` pins the active surface so replay from an older surface
 * after a `deleteSurface` doesn't bleed through.
 */
interface ProvisionalState {
  readonly surfaceId: string | null;
  readonly fragments: ReadonlyMap<string, Component>;
}

const EMPTY_STATE: ProvisionalState = {
  surfaceId: null,
  fragments: new Map(),
};

function reduce(state: ProvisionalState, msg: ServerMessage): ProvisionalState {
  if ('createSurface' in msg) {
    // Start a fresh surface. Any in-flight fragments from a previous
    // surface (e.g. an aborted earlier preamble on the same render)
    // are dropped deliberately — A2UI semantics scope components to
    // the surface that declared them.
    return {
      surfaceId: msg.createSurface.surfaceId,
      fragments: new Map(),
    };
  }
  if ('updateComponents' in msg) {
    if (state.surfaceId !== msg.updateComponents.surfaceId) {
      // Stray frame targeting a different surface — ignore.
      return state;
    }
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

function reduceAll(envelopes: ReadonlyArray<StreamEnvelope>): ProvisionalState {
  let state: ProvisionalState = EMPTY_STATE;
  for (const envelope of envelopes) {
    const result = parseServerMessage(envelope.payload);
    if (!result.ok) continue;
    state = reduce(state, result.value);
  }
  return state;
}

/** Inert stub rendered when a referenced child id doesn't resolve. */
function UnresolvedPlaceholder(): ReactNode {
  return (
    <div
      style={{
        minHeight: 24,
        minWidth: 32,
        borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
        backgroundColor: 'var(--ggui-color-outlineVariant, rgba(148, 163, 184, 0.18))',
      }}
      aria-hidden="true"
    />
  );
}

/** Fallback rendered when a known-shape component ends up off-catalog. */
function UnsupportedComponentShell({ name }: { name: string }): ReactNode {
  return (
    <Card padding={12} shadow="none" border>
      <Text variant="caption">{`[${name}]`}</Text>
    </Card>
  );
}

/**
 * Recursively render an A2UI component and its children from the flat
 * adjacency map. Uses `PreviewFragmentEnter` at each level so newly
 * arriving fragments animate in; stable keys (`component.id`) keep
 * replace-by-id updates from re-running the entry animation.
 */
function renderComponent(
  component: Component,
  all: ReadonlyMap<string, Component>,
): ReactNode {
  const resolveChildren = (
    childIds: ReadonlyArray<string> | undefined,
  ): ReactNode[] => {
    if (!childIds) return [];
    return childIds.map((id) => {
      const child = all.get(id);
      if (!child) return <UnresolvedPlaceholder key={id} />;
      return renderComponent(child, all);
    });
  };

  const { id } = component;

  switch (component.component) {
    case 'Row':
      return (
        <PreviewFragmentEnter key={id}>
          <Row
            gap={component.gap}
            align={component.align ?? 'stretch'}
            justify={component.justify ?? 'start'}
          >
            {resolveChildren(component.children)}
          </Row>
        </PreviewFragmentEnter>
      );

    case 'Column':
      return (
        <PreviewFragmentEnter key={id}>
          <Stack
            direction="vertical"
            gap={component.gap}
            align={component.align ?? 'stretch'}
            justify={component.justify ?? 'start'}
          >
            {resolveChildren(component.children)}
          </Stack>
        </PreviewFragmentEnter>
      );

    case 'List':
      return (
        <PreviewFragmentEnter key={id}>
          <Stack direction="vertical" gap={8}>
            {resolveChildren(component.children)}
          </Stack>
        </PreviewFragmentEnter>
      );

    case 'Card': {
      const child = component.child ? all.get(component.child) : undefined;
      return (
        <PreviewFragmentEnter key={id}>
          <Card padding={16} shadow="sm">
            {component.child && !child ? (
              <UnresolvedPlaceholder />
            ) : child ? (
              renderComponent(child, all)
            ) : null}
          </Card>
        </PreviewFragmentEnter>
      );
    }

    case 'Divider':
      return (
        <PreviewFragmentEnter key={id}>
          <Divider orientation={component.orientation ?? 'horizontal'} />
        </PreviewFragmentEnter>
      );

    case 'Text': {
      const variant = component.variant ?? 'body';
      const headingMatch = /^h([1-6])$/.exec(variant);
      if (headingMatch) {
        const level = Number(headingMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6;
        return (
          <PreviewFragmentEnter key={id}>
            <Heading level={level}>
              <StreamingText>{component.text}</StreamingText>
            </Heading>
          </PreviewFragmentEnter>
        );
      }
      // A2UI 'body' / 'caption' / 'label' map 1:1 onto the design
      // system's `Text` variant vocabulary. Unknown variants degrade
      // to default body text — it's a provisional preview, not a
      // strict typography contract.
      const textVariant =
        variant === 'label' || variant === 'caption' ? variant : 'body';
      return (
        <PreviewFragmentEnter key={id}>
          <Text variant={textVariant}>
            <StreamingText>{component.text}</StreamingText>
          </Text>
        </PreviewFragmentEnter>
      );
    }

    case 'Image':
      return (
        <PreviewFragmentEnter key={id}>
          <Image src={component.src} alt={component.alt ?? ''} />
        </PreviewFragmentEnter>
      );

    case 'Icon':
      return (
        <PreviewFragmentEnter key={id}>
          <Icon name={component.name} />
        </PreviewFragmentEnter>
      );

    // All controls render as DISABLED shells. The preview surface
    // already blocks pointer events for its whole subtree; `disabled`
    // adds a second semantic layer so assistive tech reads them as
    // inert, not merely un-clickable. Consumers will see the final
    // interactive controls once `componentCode` arrives.
    case 'Button':
      return (
        <PreviewFragmentEnter key={id}>
          <Button disabled>{component.label}</Button>
        </PreviewFragmentEnter>
      );

    case 'TextField':
      return (
        <PreviewFragmentEnter key={id}>
          <Input
            disabled
            label={component.label}
            placeholder={component.placeholder}
            value={component.value ?? ''}
            onChange={noopOnChange}
          />
        </PreviewFragmentEnter>
      );

    case 'CheckBox':
      return (
        <PreviewFragmentEnter key={id}>
          <Checkbox
            disabled
            label={component.label ?? ''}
            checked={component.checked ?? false}
            onChange={noopOnChange}
          />
        </PreviewFragmentEnter>
      );

    case 'ChoicePicker': {
      // The design system's Select wants an `options` array; if the
      // A2UI payload didn't include one yet (preamble emits the
      // structural shell first, fills options later), render the
      // control with an empty list — it still paints as a disabled
      // affordance.
      const options = component.options ?? [];
      return (
        <PreviewFragmentEnter key={id}>
          <Select
            disabled
            label={component.label}
            value={component.value ?? ''}
            options={options}
            onChange={noopOnChange}
          />
        </PreviewFragmentEnter>
      );
    }

    default: {
      // Exhaustiveness is narrowed by the discriminated union; this
      // arm fires only if a future A2UI catalog entry slips through
      // the parser before the renderer catches up. Fall back to a
      // neutral shell so the subtree keeps painting.
      const unknown = component as { component: string };
      return (
        <PreviewFragmentEnter key={id}>
          <UnsupportedComponentShell name={unknown.component} />
        </PreviewFragmentEnter>
      );
    }
  }
}

// Stable noop so repeated renders don't replace the onChange prop's
// identity — avoids React warnings from the primitive components.
function noopOnChange(): void {
  // intentionally empty — provisional controls are non-interactive
}

/** Default loading fallback rendered while `root` is absent. */
function DefaultFallback(): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 80,
      }}
    >
      <Spinner />
    </div>
  );
}

/**
 * Consumes the reserved `_ggui:preview` channel and paints the
 * assembling A2UI surface. Hidden when `suspended` is set; falls back
 * to `fallback` (or a centred Spinner) until a `root` fragment arrives.
 */
export function ProvisionalRenderer({
  suspended = false,
  fallback,
}: ProvisionalRendererProps = {}) {
  const { envelopes } = useChannelStream(PREVIEW_CHANNEL);

  const state = useMemo(() => reduceAll(envelopes), [envelopes]);

  if (suspended) return null;

  const root = state.fragments.get(A2UI_ROOT_ID);
  if (!root) {
    return <>{fallback ?? <DefaultFallback />}</>;
  }

  return <PreviewSurface>{renderComponent(root, state.fragments)}</PreviewSurface>;
}
