import { createHash } from 'node:crypto';
import { SOCIAL_CARD_RENDERER_DIGEST } from './renderer-digest.js';
import { DEFAULT_EYEBROW, type SocialCardInput } from './social-card.js';

/**
 * Content keys for social-card image URLs.
 *
 * Link-preview services cache a card by its image URL, so a card change
 * reaches a new share only when the URL changes. Put a key in the image URL's
 * path that moves exactly when what the card shows moves:
 *
 * - a card rendered on demand: {@link socialCardKey}, over the card's input
 *   and the renderer's own digest;
 * - a card rendered to a file at build: {@link socialCardKeyFromImage}, over
 *   the rendered bytes.
 *
 * Never key a card on a package version: a consumer inside a workspace never
 * moves it, while the renderer underneath it changes.
 */

/** The number of lowercase hex characters in a key. */
export const SOCIAL_CARD_KEY_LENGTH = 16;

const KEY_PATTERN = new RegExp(`^[0-9a-f]{${SOCIAL_CARD_KEY_LENGTH}}$`);

export interface SocialCardKeyOptions {
  /**
   * The version of whatever turns the card into pixels (the image library or
   * framework route that renders it). It is outside this package and changes
   * what the card shows, so fold it in when you know it.
   */
  readonly engine?: string;
}

/**
 * The key for a card rendered on demand: it moves when any field of `input`
 * moves, when the renderer or its faces change, and when `options.engine`
 * changes, and it is stable otherwise. An omitted `eyebrow` keys like the
 * default it renders as.
 */
export function socialCardKey(input: SocialCardInput, options: SocialCardKeyOptions = {}): string {
  return keyFor(SOCIAL_CARD_RENDERER_DIGEST, input, options.engine);
}

/** The key for a card rendered to a file: a hash of the rendered image's bytes. */
export function socialCardKeyFromImage(image: Uint8Array): string {
  return sha256Hex(image).slice(0, SOCIAL_CARD_KEY_LENGTH);
}

/** Whether `value` is a well-formed key, for a route that serves the current card under any key. */
export function isSocialCardKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/** The key under an explicit renderer digest. Exported for the package's tests; the public entry is {@link socialCardKey}. */
export function keyFor(rendererDigest: string, input: SocialCardInput, engine: string | undefined): string {
  const canonical = canonicalJson({ ...input, eyebrow: input.eyebrow ?? DEFAULT_EYEBROW });
  return sha256Hex(['social-card-key/v1', rendererDigest, engine ?? '', canonical].join('\0')).slice(
    0,
    SOCIAL_CARD_KEY_LENGTH,
  );
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted at every depth, so equal inputs key equally whatever their key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  });
}
