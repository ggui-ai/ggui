/**
 * ProvisionalRenderer — React Native consumer of the reserved
 * `_ggui:preview` channel.
 *
 * Parity with the web renderer where it matters:
 *
 *   - Buffer-until-root — no paint before the A2UI fragment with
 *     `id: "root"` arrives. Caller's `fallback` renders up to that
 *     point.
 *   - Replace-by-id state reducer over `createSurface` /
 *     `updateComponents` / `deleteSurface`.
 *   - Stray frames targeting a non-active `surfaceId` are ignored.
 *   - Malformed A2UI envelopes drop silently.
 *   - Catalog-miss & unresolved-ref fail closed to a neutral shell.
 *   - Controls render in DISABLED state; the preview surface blocks
 *     touches at the root as a second safety layer.
 *
 * Honest RN divergences, all flagged at the call site:
 *
 *   - No Animated entrance / shimmer / caret blink (see
 *     `../preview/*` primitives' JSDoc for why). Motion can land in
 *     a later dedicated slice without touching this file's mapping.
 *   - Image / Icon degrade to `<Image>` (src pass-through) and a
 *     monospaced `[name]` glyph-box respectively — no Lucide or
 *     SVG dep.
 *   - CheckBox uses a simple ☐ / ☑ glyph rather than `<Switch>` so
 *     the checkbox semantic reads correctly at a glance without a
 *     dep on native-side switch styling.
 *   - ChoicePicker shows the label + the first option's label as a
 *     non-interactive row — the real interactive picker arrives with
 *     the final render.
 *
 * Nothing in this file knows that the final render will be a React
 * component bundle or a descriptor tree or anything else. Handoff is
 * driven externally by the StackItemRenderer branch.
 */
import { useMemo, type ReactNode } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import {
  parseServerMessage,
  type Component,
  type ServerMessage,
} from '@ggui-ai/preview-a2ui';
import { useChannelStream } from '../hooks/useChannelStream';
import {
  PreviewFragmentEnter,
  PreviewSurface,
  StreamingText,
} from '../preview';

/** A2UI root fragment id — matches the web renderer. */
const A2UI_ROOT_ID = 'root';

export interface ProvisionalRendererProps {
  /**
   * When `true`, nothing renders — the authoritative surface has
   * taken over. Internal state keeps accumulating envelopes so the
   * renderer can resume cleanly if `suspended` flips back.
   */
  suspended?: boolean;
  /**
   * Shown while the preview is waiting for the A2UI `root` to land
   * (or after `deleteSurface` tears down). Defaults to a minimal
   * muted placeholder so tests don't need to pass one; production
   * callers typically thread their own loading UI.
   */
  fallback?: ReactNode;
}

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

