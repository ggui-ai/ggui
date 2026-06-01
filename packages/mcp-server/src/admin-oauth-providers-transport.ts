/**
 * Admin OAuth providers transport.
 *
 * Builder-only REST surface so the operator's `/admin/oauth-providers`
 * page can list, paste, toggle, and delete OAuth provider client
 * credentials. Persistence lives in {@link OAuthProvidersStore} —
 * this module is the HTTP shell around it.
 *
 * Endpoints (all gated on builder identity via the same `resolveIdentity`
 * pattern as `/admin/blueprints`):
 *
 *   - `GET    /ggui/admin/oauth-providers`              → list (clientSecret redacted)
 *   - `PUT    /ggui/admin/oauth-providers/:providerId`  → put (200 redacted record)
 *   - `POST   /ggui/admin/oauth-providers/:providerId/toggle` → setEnabled (204)
 *   - `DELETE /ggui/admin/oauth-providers/:providerId`  → remove (204)
 *
 * **clientSecret is NEVER emitted in any response.** The server is
 * the only place a paste-time secret lives — once it's in the file,
 * the API surface only proves it's configured, not what it is.
 *
 * Audit hooks fire on every mutating endpoint. PUT → `auth.oauth-config.write`,
 * toggle → `auth.oauth-config.write`, DELETE → `auth.oauth-config.delete`.
 * Audit sink failures are swallowed so a sink outage never fails the
 * primary action.
 */
import type { Express, Request, Response } from 'express';
import type {
  AuditEntry,
  AuditSink,
  AuthAdapter,
} from '@ggui-ai/mcp-server-core';
import { resolveIdentity, UnauthenticatedError } from './auth.js';
import type { Logger } from './logger.js';
import type { OAuthProviderConfigRecord } from './oauth-login-types.js';
import type { OAuthProvidersStore } from './oauth-providers-store.js';
import { singleParam } from './route-param.js';

export const DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH = '/ggui/admin/oauth-providers';

export interface AdminOAuthProvidersTransportOptions {
  readonly store: OAuthProvidersStore;
  readonly auth: AuthAdapter;
  readonly logger: Logger;
  readonly auditSink?: AuditSink;
  /** Defaults to {@link DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}. */
  readonly path?: string;
}

interface RedactedRecord {
  providerId: string;
  clientId: string;
  clientSecret: '<redacted>';
  source: 'file' | 'env';
  enabled: boolean;
}

function redact(record: OAuthProviderConfigRecord): RedactedRecord {
  return {
    providerId: record.providerId,
    clientId: record.clientId,
    clientSecret: '<redacted>',
    source: record.source,
    enabled: record.enabled,
  };
}

function isEnvOverriddenError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('oauth_provider_env_overridden');
}

function isInvalidIdError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.startsWith('oauth_provider_invalid_id') ||
      err.message.startsWith('oauth_provider_invalid_client_id') ||
      err.message.startsWith('oauth_provider_invalid_client_secret'))
  );
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('oauth_provider_not_found');
}

