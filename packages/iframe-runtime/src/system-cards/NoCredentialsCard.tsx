/**
 * No-credentials system card.
 *
 * Rendered when the server processed a `ggui_render` for a session whose
 * LLM credentials are missing or unresolvable. The user needs to open
 * the server's `/settings` page in a real browser tab to paste an API
 * key.
 *
 * Open-url strategy is delegated to {@link requestOpenUrl} — fires
 * `window.open`, programmatic anchor click, `ui/request/open-url`
 * postMessage, and `tools/call:open_url` postMessage in parallel,
 * with `clipboard.writeText` as the guaranteed-floor fallback. The
 * card observes the `{outcome, mechanism}` result and shows distinct
 * copy for opened / copied / unsupported so the user understands
 * what happened. Hosts that block popups (claude.ai's
 * `claudemcpcontent.com` iframe sandbox) gracefully degrade to the
 * clipboard path; the URL block's `user-select: all` covers the
 * worst case.
 */
import * as React from 'react';
import {
  Card,
  Stack,
  Heading,
  Text,
  Button,
  Badge,
} from '@ggui-ai/design/primitives';
import { requestOpenUrl, type RequestOpenUrlResult } from './host-intents.js';
import { QrCode } from './QrCode.js';

/**
 * Build-id of the iframe-runtime bundle. Injected by esbuild's
 * `define` from `<pkg.version>+<git-sha>`. Surfaced on the system
 * card next to the title so we can tell at a glance which build the
 * user is looking at — diagnoses "is this stale-cached or actually
 * the latest deploy?" without server-side log access.
 *
 * `__GGUI_RUNTIME_BUILD_ID__` is a build-time string literal; the
 * `declare` lets TypeScript know about the global without runtime
 * lookup.
 */
declare const __GGUI_RUNTIME_BUILD_ID__: string;
const BUILD_ID =
  typeof __GGUI_RUNTIME_BUILD_ID__ === 'string'
    ? __GGUI_RUNTIME_BUILD_ID__
    : 'dev';

/**
 * ggui wordmark — `g g u i` in the brand's two-tone alternation.
 * Inlined SVG (24px tall) so the bundle picks up no asset dependency.
 * Colors track theme tokens: `chrome` ≈ surface, `ink` ≈ onSurface.
 * Each glyph sits in a 50×50 box with 8px gaps.
 */
function GguiWordmark(): React.JSX.Element {
  // `text-primary` flips dark↔light per theme mode (charcoal in light,
  // off-white in dark). `gray-300` flips too — the gray scale in
  // `darkTheme` is intentionally inverted, so the wordmark's
  // contrasting "chrome" tone reads correctly under either theme.
  const ink = 'var(--ggui-color-onSurface, #292929)';
  const chrome = 'var(--ggui-color-neutral-300, #d1d5db)';
  return (
    <svg
      viewBox="0 0 224 50"
      width="72"
      height="16"
      role="img"
      aria-label="ggui"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* g1: chrome L + ink inner */}
      <path d="M 0 0 H 50 V 25 H 25 V 50 H 0 Z" fill={chrome} />
      <rect x="33" y="33" width="17" height="17" fill={ink} />
      {/* g2: ink L + chrome inner */}
      <path d="M 58 0 H 108 V 25 H 83 V 50 H 58 Z" fill={ink} />
      <rect x="91" y="33" width="17" height="17" fill={chrome} />
      {/* u: ink, half-circle bottom */}
      <path
        d="M 141 50 C 154.807 50 166 38.8071 166 25 V 0 H 116 V 25 C 116 38.8071 127.193 50 141 50 Z"
        fill={ink}
      />
      {/* i: chrome square */}
      <rect x="174" y="0" width="50" height="50" fill={chrome} />
    </svg>
  );
}

export interface NoCredentialsCardProps {
  /**
   * Absolute URL of the server's settings page. Constructed at boot
   * from `--public-base-url` (or falls back to `host:port`). MUST be
   * absolute — host iframes resolve relative URLs against their own
   * sandbox origin (e.g. `claudemcpcontent.com`), where `/settings`
   * goes to a 404.
   */
  readonly settingsUrl: string;
  /** Optional: the original prompt that triggered the gen, surfaced as a footnote. */
  readonly intent?: string;
}

