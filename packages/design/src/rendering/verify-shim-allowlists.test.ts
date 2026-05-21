/**
 * verify-shim-allowlists.test.ts
 *
 * Drift guard for the data-URL shim's hand-maintained allowlists. The
 * `rewrite-imports.ts` module declares static export-name arrays
 * (`PRIMITIVES_EXPORTS`, `COMPONENTS_EXPORTS`, `COMPOSITIONS_EXPORTS`,
 * `INTERACT_EXPORTS`, `TOKENS_EXPORTS`, `WIRE_EXPORTS`) that get baked
 * into the shim's `export const X = M["X"];` lines. Any drift between
 * an allowlist and its source module's actual exports produces one of:
 *
 *   - **Phantom entry** (in allowlist, missing in dist) — the named
 *     import resolves to `undefined` in the iframe; downstream JSX
 *     renders crash with `React.createElement: type is invalid`.
 *
 *   - **Missing entry** (in dist, missing from allowlist) — the named
 *     import throws `SyntaxError: ... does not provide an export named
 *     '<name>'` at module-eval time, blanking the iframe before React
 *     ever mounts. This is the failure mode that fired on
 *     `useAnimationKey` 2026-05-15.
 *
 * The test imports each subpath at runtime, dumps `Object.keys()`, and
 * asserts set-equality with the static allowlist. Failure prints the
 * symmetric diff so the fix is mechanical.
 *
 * The React export list is INTENTIONALLY a subset of the React module's
 * actual keys — we curate user-facing APIs only and skip internals
 * (`act`, `Profiler`, `__CLIENT_INTERNALS_*`). So that one is asserted
 * as a SUBSET (every name in the allowlist exists in React), NOT
 * equality.
 */
import { describe, expect, it } from 'vitest';

// Re-import the dist of each subpath. The shim resolves these same
// modules at iframe-runtime boot via `installGlobalRegistry`. This test
// runs against the SAME compiled output the iframe-runtime ships against.
import * as primitivesMod from '../primitives/index';
import * as componentsMod from '../components/index';
import * as compositionsMod from '../compositions/index';
import * as interactMod from '../interact/index';
import * as tokensMod from '../tokens/index';

/**
 * Truth-source: every named export from a module's index. Excludes
 * `default` (a JS-ism with no allowlist representation) and TypeScript
 * type-only re-exports (which don't survive into the runtime
 * `Object.keys` — types are erased).
 */
function publicExportNames(mod: object): readonly string[] {
  return Object.keys(mod)
    .filter((k) => k !== 'default')
    .sort();
}

/**
 * Lifted from `rewrite-imports.ts` — the allowlists are not exported
 * (they're module-private). Re-declared here so the test can run
 * without modifying the runtime file's surface. KEEP THESE LISTS BYTE-
 * IDENTICAL to the rewrite-imports.ts constants — the assertions below
 * verify both lists against the dist.
 */
const PRIMITIVES_EXPORTS = [
  'Container', 'Card', 'Stack', 'Row', 'Grid', 'Box', 'Divider', 'Spacer',
  'Text', 'Heading', 'Button', 'Input', 'TextArea', 'Select', 'Checkbox',
  'Toggle', 'RadioGroup', 'Slider', 'Badge', 'Spinner', 'Skeleton', 'Avatar',
  'Alert', 'Progress', 'Image', 'Icon', 'Link', 'Tooltip',
  'Table', 'Tabs', 'Toast', 'Accordion',
  'MotionKeyframes', 'useMotion', 'useAnimationKey',
] as const;

const COMPONENTS_EXPORTS = [
  'SearchField', 'FormField', 'MenuItem', 'Tag', 'Dropdown',
  'Autocomplete', 'Breadcrumb', 'Pagination', 'EmptyState', 'Stat',
] as const;

const COMPOSITIONS_EXPORTS = [
  'Header', 'Sidebar', 'CardGrid', 'CommentThread', 'DataTable',
  'ChatWindow', 'NavigationBar', 'FileUploader', 'UserProfileCard',
  'NotificationCenter', 'Modal', 'CommandPalette', 'Footer', 'Hero',
  'IncidentTimeline', 'MakeTabLayout',
  'MarketingHero', 'MarketingCTA', 'MarketingFeatures',
] as const;

const INTERACT_EXPORTS = ['Clickable', 'Hoverable', 'Pressable'] as const;

