/**
 * The document's connection store (ggui#670) — the single in-document
 * external store behind `useRender().isConnected`.
 *
 * One store per document, by design: the relay latch describes the
 * HOST, not the render, and every mount in this document shares the
 * host (there is exactly one boot per document; re-mounts inherit it).
 * The runtime is the only writer, through `transitionRelayLatch` in
 * `runtime.ts` — the latch's two edges are the only transitions. Lives
 * re-exported here so the runtime's writer sites name one local
 * module; the store itself is wire's package singleton (the wire docs
 * generator prints every WireConfig member into the prompt, so the
 * store is deliberately NOT a config member).
 *
 * Not a reserved stream channel: nothing on the wire can reach it
 * (SPEC §4.4 forbids renderer-authored `_ggui:*` deliveries, and a
 * registered-but-ungated channel would have been a forgery path — the
 * adversarial pass on ggui#670).
 */
export { connectionStore } from '@ggui-ai/wire';
