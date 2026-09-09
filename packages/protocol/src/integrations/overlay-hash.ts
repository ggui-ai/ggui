/**
 * Overlay attestation (ggui#987 §6.3): ONE canonical serialization and ONE
 * hash for the per-app theme overlay, so every minter (a platform's
 * projector, a console, a CLI) and every write door compute the same bytes.
 *
 * Canonical JSON: object keys sorted recursively, no whitespace, `undefined`
 * members omitted, strings/numbers as JSON emits them. Hash: SHA-256 over the
 * UTF-8 bytes, lowercase hex. Async because it uses Web Crypto
 * (`globalThis.crypto.subtle`), available in every runtime the protocol
 * targets.
 */
import type { AppTheme } from '../schemas/app-theme.js';

/** The attested part of an overlay — never `mode`, `name` or `frameless`. */
export type OverlayHashInput = Pick<AppTheme, 'overlays' | 'cssVariables' | 'keyframes'>;

type Json = string | number | boolean | null | Json[] | { readonly [k: string]: Json | undefined };

function canonicalize(v: Json | undefined): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalize(x)).join(',')}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
}

/** The canonical JSON the hash is taken over — exported so tests and other minters can pin it. */
export function canonicalOverlayJson(input: OverlayHashInput): string {
  const doc: { readonly [k: string]: Json | undefined } = {
    overlays: input.overlays,
    cssVariables: input.cssVariables,
    keyframes: input.keyframes,
  };
  return canonicalize(doc);
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256(canonicalOverlayJson(input))` as lowercase hex — the value `AppTheme.overlayHash` carries. */
export async function canonicalOverlayHash(input: OverlayHashInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalOverlayJson(input));
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}
