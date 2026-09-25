/**
 * `@ggui-ai/wire/internal` — the writer side of the connection store
 * (ggui#843). The party is a deployment's runtime: it claims the
 * document's connection writer once, eagerly at boot, under its own
 * name. Never re-exported from the root barrel, so it never lands on
 * `globalThis.__ggui__.wire` and generated component code cannot reach
 * it; the import rewriter refuses the specifier in generated code. No
 * compatibility promise is made on this subpath.
 *
 * `ActionSpentContext` (ggui#1223) is here for the same reason: the runtime
 * provides the card's spent state through it, and generated code reads that
 * state only through `useActionSpent` and cannot provide its own.
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
export { ActionSpentContext } from './action-spent';
