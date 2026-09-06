/**
 * The document's connection state (ggui#670, ggui#843) — the in-document
 * external store behind `useRender().isConnected`, seen from the runtime.
 *
 * One store per document, by design: the relay latch describes the HOST,
 * not the render, and every mount in this document shares the host (there
 * is exactly one boot per document; re-mounts inherit it). The runtime is
 * the ONE writer, through `transitionRelayLatch` in `runtime.ts` — the
 * latch's two edges are the only transitions — and it proves it by
 * CLAIMING the writer: once, eagerly at boot (`resetRelayLatchForBoot`),
 * under its own name, through `@ggui-ai/wire/internal`. Readers — the
 * wire's `useRender()`, generated component code through the root barrel —
 * hold the read view `connectionSource` and nothing else. (The wire docs
 * generator prints every WireConfig member into the prompt, so the store
 * is deliberately NOT a config member.)
 *
 * A second copy of the runtime in the same document — a second evaluation
 * of the bundle — adopts the SAME store (wire anchors it on the document,
 * not the module copy) and fails at boot, here, naming itself
 * (`ConnectionWriterConflictError`, owner === attemptedBy): the error IS
 * the detector for a duplicate bundle, and boot never continues with an
 * unclaimed writer.
 *
 * Not a reserved stream channel: nothing on the wire can reach it
 * (SPEC §4.4 forbids renderer-authored `_ggui:*` deliveries, and a
 * registered-but-ungated channel would have been a forgery path — the
 * adversarial pass on ggui#670).
 */
import { claimConnectionWriter, type ConnectionWriter } from '@ggui-ai/wire/internal';

export { connectionSource } from '@ggui-ai/wire';

let writer: ConnectionWriter | undefined;

/**
 * The runtime's claim on the document's connection writer — taken on first
 * call and memoized for the document's life. Boot calls it first, so the
 * claim (and any conflict) surfaces before the first transition.
 */
export function runtimeConnectionWriter(): ConnectionWriter {
  return (writer ??= claimConnectionWriter('iframe-runtime'));
}

/**
 * Test seam: release the runtime's claim and forget it, so a test can hand
 * the document's writer to another party (a refusing-boot case) or boot a
 * fresh module graph. Never called by the runtime itself.
 */
export function __resetRuntimeConnectionWriterForTest(): void {
  writer?.release();
  writer = undefined;
}
