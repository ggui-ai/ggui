/**
 * BYOK LLM-keys plane — gated /ggui/console/llm-keys. Two postures:
 *
 *   - `gateMode: 'admin-token'` (default — OSS-personal):
 *     gate accepts the admin bearer. Single global keyset; the
 *     /settings UI lets the operator paste keys for everyone.
 *   - `gateMode: 'auth-adapter'` (multi-tenant): gate
 *     calls the server's `AuthAdapter`. Each user's keys are
 *     scoped by `scopeFromRequest` (default: `userId`/`appId`).
 *
 * Wire shape (same in both gates):
 *   GET    /ggui/console/llm-keys                 — list providers + presence
 *   POST   /ggui/console/llm-keys                 — set { provider, key }
 *   DELETE /ggui/console/llm-keys/:provider       — clear (idempotent)
 *   POST   /ggui/console/llm-keys/:provider/probe — auth-validation probe
 *
 * Plaintext is NEVER returned on GET — unlike pairing tokens, an LLM
 * key is a one-way paste (operator already has the key elsewhere; the
 * server is just persisting it). The presence + source signal is
 * enough for the /settings UI.
 */

import type {
  AuthAdapter,
  AuthResult,
  LlmProvider,
  ProviderKeyStore,
} from "@ggui-ai/mcp-server-core";
import type { Express, Request } from "express";
import { resolveIdentity, UnauthenticatedError } from "./auth.js";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";

const ADMIN_COOKIE_NAME_LLM = "ggui_console_admin";

/**
 * The LLM_PROVIDERS allowlist matches `LlmProvider` minus `bedrock`
 * (which is IAM-based and never paste-resolvable — see byok-resolver
 * PROVIDER_ENV_NAMES bedrock note). Order is the operator-facing
 * display order: anthropic first since the OSS triad ships claude
 * as the default model.
 */
const LLM_PROVIDERS: ReadonlyArray<Exclude<LlmProvider, "bedrock">> = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
];

/**
 * Mirror of `byok-resolver.ts::PROVIDER_ENV_NAMES` — env-var name
 * ordered list per provider, first non-empty wins. Mirrored rather
 * than imported because `@ggui-ai/cli` is downstream of this
 * package and we can't depend back the other direction.
 */
const PROVIDER_ENV_NAMES: Readonly<Record<Exclude<LlmProvider, "bedrock">, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** BYOK provider-key store backing list/set/delete/probe. */
  readonly providerKeys: ProviderKeyStore;
  /** Which gate guards the plane. */
  readonly gateMode: "admin-token" | "auth-adapter";
  /** Admin token for `admin-token` gate mode (null = gate never passes). */
  readonly adminToken: string | null;
  /** Auth adapter for `auth-adapter` gate mode. */
  readonly auth: AuthAdapter;
  /** Per-request scope resolver override (default: userId/appId/global). */
  readonly scopeFromRequest?: (req: Request, identity: AuthResult | null) => string;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * Mount the LLM-keys routes onto the express app. Returns nothing —
 * the routes self-register.
 */