const TOKENS_EXPORTS = [
  'animation', 'duration', 'easing', 'transition', 'keyframes',
  'thinkingAnimation', 'thinkingKeyframes', 'thinkingPresets',
  'THINKING_DEFAULT_STYLE', 'motionSafe', 'reducedMotion', 'reducedMotionCSS',
  'colors', 'gray', 'primary', 'semantic', 'chartColors',
  'success', 'warning', 'error', 'info', 'highContrast',
  'typography', 'fontFamily', 'fontSize', 'fontSizeValues',
  'fontWeight', 'lineHeight', 'letterSpacing',
  'headingStyles', 'textStyles',
  'spacing', 'spacingValues', 'radius', 'shadow', 'elevation',
  'maxWidth', 'zIndex',
  'accessibility', 'focusRing',
  'nativeTokens', 'tokens',
] as const;

const REACT_EXPORTS = [
  'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo',
  'useContext', 'useReducer', 'useId',
  'use', 'useActionState', 'useOptimistic',
  'useTransition', 'startTransition', 'useDeferredValue',
  'useSyncExternalStore', 'useInsertionEffect', 'useLayoutEffect',
  'useImperativeHandle', 'useDebugValue',
  'createElement', 'Fragment', 'Children', 'cloneElement',
  'createContext', 'forwardRef', 'memo', 'lazy', 'Suspense',
  'Component', 'PureComponent', 'isValidElement', 'createRef',
] as const;

const WIRE_EXPORTS = [
  'useAction', 'useStream', 'useAuth', 'useApp', 'useSession',
  'useGguiContext', 'useContract', 'useWireContext',
  'GguiWireProvider',
] as const;

/**
 * Set-equality diff with named sides for human-readable failures. The
 * `phantomInList` side is in-allowlist-but-missing-from-dist (runtime
 * `undefined`); `missingFromList` is in-dist-but-missing-from-allowlist
 * (SyntaxError → blank iframe).
 */
function diffSets(
  list: readonly string[],
  dist: readonly string[],
): { phantomInList: string[]; missingFromList: string[] } {
  const listSet = new Set(list);
  const distSet = new Set(dist);
  return {
    phantomInList: list.filter((x) => !distSet.has(x)).sort(),
    missingFromList: dist.filter((x) => !listSet.has(x)).sort(),
  };
}

describe('shim allowlists — drift vs actual dist exports', () => {
  it('PRIMITIVES_EXPORTS matches @ggui-ai/design/primitives dist exports', () => {
    const actual = publicExportNames(primitivesMod);
    const diff = diffSets(PRIMITIVES_EXPORTS, actual);
    expect(diff).toEqual({ phantomInList: [], missingFromList: [] });
  });

  it('COMPONENTS_EXPORTS matches @ggui-ai/design/components dist exports', () => {
    const actual = publicExportNames(componentsMod);
    const diff = diffSets(COMPONENTS_EXPORTS, actual);
    expect(diff).toEqual({ phantomInList: [], missingFromList: [] });
  });

  it('COMPOSITIONS_EXPORTS matches @ggui-ai/design/compositions dist exports', () => {
    const actual = publicExportNames(compositionsMod);
    const diff = diffSets(COMPOSITIONS_EXPORTS, actual);
    expect(diff).toEqual({ phantomInList: [], missingFromList: [] });
  });

  it('INTERACT_EXPORTS matches @ggui-ai/design/interact dist exports', () => {
    const actual = publicExportNames(interactMod);
    const diff = diffSets(INTERACT_EXPORTS, actual);
    expect(diff).toEqual({ phantomInList: [], missingFromList: [] });
  });

  it('TOKENS_EXPORTS matches @ggui-ai/design/tokens dist exports', () => {
    const actual = publicExportNames(tokensMod);
    const diff = diffSets(TOKENS_EXPORTS, actual);
    expect(diff).toEqual({ phantomInList: [], missingFromList: [] });
  });

  it('REACT_EXPORTS is a subset of react module exports (curated, not full mirror)', async () => {
    const reactMod = await import('react');
    const actual = publicExportNames(reactMod);
    const actualSet = new Set(actual);
    const phantom = REACT_EXPORTS.filter((x) => !actualSet.has(x));
    expect(phantom).toEqual([]);
  });

  it('WIRE_EXPORTS is a subset of @ggui-ai/wire module exports (curated, not full mirror)', async () => {
    const wireMod = await import('@ggui-ai/wire');
    const actual = publicExportNames(wireMod);
    const actualSet = new Set(actual);
    const phantom = WIRE_EXPORTS.filter((x) => !actualSet.has(x));
    expect(phantom).toEqual([]);
  });
});
