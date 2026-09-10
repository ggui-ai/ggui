/**
 * Host font installation (ggui#987 §5).
 *
 * An MCP Apps host may hand the card `@font-face` rules in
 * `hostContext.styles.css.fonts`. The card installs them under ONE
 * `<style id="ggui-host-fonts">`, REPLACING the previous payload on
 * every `hostcontextchanged` — a host that switches fonts repaints, a
 * host that re-announces the same fonts is a no-op. (The reference
 * helper appends a fresh `<style>` per call, so a long-lived card
 * accumulated every font the host ever announced.)
 *
 * The document's CSP decides whether a face's `src` may load. When it
 * refuses one, the browser fires `securitypolicyviolation` with the
 * `font-src` directive and the blocked URL (origin-stripped for
 * cross-origin — hence the (family, host) key); the card reports it to
 * the embedding host ONCE per (family, host) as `font-face-blocked`,
 * so the operator sees the allowlist gap instead of a silent fallback.
 */
import { postObservabilityToParent } from './observability.js';

/** The single `<style>` the host's faces live under. */
export const HOST_FONTS_STYLE_ID = 'ggui-host-fonts';

interface InstalledFace {
  readonly family: string;
  /** The `src` URLs, verbatim — matched exactly when a report carries the full URL. */
  readonly srcs: ReadonlySet<string>;
  /** Their hosts — matched when a cross-origin report is origin-stripped. */
  readonly hosts: ReadonlySet<string>;
}

let installedFaces: readonly InstalledFace[] = [];
const reported = new Set<string>();
let violationListener: ((ev: Event) => void) | null = null;

/** `SecurityPolicyViolationEvent`'s two fields the report needs — typed
 *  structurally so a jsdom without the constructor still type-checks. */
interface CspViolationLike {
  readonly effectiveDirective?: string;
  readonly blockedURI?: string;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Parse `@font-face` blocks → (family, src hosts). Tolerant: a block
 *  missing either is skipped, never thrown on. */
function parseFaces(css: string): readonly InstalledFace[] {
  const faces: InstalledFace[] = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1] ?? '';
    const familyMatch = /font-family\s*:\s*(["']?)([^;"']+)\1/i.exec(body);
    if (familyMatch === null) continue;
    const family = (familyMatch[2] ?? '').trim();
    const hosts = new Set<string>();
    const srcs = new Set<string>();
    for (const src of body.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/g)) {
      const url = (src[2] ?? '').trim();
      const host = hostOf(url);
      if (host === undefined) continue;
      hosts.add(host);
      srcs.add(url);
    }
    if (family.length > 0 && hosts.size > 0) faces.push({ family, srcs, hosts });
  }
  return faces;
}

function onViolation(ev: Event): void {
  const v = ev as Event & CspViolationLike;
  if (v.effectiveDirective !== 'font-src' || typeof v.blockedURI !== 'string') return;
  const host = hostOf(v.blockedURI);
  if (host === undefined) return;
  // CSP strips a cross-origin `blockedURI` to its origin; a same-origin
  // report carries the full URL. With a path in hand the report is
  // ours only when it names one of OUR `src`s — another stylesheet's
  // font on the same host is not this face's failure.
  const carriesPath = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/./i.test(v.blockedURI);
  for (const face of installedFaces) {
    if (carriesPath ? !face.srcs.has(v.blockedURI) : !face.hosts.has(host)) continue;
    const key = `${face.family}\u0000${host}`;
    if (reported.has(key)) continue;
    reported.add(key);
    postObservabilityToParent({ kind: 'font-face-blocked', family: face.family, host });
  }
}

/**
 * Install (or replace) the host's `@font-face` rules. Idempotent on
 * identical payloads; a different payload replaces the previous one
 * wholesale. Arms the CSP-violation reporter on first use.
 */
export function installHostFonts(fontsCss: string): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(HOST_FONTS_STYLE_ID) as HTMLStyleElement | null;
  if (el === null) {
    el = document.createElement('style');
    el.id = HOST_FONTS_STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== fontsCss) el.textContent = fontsCss;
  installedFaces = parseFaces(fontsCss);
  if (violationListener === null) {
    violationListener = onViolation;
    document.addEventListener('securitypolicyviolation', violationListener);
  }
}

/** @internal — test isolation: drop the style, the report ledger, and the listener. */
export function __resetHostFontsForTest(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(HOST_FONTS_STYLE_ID)?.remove();
  installedFaces = [];
  reported.clear();
  if (violationListener !== null) {
    document.removeEventListener('securitypolicyviolation', violationListener);
    violationListener = null;
  }
}