/**
 * State machine for the primary CTA's button label.
 *
 * Each state corresponds to a distinct user-visible outcome of
 * {@link requestOpenUrl}:
 *
 *   - `idle` — initial / post-cooldown. CTA reads "Open settings".
 *   - `working` — between click and helper resolution (~50ms typical
 *     because clipboard API resolves microtask-fast). CTA reads
 *     "Opening…" so the user knows the click registered.
 *   - `opened` — `window.open` returned a non-null window. CTA reads
 *     "Opened in browser ✓". Most likely the user IS now on the
 *     settings page in a new tab.
 *   - `copied` — popup blocked but clipboard worked. CTA reads
 *     "URL copied — paste in your browser". The URL block remains
 *     visible above so the user can confirm the address.
 *   - `manual` — every mechanism blocked. CTA reads "Tap the URL
 *     above to copy". The `user-select: all` URL block is the only
 *     remaining path.
 *
 * States auto-cycle back to `idle` after `OUTCOME_TTL_MS` so the
 * user can retry without having to re-mount the card.
 */
type CtaState = 'idle' | 'working' | 'opened' | 'copied' | 'manual';
const OUTCOME_TTL_MS = 4000;

export function NoCredentialsCard({
  settingsUrl,
  intent,
}: NoCredentialsCardProps): React.JSX.Element {
  const [ctaState, setCtaState] = React.useState<CtaState>('idle');

  const onPrimary = React.useCallback(() => {
    // Diagnostic logging — surfaces in the iframe's devtools console
    // (claude.ai web: "Open frame in new tab" then DevTools; desktop:
    // sandboxed and console-less, so we ALSO surface state in the
    // CTA label). The `[ggui:no-creds-card]` prefix makes these
    // greppable.
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console -- diagnostic trace, see helper docstring
      console.log('[ggui:no-creds-card] click → settingsUrl =', settingsUrl);
    }
    setCtaState('working');
    void requestOpenUrl(settingsUrl).then((result: RequestOpenUrlResult) => {
      if (typeof console !== 'undefined') {
        // eslint-disable-next-line no-console -- diagnostic trace, see helper docstring
        console.log('[ggui:no-creds-card] requestOpenUrl resolved →', result);
      }
      const next: CtaState =
        result.outcome === 'opened'
          ? 'opened'
          : result.outcome === 'copied'
            ? 'copied'
            : 'manual';
      setCtaState(next);
      if (typeof window !== 'undefined') {
        window.setTimeout(() => setCtaState('idle'), OUTCOME_TTL_MS);
      }
    });
  }, [settingsUrl]);

  const ctaLabel: string =
    ctaState === 'working'
      ? 'Opening…'
      : ctaState === 'opened'
        ? 'Opened in browser ✓'
        : ctaState === 'copied'
          ? 'URL copied — paste in your browser'
          : ctaState === 'manual'
            ? 'Tap the URL above to copy'
            : 'Open settings';
  const ctaDisabled = ctaState === 'working';

  // Color tokens that auto-flip between light + dark mode. Only the
  // tokens defined in BOTH `lightTheme` and `darkTheme` are safe to
  // use without fallback divergence — `surface`, `text-primary`,
  // `text-secondary`, and the gray scale (which is intentionally
  // INVERTED in darkTheme so `gray-100` is light-on-dark when in
  // dark mode and dark-on-light when in light mode).
  //
  //   - `--ggui-color-surface` — opaque card surface (white in light,
  //     slate-800 in dark). Used for the URL block + QR backdrop.
  //   - `--ggui-color-onSurface` — high-contrast body text.
  //   - `--ggui-color-onSurfaceVariant` — muted captions/headings.
  //   - `--ggui-color-neutral-100` — subtle tinted background that
  //     auto-flips. Used for the inner "details" panel — slightly
  //     differentiated from outer transparent canvas without being
  //     a hard surface.
  //   - `--ggui-color-neutral-200` — subtle outline that auto-flips.
  return (
    // Outer Card is forced transparent — when this card renders inside
    // an MCP App iframe (claude.ai web, Claude Desktop), the host
    // already draws its own chat-bubble surface. A second opaque
    // background creates a card-on-card look. Padding stays so content
    // doesn't crowd the iframe edges. Outside Claude (preview iframe,
    // console inspector), the ThemeProvider's body background is the
    // theme's `--ggui-color-surface`, so a transparent card just
    // shows the theme's canvas behind it — also fine.
    <Card
      padding="lg"
      border={false}
      shadow="none"
      style={{ backgroundColor: 'transparent' }}
    >
      <Stack gap="lg">
        <Stack gap="md">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--ggui-spacing-3, 12px)',
            }}
          >
            <GguiWordmark />
            <Badge variant="info">Setup needed</Badge>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 'var(--ggui-spacing-3, 12px)',
              flexWrap: 'wrap',
            }}
          >
            <Heading level={3}>Connect an LLM provider</Heading>
            <code
              style={{
                fontFamily:
                  'var(--ggui-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                fontSize: 'var(--ggui-font-size-xs, 11px)',
                color: 'var(--ggui-color-onSurfaceVariant, #71717a)',
                opacity: 0.7,
                userSelect: 'all',
              }}
              title="iframe-runtime build identifier — useful for diagnosing stale caches"
            >
              {BUILD_ID}
            </code>
          </div>
          <Text
            style={{
              color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              lineHeight: '1.55',
            }}
          >
            ggui needs an LLM key to render UIs. Open this server&rsquo;s
            settings page to paste an Anthropic, OpenAI, Google, or
            OpenRouter API key.
          </Text>
        </Stack>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--ggui-spacing-3, 12px)',
            padding: 'var(--ggui-spacing-4, 16px)',
            background: 'var(--ggui-color-neutral-100, #f4f4f5)',
            border: '1px solid var(--ggui-color-neutral-200, #e4e4e7)',
            borderRadius: 'var(--ggui-shape-radius-md, 10px)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 'var(--ggui-spacing-4, 16px)',
              alignItems: 'flex-start',
              flexWrap: 'wrap',
            }}
          >
            {/* QR code — bypass the sandbox via phone camera. The */}
            {/* QrCode component returns null on encoder failure */}
            {/* (URL too long for any error-correction level), in */}
            {/* which case we silently fall through to the URL */}
            {/* block + button below. Settings URLs are short — */}
            {/* this fallback fires almost never in practice. */}
            {/*  */}
            {/* QR colors are HARDCODED black-on-white (not themed). */}
            {/* A QR code must look like a printed code regardless of */}
            {/* theme so the phone camera's contrast detection works */}
            {/* — using `--ggui-color-surface` would render dark-on- */}
            {/* dark in dark mode, making the code unscannable. */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--ggui-spacing-2, 8px)',
              }}
            >
              <div
                style={{
                  padding: 'var(--ggui-spacing-2, 8px)',
                  background: '#ffffff',
                  borderRadius: 'var(--ggui-shape-radius-sm, 6px)',
                  lineHeight: 0,
                }}
              >
                <QrCode
                  value={settingsUrl}
                  size={120}
                  foreground="#000000"
                  background="#ffffff"
                />
              </div>
              <Text
                variant="caption"
                style={{
                  color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                  fontSize: 'var(--ggui-font-size-xs, 11px)',
                  textAlign: 'center',
                }}
              >
                Scan with your phone
              </Text>
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ggui-spacing-2, 8px)',
                flex: '1 1 240px',
                minWidth: '200px',
              }}
            >
              <Text
                variant="caption"
                style={{
                  color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                  fontWeight: 'var(--ggui-font-weight-semibold, 600)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontSize: 'var(--ggui-font-size-xs, 11px)',
                }}
              >
                Or open this URL in your browser
              </Text>
              <div
                style={{
                  fontFamily:
                    'var(--ggui-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                  fontSize: 'var(--ggui-font-size-sm, 13px)',
                  color: 'var(--ggui-color-onSurface, #111)',
                  wordBreak: 'break-all',
                  userSelect: 'all',
                  padding: 'var(--ggui-spacing-3, 12px)',
                  background: 'var(--ggui-color-surface, #fff)',
                  border: '1px solid var(--ggui-color-neutral-200, #e4e4e7)',
                  borderRadius: 'var(--ggui-shape-radius-sm, 6px)',
                  lineHeight: '1.45',
                }}
              >
                {settingsUrl}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--ggui-spacing-3, 12px)',
                  flexWrap: 'wrap',
                }}
              >
                <Button
                  variant="primary"
                  size="md"
                  onClick={onPrimary}
                  disabled={ctaDisabled}
                >
                  {ctaLabel}
                </Button>
                {ctaState === 'idle' || ctaState === 'working' ? (
                  <Text
                    variant="caption"
                    style={{
                      color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                      opacity: 0.85,
                    }}
                  >
                    or tap-and-hold the URL above to copy
                  </Text>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {intent ? (
          <Text
            variant="caption"
            style={{
              color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              opacity: 0.7,
            }}
          >
            Pending prompt: {intent}
          </Text>
        ) : null}
      </Stack>
    </Card>
  );
}
