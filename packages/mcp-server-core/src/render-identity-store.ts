/**
 * RenderIdentityStore — optional durable side-record of what a render
 * WAS, kept so the render can be re-created later from its locator
 * alone.
 *
 * Reference implementation (this package):
 *   - InMemoryRenderIdentityStore (`./in-memory` — tests, dev)
 *
 * Other backends are buildable against this contract. Binding one is
 * a deployment choice, never a requirement: a server with no store
 * bound writes no records, and every existing read path keeps working
 * unchanged.
 */
import type { ComponentGguiSession } from '@ggui-ai/protocol';

/**
 * Durable per-session render identity — the record that lets a
 * `ui://ggui/render/{sessionId}/{blueprintKey}` locator re-mint after
 * the session store's own row is gone. The locator's second SEGMENT is
 * named for its domain (the blueprint key); this record's FIELD keeps
 * the name `contractKey`. Same value, two namespaces — see the field's
 * own docstring for which digest it is. Deployments whose session
 * store is itself durable (the CLI's persistent sqlite default) do
 * not need one: the row already carries everything. Optional
 * everywhere; when absent, locator reads simply require the row.
 */
export interface RenderIdentityRecord {
  readonly sessionId: string;
  readonly appId: string;
  /**
   * Owning user, when the deployment scopes renders to users. Written
   * on every commit, and the subject a re-mint authorizes against.
   *
   * This is the ONLY user field on the record on purpose. A fuller
   * identity block (email, provider, authenticated-at) would be
   * personal data sitting on a record kept for as long as the render
   * is addressable — indefinitely — to answer a question `userId`
   * already answers.
   */
  readonly userId?: string;
  /** Null until cold-gen registration backfills it. */
  readonly blueprintId: string | null;
  /**
   * Blueprint-key domain — the same 16-char key the blueprint registry
   * addresses a contract by, NOT the validators-bundle contract hash.
   * The two are different lengths and different domains; a record
   * carrying the wrong one points a locator at nothing.
   */
  readonly contractKey: string;
  readonly variantKey: string;
  readonly props: ComponentGguiSession['props'];
  /** Sampled at commit time; events appended after the last commit are not reflected. */
  readonly seqAtLastCommit: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Record deletion is deliberately not part of this contract yet — the
 * erasure and retention surface (delete-by-user, delete-by-app,
 * per-app horizons) arrives with the retention substrate that first
 * reads these records. Until then the only writers are best-effort
 * put/refresh paths.
 */
export interface RenderIdentityStore {
  /**
   * Upsert by `record.sessionId`. Later writes win whole-record —
   * there is no field-level merge, so a caller refreshing part of a
   * record MUST read it, merge, and write the full result back.
   *
   * Implementations MUST reject a record whose `sessionId` is empty
   * (the returned promise rejects): an unkeyed record can never be
   * read back, and a silent accept turns that into a lookup miss much
   * later. No typed error is specified — the sole writer treats every
   * put failure identically (best-effort with a named log event).
   *
   * Writers treat the call as best-effort and do not block a render
   * on it, so implementations MUST tolerate overlapping writes on the
   * same key (last-writer-wins is acceptable).
   */
  put(record: RenderIdentityRecord): Promise<void>;

  /**
   * Return the record for a render, or `null` when none was written.
   * An absent record is a normal outcome — renders committed before a
   * store was bound have none — so implementations MUST return `null`
   * rather than throw.
   *
   * Every field round-trips verbatim, including a `blueprintId` of
   * `null` (the pre-backfill state, which is distinct from a miss).
   * The return value MUST be a defensive copy: callers may mutate it
   * without corrupting stored state.
   */
  get(sessionId: string): Promise<RenderIdentityRecord | null>;
}
