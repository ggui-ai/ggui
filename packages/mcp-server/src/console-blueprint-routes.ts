/**
 * Console blueprint resolution + try-live routes.
 *
 *   GET  /ggui/console/blueprint/:id       — same-origin HTTP mirror of
 *        the `ggui_render_blueprint` MCP tool. Resolves a
 *        manifest-declared blueprint id to its compiled bundle +
 *        metadata via the wired `UiRegistry`; lets the SPA's
 *        `/preview/<id>` route mount the blueprint with a single fetch
 *        instead of negotiating a full MCP round-trip from the browser.
 *   POST /ggui/console/blueprint/:id/try   — create a render, compile
 *        the blueprint's componentCode, commit a render with its full
 *        contract (actionSpec/streamSpec/propsSpec from the manifest),
 *        mint a shortCode, and return `{sessionId, shortCode, url}`.
 *        The returned `/s/<shortCode>` lands on the console's render
 *        viewer + subscribes to the render over `/ws`.
 *
 * Scope: registered only when a `UiRegistry` is present (same gate
 * as the MCP render handler — no registry = no render path, no
 * endpoint). No bearer auth: console routes are same-origin
 * operator-facing; the operator already has OS access to the TSX
 * sources this endpoint serves back.
 *
 * GET failure shape: { error, message } with a matching HTTP code.
 *   - 404 for unknown id OR known-id-no-bundle (source-only /
 *     compile-failed). The operator's remediation is the same in
 *     both cases (fix the manifest / fix the entry / fix the
 *     compile); splitting codes would add noise without signal.
 *   - 400 for malformed id parameters (empty, oversized).
 *
 * Shape symmetry: GET matches `GguiRenderBlueprintOutput` exactly, so
 * the browser-side fetch can share a type import with MCP-tool
 * callers without a translation layer.
 *
 * Try-live gates (all three required):
 *   - `uiRegistry`     — blueprint resolution
 *   - `renderStore`    — render persistence
 *   - `shortCodeIndex` — shortCode → render binding
 *
 * Partial gate (uiRegistry alone) → 503 with a remediation hint.
 */

import type { GguiSessionStore, ShortCodeIndex } from "@ggui-ai/mcp-server-core";
import type { SharedHandler } from "@ggui-ai/mcp-server-handlers";
import type { GguiSession } from "@ggui-ai/protocol";
import type { UiRegistry } from "@ggui-ai/ui-registry";
import type { Express } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import type { ZodRawShape } from "zod";
import { DEFAULT_BUILDER_APP_ID } from "./auth.js";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";
import {
  checkRenderSchemaCompat,
  SchemaCompatError,
  type SchemaCompatMode,
} from "./schema-compat.js";

/**
 * 18-char URL-safe shortCode for `POST /ggui/console/blueprint/:id/try`
 * — visually distinct from the 16-char render-minted shortCodes in
 * `@ggui-ai/mcp-server-handlers/renders/render.ts` so operators
 * reading logs can tell a try-live render from an agent-rendered one
 * at a glance. Same confusable-free alphabet
 * (`[a-z0-9]` minus `1lI0Oo`) so the code stays hand-typable. Entropy
 * ≈ 18 × log₂(31) ≈ 89 bits.
 */
function generateTryLiveShortCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(18);
  let out = "";
  for (let i = 0; i < 18; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Blueprint registry both routes resolve against. */
  readonly uiRegistry: UiRegistry;
  /** GguiSession store the try route commits into (gate 2 of 3). */
  readonly renderStore?: GguiSessionStore;
  /** shortCode → render binding for the try route (gate 3 of 3). */
  readonly shortCodeIndex?: ShortCodeIndex;
  /** Composed handler list the schema-compat check validates against. */
  readonly handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>;
  /** Schema-compat posture (`reject` default / `warn` / `off`). */
  readonly schemaCompatMode: SchemaCompatMode;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * Mount `GET /ggui/console/blueprint/:id` +
 * `POST /ggui/console/blueprint/:id/try` onto the express app.
 * Returns nothing — the routes self-register.
 */
export function mountConsoleBlueprintRoutes(opts: MountOptions): void {
  const { app, uiRegistry, renderStore, shortCodeIndex, handlers, schemaCompatMode, logger } = opts;

  if (renderStore && shortCodeIndex) {
    const renderStoreForTry = renderStore;
    const shortCodeIndexForTry = shortCodeIndex;
    app.post("/ggui/console/blueprint/:id/try", async (req, res) => {
      applyDevtoolSecurityHeaders(res);
      const blueprintId = req.params["id"];
      if (typeof blueprintId !== "string" || blueprintId.length === 0 || blueprintId.length > 256) {
        res.status(400).json({
          error: "invalid_request",
          message: "`id` path parameter must be a non-empty string (≤256 chars)",
        });
        return;
      }
      try {
        const entry = await uiRegistry.get(blueprintId);
        if (!entry) {
          res.status(404).json({
            error: "not_found",
            message: `No blueprint registered with id "${blueprintId}". Check ggui.json#blueprints.include globs + ggui.ui.json#id values.`,
          });
          return;
        }
        const bundle = await uiRegistry.getBundle(blueprintId);
        if (!bundle) {
          res.status(404).json({
            error: "bundle_not_available",
            message: `Blueprint "${blueprintId}" (${entry.manifest.name}) has no bundle available. Either the TSX entry is missing or compile-on-demand failed.`,
          });
          return;
        }
        // Materialize streamed bundles to a string — the render
        // stores componentCode inline. Same rule the sibling GET
        // endpoint applies.
        let code: string;
        if (typeof bundle.code === "string") {
          code = bundle.code;
        } else {
          const reader = bundle.code.getReader();
          const decoder = new TextDecoder();
          let out = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (typeof value === "string") out += value;
            else if (value instanceof Uint8Array) out += decoder.decode(value, { stream: true });
          }
          out += decoder.decode();
          code = out;
        }

        // Same default appId the CLI's pairing-authenticated /mcp
        // ingress resolves for single-tenant OSS — the render is
        // scoped to the same tenant.
        const appId = DEFAULT_BUILDER_APP_ID;
        // Phase B: a render IS the addressable unit; the prior
        // (sessionId, stackItemId) pair collapses to a single
        // sessionId. The blueprint id makes a natural slug; a
        // same-blueprint retry replaces the row.
        const sessionId = `try-${blueprintId}-${randomUUID()}`;
        const createdAt = Date.now();

        const contract = entry.manifest.contract ?? {};
        const render: GguiSession = {
          id: sessionId,
          appId,
          type: "component",
          componentCode: code,
          contentType: bundle.contentType,
          eventSequence: 0,
          createdAt,
          lastActivityAt: createdAt,
          expiresAt: createdAt + 24 * 60 * 60 * 1000,
          description: `Blueprint try-live: ${entry.manifest.name}`,
          // Data contract fields from the manifest. Each is
          // conditionally spread — absent on the manifest →
          // absent on the GguiSession (keeps shape honest + avoids
          // an empty-shape contract tripping structural
          // validators downstream).
          ...(contract.propsSpec ? { propsSpec: contract.propsSpec } : {}),
          ...(contract.actionSpec ? { actionSpec: contract.actionSpec } : {}),
          ...(contract.streamSpec ? { streamSpec: contract.streamSpec } : {}),
        };

        // Schema compatibility check. Fires BEFORE the render
        // commits — if the blueprint's pre-declared actionSpec
        // hints at a same-server tool whose schemas don't align,
        // the operator gets a named `SCHEMA_MISMATCH_ERROR`
        // response at registration time instead of an agent-side
        // surprise on the first dispatched action. Mode sourced
        // from `createGguiServer({schemaCompatCheck})`; defaults
        // to `'reject'`. See `./schema-compat.ts`.
        try {
          const report = checkRenderSchemaCompat(
            render,
            handlers,
            schemaCompatMode,
            `console blueprint-try:${blueprintId}`
          );
          if (!report.compatible) {
            // Non-throwing path (mode === 'warn'): log with full
            // detail so the operator has an observable surface.
            logger.warn("schema_compat_warn", {
              site: "console_blueprint_try",
              blueprintId,
              findingCount: report.findings.length,
              findings: report.findings.map((f) => ({
                kind: f.kind,
                specName: f.specName,
                toolName: f.toolName,
                reason: f.reason,
                violationCount: f.violations.length,
              })),
            });
          }
        } catch (err) {
          if (err instanceof SchemaCompatError) {
            logger.warn("console_blueprint_try_schema_compat_rejected", {
              blueprintId,
              findingCount: err.report.findings.length,
            });
            res.status(422).json({
              error: "SCHEMA_MISMATCH_ERROR",
              message: err.message,
              findings: err.report.findings.map((f) => ({
                kind: f.kind,
                specName: f.specName,
                toolName: f.toolName,
                reason: f.reason,
                violationCount: f.violations.length,
              })),
            });
            return;
          }
          throw err;
        }

        try {
          await renderStoreForTry.commit({ render, appId });
        } catch (err) {
          logger.warn("console_blueprint_try_commit_failed", {
            blueprintId,
            sessionId,
            error: String(err),
          });
          res.status(500).json({
            error: "commit_failed",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        // Mint the shortCode last — if earlier steps failed the
        // client never sees a dangling mapping. Best-effort bind
        // to match render.ts's posture (a put failure shouldn't
        // fail the whole try-live — a 500 here would leave the
        // render behind with no way to resolve from
        // `/s/<shortCode>`, but the operator can still hit the
        // render via `/ggui/console/sessions`).
        const shortCode = generateTryLiveShortCode();
        try {
          await shortCodeIndexForTry.put(shortCode, {
            sessionId,
            appId,
          });
        } catch (err) {
          logger.warn("console_blueprint_try_shortcode_failed", {
            blueprintId,
            sessionId,
            shortCode,
            error: String(err),
          });
          // Don't fail the response — the client can reopen via
          // the renders list. Surface the issue in the payload
          // so the SPA can show a degraded banner.
          res.status(200).json({
            sessionId,
            shortCode: null,
            url: null,
            warning:
              "shortCode minted but not persisted; viewer link unavailable. Open via /ggui/console/sessions.",
          });
          return;
        }

        res.json({
          sessionId,
          shortCode,
          url: `/s/${shortCode}`,
        });
      } catch (err) {
        logger.warn("console_blueprint_try_failed", {
          blueprintId,
          error: String(err),
        });
        res.status(500).json({
          error: "try_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } else {
    // Partial wiring — /try would attempt a render create that
    // has nowhere to land. Surface with 503 + specific message
    // so the operator knows which seam to add (console cookie +
    // shortCodeIndex live on `console.sessionCookie: true`).
    app.post("/ggui/console/blueprint/:id/try", (_req, res) => {
      applyDevtoolSecurityHeaders(res);
      res.status(503).json({
        error: "try_not_wired",
        message:
          "POST /ggui/console/blueprint/:id/try requires `renderChannel: true` + `shortCodeIndex` on createGguiServer. The CLI enables both by default via `console.sessionCookie: true`.",
      });
    });
  }
  app.get("/ggui/console/blueprint/:id", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const blueprintId = req.params["id"];
    if (typeof blueprintId !== "string" || blueprintId.length === 0 || blueprintId.length > 256) {
      res.status(400).json({
        error: "invalid_request",
        message: "`id` path parameter must be a non-empty string (≤256 chars)",
      });
      return;
    }
    try {
      const entry = await uiRegistry.get(blueprintId);
      if (!entry) {
        res.status(404).json({
          error: "not_found",
          message: `No blueprint registered with id "${blueprintId}". Check ggui.json#blueprints.include globs + ggui.ui.json#id values.`,
        });
        return;
      }
      const bundle = await uiRegistry.getBundle(blueprintId);
      if (!bundle) {
        res.status(404).json({
          error: "bundle_not_available",
          message: `Blueprint "${blueprintId}" (${entry.manifest.name}) has no bundle available. Either the TSX entry is missing or compile-on-demand failed — check the manifest directory.`,
        });
        return;
      }
      // Same string-materialization rule as the MCP render handler:
      // collapse stream bundles to a plain string so the browser
      // fetch can JSON-parse the response in one shot.
      let code: string;
      if (typeof bundle.code === "string") {
        code = bundle.code;
      } else {
        const reader = bundle.code.getReader();
        const decoder = new TextDecoder();
        let out = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (typeof value === "string") out += value;
          else if (value instanceof Uint8Array) out += decoder.decode(value, { stream: true });
        }
        out += decoder.decode();
        code = out;
      }
      res.json({
        blueprintId,
        blueprintName: entry.manifest.name,
        code,
        contentType: bundle.contentType,
      });
    } catch (err) {
      logger.warn("console_blueprint_resolve_failed", {
        blueprintId,
        error: String(err),
      });
      res.status(500).json({
        error: "resolve_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