function reduceAll(envelopes: ReadonlyArray<StreamEnvelope>): ProvisionalState {
  let state: ProvisionalState = EMPTY_STATE;
  for (const envelope of envelopes) {
    const result = parseServerMessage(envelope.payload);
    if (!result.ok) continue;
    state = reduce(state, result.value);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const flexAlign: Record<string, ViewStyle['alignItems']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

const flexJustify: Record<string, ViewStyle['justifyContent']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
  evenly: 'space-evenly',
};

function resolveGap(gap: string | undefined): number | undefined {
  if (gap === undefined) return undefined;
  const parsed = parseInt(gap, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function UnresolvedPlaceholder(): ReactNode {
  // Neutral box — tests assert on the testID, production renders a
  // subtle grey pill where the child would have been.
  return (
    <View
      testID="ggui-preview-unresolved"
      style={styles.unresolved}
      accessibilityElementsHidden
    />
  );
}

function UnsupportedComponentShell({ name }: { name: string }): ReactNode {
  return (
    <View testID="ggui-preview-unsupported" style={styles.unsupported}>
      <Text style={styles.unsupportedText}>{`[${name}]`}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

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
          <View
            style={{
              flexDirection: 'row',
              gap: resolveGap(component.gap) ?? 8,
              alignItems: flexAlign[component.align ?? 'stretch'],
              justifyContent: flexJustify[component.justify ?? 'start'],
            }}
          >
            {resolveChildren(component.children)}
          </View>
        </PreviewFragmentEnter>
      );

    case 'Column':
      return (
        <PreviewFragmentEnter key={id}>
          <View
            style={{
              flexDirection: 'column',
              gap: resolveGap(component.gap) ?? 8,
              alignItems: flexAlign[component.align ?? 'stretch'],
              justifyContent: flexJustify[component.justify ?? 'start'],
            }}
          >
            {resolveChildren(component.children)}
          </View>
        </PreviewFragmentEnter>
      );

    case 'List':
      return (
        <PreviewFragmentEnter key={id}>
          <View style={styles.list}>{resolveChildren(component.children)}</View>
        </PreviewFragmentEnter>
      );

    case 'Card': {
      const child = component.child ? all.get(component.child) : undefined;
      return (
        <PreviewFragmentEnter key={id}>
          <View style={styles.card}>
            {component.child && !child ? (
              <UnresolvedPlaceholder />
            ) : child ? (
              renderComponent(child, all)
            ) : null}
          </View>
        </PreviewFragmentEnter>
      );
    }

    case 'Divider':
      return (
        <PreviewFragmentEnter key={id}>
          <View
            style={
              component.orientation === 'vertical'
                ? styles.dividerVertical
                : styles.dividerHorizontal
            }
          />
        </PreviewFragmentEnter>
      );

    case 'Text': {
      const variant = component.variant ?? 'body';
      const variantStyle = resolveTextStyle(variant);
      return (
        <PreviewFragmentEnter key={id}>
          <Text style={variantStyle} accessibilityRole={resolveTextRole(variant)}>
            <StreamingText>{component.text}</StreamingText>
          </Text>
        </PreviewFragmentEnter>
      );
    }

    case 'Image':
      return (
        <PreviewFragmentEnter key={id}>
          <Image
            source={{ uri: component.src }}
            accessibilityLabel={component.alt ?? ''}
            style={styles.image}
          />
        </PreviewFragmentEnter>
      );

    case 'Icon':
      // No icon font / SVG dep at V1 — a glyph box that mirrors the
      // web `<Icon name>` positional contract without importing
      // Lucide. Real iconography arrives with the final render.
      return (
        <PreviewFragmentEnter key={id}>
          <View style={styles.iconBox} accessibilityElementsHidden>
            <Text style={styles.iconText}>{`[${component.name}]`}</Text>
          </View>
        </PreviewFragmentEnter>
      );

    case 'Button':
      return (
        <PreviewFragmentEnter key={id}>
          <Pressable
            disabled
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            style={styles.buttonShell}
          >
            <Text style={styles.buttonLabel}>{component.label}</Text>
          </Pressable>
        </PreviewFragmentEnter>
      );

    case 'TextField':
      return (
        <PreviewFragmentEnter key={id}>
          <View style={styles.controlGroup}>
            {component.label ? (
              <Text style={styles.controlLabel}>{component.label}</Text>
            ) : null}
            <TextInput
              editable={false}
              value={component.value ?? ''}
              placeholder={component.placeholder}
              style={styles.textInputShell}
              accessibilityState={{ disabled: true }}
            />
          </View>
        </PreviewFragmentEnter>
      );

    case 'CheckBox':
      return (
        <PreviewFragmentEnter key={id}>
          <View style={styles.checkboxRow}>
            <View
              accessibilityRole="checkbox"
              accessibilityState={{ disabled: true, checked: component.checked ?? false }}
              style={styles.checkboxGlyph}
            >
              <Text style={styles.checkboxGlyphText}>
                {component.checked ? '☑' : '☐'}
              </Text>
            </View>
            {component.label ? (
              <Text style={styles.controlLabel}>{component.label}</Text>
            ) : null}
          </View>
        </PreviewFragmentEnter>
      );

    case 'ChoicePicker': {
      // Render label + the currently-selected value's label (or the
      // first option's label if no `value` arrived yet). An
      // interactive picker arrives with the final render; this
      // preview is intentionally static.
      const options = component.options ?? [];
      const selected =
        options.find((o) => o.value === component.value) ?? options[0];
      return (
        <PreviewFragmentEnter key={id}>
          <View style={styles.controlGroup}>
            {component.label ? (
              <Text style={styles.controlLabel}>{component.label}</Text>
            ) : null}
            <View
              accessibilityRole="combobox"
              accessibilityState={{ disabled: true }}
              style={styles.pickerShell}
            >
              <Text style={styles.pickerValue}>
                {selected ? selected.label : ''}
              </Text>
            </View>
          </View>
        </PreviewFragmentEnter>
      );
    }

    default: {
      // Narrowed by the discriminated union in production; this arm
      // fires only if an unknown `component` value slips past the
      // parser gate.
      const unknown = component as { component: string };
      return (
        <PreviewFragmentEnter key={id}>
          <UnsupportedComponentShell name={unknown.component} />
        </PreviewFragmentEnter>
      );
    }
  }
}

function resolveTextStyle(variant: string): StyleProp<TextStyle> {
  switch (variant) {
    case 'h1':
      return styles.heading1;
    case 'h2':
      return styles.heading2;
    case 'h3':
      return styles.heading3;
    case 'h4':
    case 'h5':
    case 'h6':
      return styles.heading4;
    case 'caption':
      return styles.caption;
    case 'label':
      return styles.label;
    default:
      return styles.body;
  }
}

function resolveTextRole(variant: string): 'header' | 'text' {
  return /^h[1-6]$/.test(variant) ? 'header' : 'text';
}

function DefaultFallback(): ReactNode {
  return <View testID="ggui-preview-fallback" style={styles.fallback} />;
}

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

  return (
    <PreviewSurface>{renderComponent(root, state.fragments)}</PreviewSurface>
  );
}

const styles = StyleSheet.create({
  // Containers
  list: {
    flexDirection: 'column',
    gap: 8,
  },
  card: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.24)',
  },
  dividerHorizontal: {
    height: 1,
    backgroundColor: 'rgba(148, 163, 184, 0.32)',
    alignSelf: 'stretch',
  },
  dividerVertical: {
    width: 1,
    backgroundColor: 'rgba(148, 163, 184, 0.32)',
    alignSelf: 'stretch',
  },

  // Typography
  heading1: { fontSize: 28, fontWeight: '700', color: '#0f172a' },
  heading2: { fontSize: 22, fontWeight: '700', color: '#0f172a' },
  heading3: { fontSize: 18, fontWeight: '600', color: '#0f172a' },
  heading4: { fontSize: 16, fontWeight: '600', color: '#0f172a' },
  body: { fontSize: 14, color: '#334155' },
  caption: { fontSize: 12, color: '#64748b' },
  label: { fontSize: 13, fontWeight: '500', color: '#475569' },

  // Media
  image: { width: 64, height: 64, borderRadius: 8, backgroundColor: 'rgba(148, 163, 184, 0.16)' },
  iconBox: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(148, 163, 184, 0.18)',
  },
  iconText: { fontSize: 12, color: '#475569' },

  // Controls
  controlGroup: { gap: 4 },
  controlLabel: { fontSize: 13, fontWeight: '500', color: '#475569' },
  buttonShell: {
    backgroundColor: 'rgba(148, 163, 184, 0.28)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 6,
    alignSelf: 'flex-start',
    opacity: 0.7,
  },
  buttonLabel: { fontSize: 14, fontWeight: '600', color: '#334155' },
  textInputShell: {
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.4)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#334155',
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
  },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkboxGlyph: { opacity: 0.7 },
  checkboxGlyphText: { fontSize: 18, color: '#475569' },
  pickerShell: {
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.4)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
  },
  pickerValue: { fontSize: 14, color: '#334155' },

  // Fallbacks
  unresolved: {
    minHeight: 24,
    minWidth: 32,
    borderRadius: 4,
    backgroundColor: 'rgba(148, 163, 184, 0.18)',
  },
  unsupported: {
    padding: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(254, 243, 199, 0.8)',
  },
  unsupportedText: { fontSize: 12, color: '#92400e' },
  fallback: {
    height: 64,
    borderRadius: 8,
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
});
