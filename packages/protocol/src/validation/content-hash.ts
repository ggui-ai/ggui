// packages/protocol/src/validation/content-hash.ts
//
// SHA-256 content hashing for compiled UI assets — the canonical identity
// function for cached + registered UIs.
//
// Why this lives in its own module (not `ui-security.ts`): `createHash`
// only ships in Node's `node:crypto` builtin. Re-exporting it from the
// protocol's root barrel drags `node:crypto` into every downstream
// bundler's module graph — including browser apps like Studio, where
// webpack refuses to resolve the `node:` scheme and the whole page fails
// to compile. Keeping this in a server-only subpath lets the root barrel
// stay browser-safe.
//
// Consumers (all server-side): `core/src/validation/ui-compiler.ts`,
// `cloud/amplify/functions/rest-api/cli-api/ui-register-handler.ts`.
// Import as `@ggui-ai/protocol/content-hash` — never from the barrel.

import { createHash } from 'node:crypto';

/** SHA-256 content hash (16-char hex) — canonical identity for a compiled UI. */
export function contentHash(compiledCode: string): string {
  return createHash('sha256').update(compiledCode).digest('hex').slice(0, 16);
}
