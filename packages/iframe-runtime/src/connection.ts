/**
 * The document's connection store (ggui#670) — the single in-document
 * external store behind `useRender().isConnected`.
 *
 * One store per document, by design: the relay latch describes the
 * HOST, not the render, and every mount in this document shares the
 * host (there is exactly one boot per document; re-mounts inherit it).
 * The runtime is the only writer, through `transitionRelayLatch` in
 * `runtime.ts` — the latch's two edges are the only transitions. Lives
 * in its own module so `wire-config.ts` (which threads it into the
 * root config) and `runtime.ts` (which writes it) share it without a
 * circular import.
 *
 * Not a reserved stream channel: nothing on the wire can reach it
 * (SPEC §4.4 forbids renderer-authored `_ggui:*` deliveries, and a
 * registered-but-ungated channel would have been a forgery path — the
 * adversarial pass on ggui#670).
 */
import { createConnectionStore, type ConnectionStore } from '@ggui-ai/wire';

export const connectionStore: ConnectionStore = createConnectionStore(true);