export function mountAdminOAuthProvidersTransport(
  app: Express,
  opts: AdminOAuthProvidersTransportOptions,
): void {
  const basePath = opts.path ?? DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH;
  const auditSink = opts.auditSink;

  const emitAudit = async (
    entry: Omit<AuditEntry, 'at'>,
    auditLogger: Logger,
  ): Promise<void> => {
    if (!auditSink) return;
    try {
      await auditSink.record({ at: Date.now(), ...entry });
    } catch (err) {
      auditLogger.warn('audit_emit_failed', {
        action: entry.action,
        error: String(err),
      });
    }
  };

  // Builder-identity gate. Same shape as /admin/blueprints — 401 on
  // missing/invalid bearer, 403 on non-builder. Returns true when
  // the route handler may proceed; false when a response was already
  // written.
  const requireBuilder = async (
    req: Request,
    res: Response,
    reqLogger: Logger,
  ): Promise<boolean> => {
    try {
      const identity = await resolveIdentity(opts.auth, req);
      if (identity.identity.kind !== 'builder') {
        reqLogger.warn('admin_oauth_providers_forbidden', {
          identityKind: identity.identity.kind,
        });
        res.status(403).json({
          error: {
            code: 'forbidden',
            message: 'Admin OAuth providers requires a builder identity.',
          },
        });
        return false;
      }
      return true;
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        reqLogger.warn('admin_oauth_providers_unauthenticated', {
          reason: err.message,
        });
        res.status(401).json({
          error: { code: 'unauthenticated', message: err.message },
        });
        return false;
      }
      reqLogger.error('admin_oauth_providers_unexpected_error', {
        error: String(err),
      });
      res.status(500).json({
        error: { code: 'internal', message: 'Internal server error' },
      });
      return false;
    }
  };

  // --- GET base ---
  app.get(basePath, async (req: Request, res: Response) => {
    const reqLogger = opts.logger.child({ route: 'GET ' + basePath });
    if (!(await requireBuilder(req, res, reqLogger))) return;
    try {
      const records = await opts.store.list();
      res.status(200).json({ providers: records.map(redact) });
    } catch (err) {
      reqLogger.error('admin_oauth_providers_list_failed', {
        error: String(err),
      });
      res.status(500).json({
        error: { code: 'internal', message: 'Internal server error' },
      });
    }
  });

  // --- PUT base/:providerId ---
  app.put(`${basePath}/:providerId`, async (req: Request, res: Response) => {
    const reqLogger = opts.logger.child({ route: 'PUT ' + basePath + '/:providerId' });
    if (!(await requireBuilder(req, res, reqLogger))) return;
    const providerId = singleParam(req.params['providerId']) ?? '';
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'] : undefined;
    const clientSecret =
      typeof body['clientSecret'] === 'string' ? body['clientSecret'] : undefined;
    const enabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : undefined;
    if (!clientId || !clientSecret) {
      reqLogger.debug?.('admin_oauth_providers_bad_request', {
        hasClientId: clientId !== undefined,
        hasClientSecret: clientSecret !== undefined,
      });
      res.status(400).json({
        error: {
          code: 'bad_request',
          message: 'Body requires non-empty string `clientId` and `clientSecret`.',
        },
      });
      return;
    }
    try {
      const record = await opts.store.put({
        providerId,
        clientId,
        clientSecret,
        ...(enabled !== undefined ? { enabled } : {}),
      });
      reqLogger.info('admin_oauth_providers_put', { providerId });
      await emitAudit(
        {
          action: 'auth.oauth-config.write',
          actor: { kind: 'builder' },
          resource: { kind: 'oauth-provider', id: providerId },
          metadata: { enabled: record.enabled },
        },
        reqLogger,
      );
      res.status(200).json(redact(record));
    } catch (err) {
      if (isEnvOverriddenError(err)) {
        reqLogger.warn('admin_oauth_providers_env_overridden', { providerId });
        res.status(409).json({
          error: {
            code: 'env_overridden',
            message: (err as Error).message,
          },
        });
        return;
      }
      if (isInvalidIdError(err)) {
        reqLogger.warn('admin_oauth_providers_validation_failed', {
          providerId,
          reason: (err as Error).message,
        });
        res.status(400).json({
          error: { code: 'bad_request', message: (err as Error).message },
        });
        return;
      }
      reqLogger.error('admin_oauth_providers_put_failed', {
        providerId,
        error: String(err),
      });
      res.status(500).json({
        error: { code: 'internal', message: 'Internal server error' },
      });
    }
  });

  // --- POST base/:providerId/toggle ---
  app.post(
    `${basePath}/:providerId/toggle`,
    async (req: Request, res: Response) => {
      const reqLogger = opts.logger.child({
        route: 'POST ' + basePath + '/:providerId/toggle',
      });
      if (!(await requireBuilder(req, res, reqLogger))) return;
      const providerId = singleParam(req.params['providerId']) ?? '';
      const body = (req.body ?? {}) as Record<string, unknown>;
      const enabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : undefined;
      if (enabled === undefined) {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: 'Body requires boolean `enabled`.',
          },
        });
        return;
      }
      try {
        await opts.store.setEnabled(providerId, enabled);
        reqLogger.info('admin_oauth_providers_toggle', { providerId, enabled });
        await emitAudit(
          {
            action: 'auth.oauth-config.write',
            actor: { kind: 'builder' },
            resource: { kind: 'oauth-provider', id: providerId },
            metadata: { enabled },
          },
          reqLogger,
        );
        res.status(204).end();
      } catch (err) {
        if (isEnvOverriddenError(err)) {
          reqLogger.warn('admin_oauth_providers_env_overridden', { providerId });
          res.status(409).json({
            error: {
              code: 'env_overridden',
              message: (err as Error).message,
            },
          });
          return;
        }
        if (isNotFoundError(err)) {
          res.status(404).json({
            error: { code: 'not_found', message: (err as Error).message },
          });
          return;
        }
        if (isInvalidIdError(err)) {
          res.status(400).json({
            error: { code: 'bad_request', message: (err as Error).message },
          });
          return;
        }
        reqLogger.error('admin_oauth_providers_toggle_failed', {
          providerId,
          error: String(err),
        });
        res.status(500).json({
          error: { code: 'internal', message: 'Internal server error' },
        });
      }
    },
  );

  // --- DELETE base/:providerId ---
  app.delete(
    `${basePath}/:providerId`,
    async (req: Request, res: Response) => {
      const reqLogger = opts.logger.child({
        route: 'DELETE ' + basePath + '/:providerId',
      });
      if (!(await requireBuilder(req, res, reqLogger))) return;
      const providerId = singleParam(req.params['providerId']) ?? '';
      try {
        await opts.store.remove(providerId);
        reqLogger.info('admin_oauth_providers_remove', { providerId });
        await emitAudit(
          {
            action: 'auth.oauth-config.delete',
            actor: { kind: 'builder' },
            resource: { kind: 'oauth-provider', id: providerId },
          },
          reqLogger,
        );
        res.status(204).end();
      } catch (err) {
        if (isInvalidIdError(err)) {
          res.status(400).json({
            error: { code: 'bad_request', message: (err as Error).message },
          });
          return;
        }
        reqLogger.error('admin_oauth_providers_remove_failed', {
          providerId,
          error: String(err),
        });
        res.status(500).json({
          error: { code: 'internal', message: 'Internal server error' },
        });
      }
    },
  );
}