export function mountConsoleLlmKeysRoutes(opts: MountOptions): void {
  const { app, providerKeys, gateMode, adminToken, auth, logger } = opts;

  const defaultScope = (_req: Request, identity: AuthResult | null): string => {
    if (identity) {
      if (identity.identity.kind === "user") {
        return identity.identity.userId;
      }
      if (identity.identity.kind === "app") {
        return identity.identity.appId;
      }
    }
    return "global";
  };
  const scopeFromRequest = opts.scopeFromRequest ?? defaultScope;

  const requestHasAdminAuthLlm = (req: Request): boolean => {
    if (adminToken === null) return false;
    const authHeader = req.headers["authorization"];
    if (typeof authHeader === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (match && match[1] === adminToken) return true;
    }
    const cookieHeader = req.headers["cookie"];
    if (typeof cookieHeader === "string") {
      for (const raw of cookieHeader.split(";")) {
        const trimmed = raw.trim();
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const name = trimmed.slice(0, eq);
        if (name !== ADMIN_COOKIE_NAME_LLM) continue;
        const value = decodeURIComponent(trimmed.slice(eq + 1));
        if (value === adminToken) return true;
      }
    }
    return false;
  };

  // Per-request identity stash. Populated by the gate when in
  // 'auth-adapter' mode; left null under 'admin-token'. Route
  // handlers read it via `getRequestIdentity(req)` so the scope
  // resolver receives the resolved AuthResult without re-running
  // `resolveIdentity`.
  const llmKeysIdentityByRequest = new WeakMap<Request, AuthResult>();
  const getRequestIdentity = (req: Request): AuthResult | null =>
    llmKeysIdentityByRequest.get(req) ?? null;

  // Path-prefix gate.
  //
  //   admin-token → same shape as /keys (Bearer admin OR
  //                 ggui_console_admin cookie).
  //   auth-adapter → calls `resolveIdentity(auth, req)`. `kind:'builder'`
  //                  is rejected with 401 — the multi-tenant posture
  //                  is meaningless without a real per-caller id.
  app.use("/ggui/console/llm-keys", (req, res, next) => {
    if (gateMode === "admin-token") {
      if (requestHasAdminAuthLlm(req)) return next();
      applyDevtoolSecurityHeaders(res);
      res.status(401).json({ error: "admin_auth_required" });
      return;
    }
    // 'auth-adapter' — the multi-tenant gate.
    resolveIdentity(auth, req)
      .then((identity) => {
        if (identity.identity.kind === "builder") {
          applyDevtoolSecurityHeaders(res);
          res.status(401).json({
            error: "tenant_required",
            message:
              "Multi-tenant /llm-keys requires an end-user or app identity. " +
              'The configured AuthAdapter resolved kind:"builder" — pair a ' +
              'real user/app bearer or use providerKeysGate:"admin-token".',
          });
          return;
        }
        llmKeysIdentityByRequest.set(req, identity);
        next();
      })
      .catch((err: unknown) => {
        applyDevtoolSecurityHeaders(res);
        if (err instanceof UnauthenticatedError) {
          res.status(401).json({ error: "unauthenticated" });
          return;
        }
        logger.warn("console_llm_keys_auth_failed", { error: String(err) });
        res.status(500).json({ error: "auth_unexpected_error" });
      });
  });

  // GET /ggui/console/llm-keys — list providers + presence.
  // Each row reports:
  //   - name:       'anthropic' | 'openai' | 'google' | 'openrouter'
  //   - configured: boolean — true when EITHER env OR file has a key
  //   - source:     'env' | 'file' | null — env wins on collision
  //   - envName:    which env var fired (only present when source='env')
  //   - envNames:   the env-var names this provider accepts
  //                 (informational — the /settings UI shows them so
  //                 operators know they can `export` instead of pasting)
  app.get("/ggui/console/llm-keys", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    try {
      const scope = scopeFromRequest(req, getRequestIdentity(req));
      const filePresent = new Set(await providerKeys.listProviders(scope));
      // Build rows with an optional 12-char prefix preview so the
      // operator can confirm WHICH key is loaded without exposing
      // the secret. 12 chars covers the discriminating prefix
      // (`sk-ant-api03`, `sk-ant-oat01`, `sk-or-v1-…`, etc.) while
      // staying safely under the entropy floor — these prefixes
      // are not secret on their own.
      const rows = await Promise.all(
        LLM_PROVIDERS.map(async (provider) => {
          const envNames = PROVIDER_ENV_NAMES[provider];
          let envHit: string | undefined;
          let envValue: string | undefined;
          for (const name of envNames) {
            const value = process.env[name];
            if (value !== undefined && value.length > 0) {
              envHit = name;
              envValue = value;
              break;
            }
          }
          const inFile = filePresent.has(provider);
          const source: "env" | "file" | null =
            envHit !== undefined ? "env" : inFile ? "file" : null;
          let keyPreview: string | undefined;
          if (envValue !== undefined) {
            keyPreview = envValue.slice(0, 12);
          } else if (inFile) {
            try {
              const ref = await providerKeys.get(scope, provider);
              if (ref) keyPreview = ref.key.slice(0, 12);
            } catch {
              // Best-effort — preview is advisory; never block the GET.
            }
          }
          return {
            name: provider,
            configured: source !== null,
            source,
            ...(envHit !== undefined ? { envName: envHit } : {}),
            envNames: [...envNames],
            inFile,
            ...(keyPreview !== undefined ? { keyPreview } : {}),
          };
        })
      );
      res.json({
        providers: rows,
        scope,
      });
    } catch (err) {
      logger.warn("console_llm_keys_list_failed", {
        error: String(err),
      });
      res.status(500).json({
        error: "list_failed",
        message:
          err instanceof Error
            ? `LLM keys list failed — ${err.message}`
            : `LLM keys list failed — ${String(err)}`,
      });
    }
  });

  // POST /ggui/console/llm-keys — set a provider's key.
  // Body: { provider: 'anthropic'|'openai'|..., key: string }.
  // Returns: { provider, source: 'file', envOverridden: boolean }.
  // `envOverridden: true` means the operator pasted a key but env
  // var also set — the resolver still picks env. The /settings UI
  // surfaces this so operators don't think their paste is in effect.
  app.post("/ggui/console/llm-keys", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const body = req.body as { provider?: unknown; key?: unknown } | undefined;
    const provider = typeof body?.provider === "string" ? body.provider : "";
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!LLM_PROVIDERS.includes(provider as never)) {
      res.status(400).json({
        error: "invalid_provider",
        message: `provider must be one of ${LLM_PROVIDERS.join(", ")}.`,
      });
      return;
    }
    if (key.length === 0 || key.length > 4096) {
      res.status(400).json({
        error: "invalid_key",
        message: "`key` is required (non-empty string, ≤4096 chars).",
      });
      return;
    }
    try {
      const typedProvider = provider as Exclude<LlmProvider, "bedrock">;
      const scope = scopeFromRequest(req, getRequestIdentity(req));
      await providerKeys.set(scope, typedProvider, key);
      const envNames = PROVIDER_ENV_NAMES[typedProvider];
      let envOverride: string | undefined;
      for (const name of envNames) {
        const value = process.env[name];
        if (value !== undefined && value.length > 0) {
          envOverride = name;
          break;
        }
      }
      res.json({
        provider: typedProvider,
        source: "file" as const,
        envOverridden: envOverride !== undefined,
        ...(envOverride !== undefined ? { envName: envOverride } : {}),
      });
    } catch (err) {
      logger.warn("console_llm_keys_set_failed", {
        error: String(err),
        provider,
      });
      res.status(500).json({
        error: "set_failed",
        message:
          err instanceof Error
            ? `LLM key set failed — ${err.message}`
            : `LLM key set failed — ${String(err)}`,
      });
    }
  });

  // DELETE /ggui/console/llm-keys/:provider — clear (idempotent).
  // 204 even when the key wasn't set; mirrors `ProviderKeyStore.delete`
  // contract. NEVER touches env — the operator owns env separately.
  app.delete("/ggui/console/llm-keys/:provider", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const provider = req.params["provider"];
    if (!LLM_PROVIDERS.includes(provider as never)) {
      res.status(400).json({
        error: "invalid_provider",
        message: `provider must be one of ${LLM_PROVIDERS.join(", ")}.`,
      });
      return;
    }
    try {
      const typedProvider = provider as Exclude<LlmProvider, "bedrock">;
      const scope = scopeFromRequest(req, getRequestIdentity(req));
      await providerKeys.delete(scope, typedProvider);
      res.status(204).end();
    } catch (err) {
      logger.warn("console_llm_keys_delete_failed", {
        error: String(err),
        provider,
      });
      res.status(500).json({
        error: "delete_failed",
        message:
          err instanceof Error
            ? `LLM key delete failed — ${err.message}`
            : `LLM key delete failed — ${String(err)}`,
      });
    }
  });

  // POST /ggui/console/llm-keys/:provider/probe — auth-validation health
  // probe for the configured key. Hits each provider's cheapest
  // auth-checking endpoint with a 5s timeout. Status code is always
  // 200 — the `ok` flag carries the verdict so the UI can paint a dot
  // without branching on HTTP status. NEVER returns or logs the key
  // value (latency + ok-flag + provider name only).
  const probeProvider = async (
    provider: Exclude<LlmProvider, "bedrock">,
    key: string
  ): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
  }> => {
    const start = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, 5000);
    try {
      let url: string;
      const headers: Record<string, string> = {};
      if (provider === "anthropic") {
        url = "https://api.anthropic.com/v1/models?limit=1";
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
      } else if (provider === "openai") {
        url = "https://api.openai.com/v1/models";
        headers["Authorization"] = `Bearer ${key}`;
      } else if (provider === "google") {
        // Google uses query-param key auth — no Authorization header.
        url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(
          key
        )}`;
      } else {
        // openrouter — auth/key endpoint validates without listing.
        url = "https://openrouter.ai/api/v1/auth/key";
        headers["Authorization"] = `Bearer ${key}`;
      }
      const res = await globalThis.fetch(url, {
        method: "GET",
        headers,
        signal: ac.signal,
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return { ok: true, latencyMs };
      }
      let detail = "";
      try {
        const body = (await res.json()) as {
          error?: unknown;
          message?: unknown;
        };
        const errField = body.error;
        const errMessage =
          typeof errField === "string"
            ? errField
            : errField !== null &&
              typeof errField === "object" &&
              "message" in errField &&
              typeof (errField as { message?: unknown }).message === "string"
            ? (errField as { message: string }).message
            : typeof body.message === "string"
            ? body.message
            : "";
        if (errMessage.length > 0) detail = ` ${errMessage}`;
      } catch {
        // Non-JSON body — error code alone is enough for the dot.
      }
      return {
        ok: false,
        latencyMs,
        error: `HTTP ${res.status}${detail}`.slice(0, 200),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return {
        ok: false,
        latencyMs,
        error: String(err).slice(0, 200),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  app.post("/ggui/console/llm-keys/:provider/probe", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const provider = req.params["provider"];
    if (!LLM_PROVIDERS.includes(provider as never)) {
      res.status(400).json({
        error: "invalid_provider",
        message: `provider must be one of ${LLM_PROVIDERS.join(", ")}.`,
      });
      return;
    }
    try {
      const typedProvider = provider as Exclude<LlmProvider, "bedrock">;
      // Resolve env-first-then-file, mirroring the GET handler's
      // source rule. Env wins on collision so the probe matches what
      // the generation pipeline would actually send.
      const envNames = PROVIDER_ENV_NAMES[typedProvider];
      let resolvedKey: string | null = null;
      for (const name of envNames) {
        const value = process.env[name];
        if (value !== undefined && value.length > 0) {
          resolvedKey = value;
          break;
        }
      }
      if (resolvedKey === null) {
        const scope = scopeFromRequest(req, getRequestIdentity(req));
        const ref = await providerKeys.get(scope, typedProvider);
        if (ref !== null && ref.key.length > 0) {
          resolvedKey = ref.key;
        }
      }
      if (resolvedKey === null) {
        res.status(400).json({ ok: false, error: "not_configured" });
        return;
      }
      const result = await probeProvider(typedProvider, resolvedKey);
      logger.info("console_llm_keys_probe", {
        provider: typedProvider,
        ok: result.ok,
        latencyMs: result.latencyMs,
      });
      res.json(result);
    } catch (err) {
      logger.warn("console_llm_keys_probe_failed", {
        error: String(err),
        provider,
      });
      res.status(500).json({
        error: "probe_failed",
        message:
          err instanceof Error
            ? `LLM key probe failed — ${err.message}`
            : `LLM key probe failed — ${String(err)}`,
      });
    }
  });
}
