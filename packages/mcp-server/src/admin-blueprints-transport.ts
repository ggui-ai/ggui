/**
 * Admin blueprints transport — `POST /admin/blueprints` route that
 * registers a runtime manifest into the active {@link BlueprintProvider}.
 *
 * Enables runtime blueprint registration. Before this transport the
 * only way to seed a blueprint was declarative via
 * `ggui.json#blueprints.include`; registration at runtime was
 * unreachable.
 *
 * One route:
 *
 *   POST /admin/blueprints    — admin. Bearer auth → builder only.
 *                               Body: {id, name, description?,
 *                               category?, tags?, updatedAt?}.
 *                               Calls `provider.addManifest()` if
 *                               the bound provider exposes it;
 *                               returns `{ok: true, id}` on success.
 *
 * ## Persistence
 *
 * **In-memory only.** Runtime-registered manifests survive until
 * the server process exits. Rationale:
 *
 *   - Persisting to `ggui.json` means rewriting an operator-owned
 *     file on mutation (surprising at best, dangerous at worst —
 *     the file is usually committed to source control).
 *   - Persisting to a sidecar file (`~/.ggui/blueprints.json`) adds
 *     file-atomic-write + concurrency + schema-validation surface
 *     that isn't load-bearing for Q6's "register blueprints"
 *     promise.
 *   - Plan doc explicitly permits this choice: "Or: keep runtime
 *     regs in-memory only — decision in slice, default to
 *     persistence."
 *
 * A follow-up slice can add disk persistence if operators ask for
 * it; this transport's contract doesn't change (the route is
 * still `POST /admin/blueprints` with the same body shape).
 *
 * ## Provider capability negotiation
 *
 * The narrowed `BlueprintProvider` interface (`list` + `get` only,
 * per 2026-04-18 registry-source architecture lock) has no
 * mutation surface. `addManifest()` is an impl-specific affordance
 * on {@link ManifestBlueprintProvider}. At mount time this module
 * checks for the method structurally and returns 501 Not
 * Implemented when absent — so operators running a
 * provider that genuinely can't accept runtime registrations
 * (e.g., a future `DynamoBlueprintProvider` backed by an external
 * catalog) see a clean error rather than a mysterious 500.
 *
 * ## Error mapping
 *
 *   - Missing / malformed body → 400 {code: 'bad_request'}.
 *   - Unauthenticated → 401 {code: 'unauthenticated'}.
 *   - Non-builder identity → 403 {code: 'forbidden'}.
 *   - Provider without `addManifest` → 501 {code: 'not_supported'}.
 *   - Unexpected thrown → 500 {code: 'internal'}.
 *
 * Routes are mounted on the same Express app the server already
 * owns — no sub-router, same `/admin/*` firewall convention as
 * pairing.
 */
import type { Express, Request, Response } from 'express';
import type { AuthAdapter, BlueprintProvider } from '@ggui-ai/mcp-server-core';
import { resolveIdentity, UnauthenticatedError } from './auth.js';
import type { Logger } from './logger.js';

/**
 * Default URL path the admin-blueprints route is mounted at. Sits
 * under the same `/admin/` prefix as `/admin/pair/init` so one
 * firewall rule gates the whole admin surface.
 */
export const DEFAULT_ADMIN_BLUEPRINTS_PATH = '/admin/blueprints';

/**
 * Structural subset of {@link ManifestBlueprintProvider.addManifest}.
 * Duck-typed so this module stays decoupled from the in-memory
 * impl-class import — any {@link BlueprintProvider} that carries an
 * `addManifest` method with the declared shape works.
 */
export interface ManifestRegistrable {
  addManifest(manifest: {
    id: string;
    name: string;
    description?: string;
    category?: string;
    tags?: readonly string[];
    updatedAt?: string;
  }): void;
}

/** Narrow type guard — does the provider accept runtime registrations? */
export function providerAcceptsManifests(
  provider: BlueprintProvider,
): provider is BlueprintProvider & ManifestRegistrable {
  return (
    typeof (provider as { addManifest?: unknown }).addManifest === 'function'
  );
}

