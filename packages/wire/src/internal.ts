/**
 * `@ggui-ai/wire/internal` — the writer side of the connection store
 * (ggui#843). The party is a deployment's runtime: it claims the
 * document's connection writer once, eagerly at boot, under its own
 * name. Never re-exported from the root barrel, so it never lands on
 * `globalThis.__ggui__.wire` and generated component code cannot reach
 * it; the import rewriter refuses the specifier in generated code. No
 * compatibility promise is made on this subpath.
 */
export {
  claimConnectionWriter,
  createConnectionStore,
  ConnectionStoreSlotError,
  ConnectionWriterConflictError,
  ConnectionWriterReleasedError,
  isConnectionStore,
  isConnectionWriterConflictError,
  type ConnectionStore,
  type ConnectionWriter,
} from './connection-store';
