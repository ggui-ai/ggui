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
import type { AppTheme } from '@ggui-ai/protocol';

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
  /**
   * Per-API-key render rate limit (renders/minute). Absent means
   * unlimited — the ONE representation of "no limit" at this seam;
   * adapters normalize stored `null` / `0` onto absence at read time.
   */
  readonly rateLimitPerMinute?: number;
  /** ISO timestamp set when the app was provisioned. */
  readonly createdAt: string;
  /** ISO timestamp; bumped on every mutation. */
  readonly updatedAt: string;
}

/**
 * Partial update applied by {@link AppsSource.update}. Every field is
 * optional; callers pass at least one (the handler enforces
 * non-emptiness before dispatch, implementations MAY throw on an
 * all-absent patch).
 *
 * Clearing sentinels — one per field, normalized by the
 * implementation so the stored row keeps a single "unset"
 * representation:
 *   - `systemPrompt: ''` clears the per-app override.
 *   - `rateLimitPerMinute: 0` clears the limit (unlimited).
 */
export interface AppUpdatePatch {
  /** New display label. Trimmed; 1–120 chars after trim. */
  readonly displayName?: string;
  /** Replacement system-prompt text. Empty string clears the override. */
  readonly systemPrompt?: string;
  /** Renders/minute per API key. `0` clears the limit (unlimited). */
  readonly rateLimitPerMinute?: number;
}

/**
 * Read+write seam for `GguiApp` rows. Cloud deployments bind a
 * datastore-backed implementation; tests implement it against
 * in-memory state.
 *
 * Invariants every implementation MUST honor:
 *   - `list(ownerSub)` returns only the rows the caller owns. The
 *     implementation does NOT leak rows from other users.
 *   - `create({ ownerSub, displayName })` mints a fresh `appId`
 *     server-side (cloud: base62 + collision retry; in-memory: any
 *     unique string). Argument-supplied appIds are NOT honored — that
 *     would be a tenant-takeover vector.
 *   - `update`, `delete`, `setTheme` reject when the row's
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
  /**
   * Apply a partial update ({@link AppUpdatePatch}) to the row.
   * Rejects cross-tenant. Implementations MUST normalize the clearing
   * sentinels (`systemPrompt: ''`, `rateLimitPerMinute: 0`) onto the
   * stored "unset" representation so reads stay single-valued.
   */
  update(args: {
    appId: string;
    ownerSub: string;
    patch: AppUpdatePatch;
  }): Promise<AppRecord>;
  /**
   * Hard delete. No-throw idempotent — a second delete of the same id
   * resolves. Rejects cross-tenant.
   *
   * Scope of the obligation, stated because a caller cannot see it:
   * this seam owns the APP RECORD and nothing else. Whatever other
   * stores hold keyed by the same `appId` — saved blueprints, per-app
   * provider keys, marketplace installs, issued keys — is outside it.
   *
   * An implementation MAY cascade those away inside its own `delete`,
   * and MAY complete that cascade asynchronously after resolving. One
   * that leaves rows behind — permanently or until an asynchronous
   * sweep lands — MUST make that observable: a named, structured event
   * naming the row classes left in place, emitted on the delete that
   * orphaned them, carrying an indication of whether asynchronous
   * completion was arranged. Returning silently is the contract
   * violation — not the orphaning itself. Orphaned rows an operator
   * can enumerate are debt; orphaned rows nobody can find are loss.
   */
  delete(args: { appId: string; ownerSub: string }): Promise<void>;
  /**
   * Replace the app's theme (validated {@link AppTheme}) in a single
   * conditional write scoped to the owning user. Rejects cross-tenant.
   */
  setTheme(args: {
    appId: string;
    ownerSub: string;
    theme: AppTheme;
  }): Promise<{ appId: string; updatedAt: string }>;
}

/**
 * Read+write seam for the `defaultAppId` column on `GguiUser`. Separate
 * interface from `AppsSource` because the column lives on a different
 * table — keeping the seams disjoint lets the cloud adapter bind two
 * unrelated mutations without one interface dragging in the other.
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
 * Uniform "not found" thrown by the ops-apps handlers for missing AND
 * cross-tenant target ids — one shape, no existence leak.
 */
export class AppNotFoundError extends Error {
  readonly code = 'app_not_found' as const;
  constructor(appId: string) {
    super(`app_not_found: no app ${JSON.stringify(appId)} for the calling user`);
    this.name = 'AppNotFoundError';
  }
}

/**
 * Thrown when the delete target IS the caller's default app.
 *
 * `defaultAppId` is what the universal route resolves on every
 * request; deleting the app it names would leave that route pointing
 * at a row that no longer exists. Same lock the console's Delete
 * enforces — the operator picks a different default first, then
 * deletes.
 */
export class DefaultAppDeleteBlockedError extends Error {
  readonly code = 'default_app_delete_blocked' as const;
  constructor(appId: string) {
    super(
      `default_app_delete_blocked: app ${JSON.stringify(appId)} is the calling user's default — set a different default app first, then delete this one`,
    );
    this.name = 'DefaultAppDeleteBlockedError';
  }
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