export interface AdminBlueprintsTransportOptions {
  /** Required. The provider runtime registrations land on. */
  readonly provider: BlueprintProvider;
  /**
   * Required. Same AuthAdapter the `/mcp` + pairing endpoints use.
   * Gates the route; MUST resolve to a `builder` identity for
   * registration to succeed.
   */
  readonly auth: AuthAdapter;
  /** Structured logger; a per-route child is derived. */
  readonly logger: Logger;
  /**
   * URL path the route is mounted at. Defaults to
   * {@link DEFAULT_ADMIN_BLUEPRINTS_PATH}. Pass `null` to disable
   * the route — operators who want the server but not the admin
   * HTTP surface.
   */
  readonly path?: string | null;
}

/**
 * Mount the admin-blueprints route onto an existing Express app.
 * Call once per server; mounting twice registers the route twice.
 */
export function mountAdminBlueprintsTransport(
  app: Express,
  opts: AdminBlueprintsTransportOptions,
): void {
  const path = opts.path === undefined ? DEFAULT_ADMIN_BLUEPRINTS_PATH : opts.path;
  if (path === null) return;

  const capable = providerAcceptsManifests(opts.provider);
  if (!capable) {
    opts.logger.info('admin_blueprints_not_supported', {
      reason:
        'bound BlueprintProvider does not expose addManifest; route will return 501 on hit',
    });
  }

  app.post(path, async (req: Request, res: Response) => {
    const reqLogger = opts.logger.child({ route: 'POST ' + path });

    // 1. Auth. Same builder-only gate as /admin/pair/init.
    try {
      const identity = await resolveIdentity(opts.auth, req);
      if (identity.identity.kind !== 'builder') {
        reqLogger.warn('admin_blueprints_forbidden', {
          identityKind: identity.identity.kind,
        });
        res.status(403).json({
          error: {
            code: 'forbidden',
            message: `POST ${path} requires a builder identity.`,
          },
        });
        return;
      }
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        reqLogger.warn('admin_blueprints_unauthenticated', { reason: err.message });
        res.status(401).json({
          error: { code: 'unauthenticated', message: err.message },
        });
        return;
      }
      reqLogger.error('admin_blueprints_unexpected_error', { error: String(err) });
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
      return;
    }

    // 2. Body validation. Minimum shape: {id: string, name: string}.
    //    Optional fields: description, category, tags (string[]),
    //    updatedAt (ISO string). Anything else is ignored.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? body['id'] : undefined;
    const name = typeof body['name'] === 'string' ? body['name'] : undefined;
    if (!id || !name) {
      reqLogger.debug?.('admin_blueprints_bad_request', {
        hasId: id !== undefined,
        hasName: name !== undefined,
      });
      res.status(400).json({
        error: {
          code: 'bad_request',
          message: `POST ${path} requires a JSON body with non-empty string \`id\` and \`name\`.`,
        },
      });
      return;
    }

    // Optionals — narrow strictly; silently drop fields that don't
    // match. Duck-typed body-to-manifest shape matches the
    // ManifestBlueprintSeed contract in @ggui-ai/mcp-server-core.
    const description = typeof body['description'] === 'string' ? body['description'] : undefined;
    const category = typeof body['category'] === 'string' ? body['category'] : undefined;
    const updatedAt = typeof body['updatedAt'] === 'string' ? body['updatedAt'] : undefined;
    const tags = Array.isArray(body['tags'])
      ? (body['tags'] as readonly unknown[]).filter(
          (t): t is string => typeof t === 'string',
        )
      : undefined;

    // 3. Capability check. Performed per-request (not once at mount
    //    time) so operators swapping providers in a test harness see
    //    current state, not stale mount-time state.
    if (!providerAcceptsManifests(opts.provider)) {
      reqLogger.warn('admin_blueprints_not_supported', { id });
      res.status(501).json({
        error: {
          code: 'not_supported',
          message:
            'The bound BlueprintProvider does not accept runtime manifest registrations.',
        },
      });
      return;
    }

    // 4. Register. In-memory only — addManifest is idempotent per
    //    the ManifestBlueprintProvider contract (same id overwrites).
    try {
      opts.provider.addManifest({
        id,
        name,
        ...(description !== undefined ? { description } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      });
      reqLogger.info('admin_blueprints_registered', { id, name });
      res.status(200).json({ ok: true, id });
    } catch (err) {
      reqLogger.error('admin_blueprints_failed', { id, error: String(err) });
      res.status(500).json({
        error: { code: 'internal', message: 'Internal server error' },
      });
    }
  });
}
