/**
 * Base64 + SHA helpers used by the publish op. Pulled out so the op
 * file stays focused on policy + flow control.
 *
 * Uses `node:crypto` for SHA-384. The wider browser-portable goal of
 * registry-core means we MAY swap to `@noble/hashes` later — the
 * interface is `Uint8Array → string` so the swap is structural.
 */
import { createHash } from 'node:crypto';

/**
 * Decode a base64 string into bytes. Returns `undefined` on malformed
 * input so the caller can surface a domain-specific error rather than
 * a thrown exception.
 *
 * `Buffer.from(b64, 'base64')` is permissive — it ignores invalid
 * chars rather than throwing. To detect malformed input, re-encode and
 * compare against a whitespace-stripped original.
 */
export function safeBase64Decode(b64: string): Uint8Array | undefined {
  const buf = Buffer.from(b64, 'base64');
  const reencoded = buf.toString('base64');
  const normalize = (s: string): string => s.replace(/=+$/, '').replace(/\s/g, '');
  if (normalize(reencoded) !== normalize(b64)) {
    return undefined;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Base64-encode bytes. */
export function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** SHA-384 of bytes, base64-encoded. The wire form for `bundleSha384`. */
export function sha384Base64(bytes: Uint8Array): string {
  return createHash('sha384').update(bytes).digest('base64');
}
