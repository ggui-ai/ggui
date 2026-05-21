/**
 * Seam types for the `ops-apps` MCP tool family. Mirrors the
 * data-model rows that back the console's Apps + Account surfaces
 * (the `GguiApp` and `GguiUser` records). Pure over
 * `@ggui-ai/protocol` shapes — NO AWS / database imports. Cloud
 * deployments bind an AWS-backed implementation; tests bind
 * in-memory fakes.
 *
 * Why an explicit seam vs threading a database client directly: the
 * shared-handler layer must be the same code path with or without a
 * cloud backend. The `AppsSource` interface IS the boundary — wired
 * to a real datastore in production, wired to a Map in tests.
 */

/**
 * One app record, projected for MCP-tool readers. Pure data — no
 * relations, no backend-internal fields. Cloud adapters map the
 * stored model row onto this shape; tests construct it directly.
 */
export interface AppRecord {
  /** Opaque base62 `<8 chars>` — server-minted when the app is provisioned. */
  readonly appId: string;
  /** FK to the owning user's Cognito sub. Used for tenancy gates. */
  readonly ownerSub: string;
  /** User-editable label. */
  readonly displayName: string;
  /** Optional per-app system prompt override. */
  readonly systemPrompt?: string;
  /** ISO timestamp set by the cloud's `provisionGguiApp` Lambda. */
  readonly createdAt: string;
  /** ISO timestamp; bumped on every mutation. */
  readonly updatedAt: string;
}

/**
 * Read+write seam for `GguiApp` rows. The cloud pod implements this
 * against AppSync (`dataClient.models.GguiApp.*` + `provisionGguiApp`
 * custom mutation); tests implement it against in-memory state.
 *
 * Invariants every implementation MUST honor:
 *   - `list(ownerSub)` returns only the rows the caller owns. The
 *     implementation does NOT leak rows from other users.
 *   - `create({ ownerSub, displayName })` mints a fresh `appId`
 *     server-side (cloud: base62 + collision retry; in-memory: any
 *     unique string). Argument-supplied appIds are NOT honored — that
 *     would be a tenant-takeover vector.
 *   - `update`, `delete`, `setSystemPrompt` reject when the row's
 *     `ownerSub` doesn't match the caller's. Implementations either
 *     throw `OpsAppsAccessDeniedError` or return `null` from `get`
 *     (the handler maps null → "not found" so the caller doesn't see
 *     existence across tenants).
 */
export interface AppsSource {
  /** Return every `GguiApp` row whose `ownerSub` matches. */
  list(ownerSub: string): Promise<readonly AppRecord[]>;
  /** Return a single row by id, or `null` when missing OR when `ownerSub` doesn't match. */
  get(args: { appId: string; ownerSub: string }): Promise<AppRecord | null>;
  /** Provision a fresh row. Returns the persisted shape. */
  create(args: { ownerSub: string; displayName?: string }): Promise<AppRecord>;
  /** Rename — set `displayName`. Rejects cross-tenant (`null` from get returned). */
  rename(args: {
    appId: string;
    ownerSub: string;
    displayName: string;
  }): Promise<AppRecord>;
  /** Hard delete. No-throw idempotent — second delete of the same id resolves. */
  delete(args: { appId: string; ownerSub: string }): Promise<void>;
  /** Update the per-app system-prompt override. Empty string clears it. */
  setSystemPrompt(args: {
    appId: string;
    ownerSub: string;
    systemPrompt: string;
  }): Promise<AppRecord>;
}

/**
 * Read+write seam for the `defaultAppId` column on `GguiUser`. Separate
 * interface from `AppsSource` because the column lives on a different
 * table — keeping the seams disjoint lets the cloud adapter bind two
 * unrelated AppSync mutations without one interface dragging in the
 * other.
 *
 * The handler chains `AppsSource.get` (verify the user owns the target)
 * before calling `setDefault` so writes never point at a foreign app.
 */
export interface UserDefaultAppSource {
  /** Persist `User.defaultAppId = appId` for the calling user. */
  setDefault(args: { ownerSub: string; appId: string }): Promise<void>;
  /** Read the current default — used by tests + future inspection tools. */
  getDefault(ownerSub: string): Promise<string | null>;
}

/**
 * Thrown by adapters that prefer surfacing access denial over the
 * "treat as not-found" privacy posture. Handlers translate to the
 * uniform "not found" shape — the error class exists so cloud
 * adapters can be specific in their logs without callers parsing
 * strings.
 */
export class OpsAppsAccessDeniedError extends Error {
  readonly code = 'ops_apps_access_denied' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OpsAppsAccessDeniedError';
  }
}
