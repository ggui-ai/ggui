/**
 * Console server-info route.
 *
 *   GET /ggui/console/info — JSON describing this server (name +
 *   version + mode + pairing block + capabilities + storage). Stable
 *   shape so the SPA client in `@ggui-ai/console` can fetch once on
 *   load.
 *
 * Pairing block: `enabled` reflects whether the server was composed
 * with `pairing: true|{...}`. `pending` is the current `activeInit()`
 * read — null when no code is pending OR when pairing is disabled.
 * The landing page renders three distinct copy paths against this
 * shape (disabled / enabled-but-idle / enabled-with-pending) so the
 * client never has to compose state from multiple optional fields.
 *
 * Capabilities block (console status dashboard):
 *   - `toolCount`: the number of MCP tool handlers this server
 *     registered. Same value `server.toolCount` exposes and the
 *     banner prints.
 *   - `blueprintCount`: operator-scoped blueprint count from the
 *     wired `uiRegistry.list()` — 0 when no registry is bound.
 *     Best-effort on read (same contract as `/ggui/console/registry`).
 *   - `primitiveCount`: sum across `primitiveCatalogs`.
 *   - `agentWired`: whether the render-channel + mcpApps path is
 *     live (the server can accept `ggui_render` + live-channel joins).
 *   - `generation.wired`: whether generation deps were bound — the
 *     `ggui_render` LLM path is active. Absent = render returns
 *     `codeReady: false` honest placeholders.
 *   - `generation.hasCredentials`: actually resolves BYOK credentials
 *     via the same seam the render handler uses, so the
 *     operator-facing pill can distinguish three honest states:
 *     off / needs-key / ready.
 *
 * Storage block: 'memory' when the server fell back to the in-memory
 * default, 'custom' when the operator passed one. Keeps the label
 * taxonomy narrow — two states the operator can act on (swap to
 * SQLite, swap to Postgres). Implementation-name leakage (e.g.
 * "InMemoryGguiSessionStore") would couple the wire to class names
 * that are not part of the public contract.
 */

import type { PairingService } from "@ggui-ai/mcp-server-core";
import type { GenerationDeps } from "@ggui-ai/mcp-server-handlers/renders";
import type { DiscoveredPrimitiveCatalog } from "@ggui-ai/project-config/node";
import type { UiRegistry } from "@ggui-ai/ui-registry";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { DEFAULT_BUILDER_APP_ID } from "./auth.js";
import type { ServerInfo } from "./build-mcp.js";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Server identity (name / version / description). */
  readonly info: ServerInfo;
  /** Operator mode surfaced so the SPA shows/hides `/devtools`. */
  readonly mode: "dev" | "prod";
  /** Whether pairing was enabled at composition. */
  readonly pairingEnabled: boolean;
  /** Pairing service (null = pairing disabled / `pending` is null). */
  readonly pairingService: PairingService | null;
  /** Registered tool count. */
  readonly toolCount: number;
  /** Declared-blueprint registry for the blueprintCount probe. */
  readonly uiRegistry?: UiRegistry;
  /** Discovered primitive catalogs for the primitiveCount sum. */
  readonly primitiveCatalogs?: ReadonlyArray<DiscoveredPrimitiveCatalog>;
  /** Whether the mcpApps render path is live (`agentWired`). */
  readonly mcpAppsEnabled: boolean;
  /** Generation deps — presence drives `wired`; resolveLlm drives the
   * `hasCredentials` probe. */
  readonly generation?: GenerationDeps;
  /** Pre-resolved storage labels (option plumbing in the composer). */
  readonly storage: {
    readonly renderStore: "memory" | "custom";
    readonly vectorStore: "memory" | "custom";
  };
  /** Structured logger for best-effort probe warnings. */
  readonly logger: Logger;
}

/**
 * Mount `GET /ggui/console/info` onto the express app. Returns
 * nothing — the route self-registers.
 */
export function mountConsoleInfoRoutes(opts: MountOptions): void {
  const {
    app,
    info,
    mode,
    pairingEnabled,
    pairingService,
    toolCount,
    uiRegistry,
    primitiveCatalogs,
    mcpAppsEnabled,
    generation,
    storage,
    logger,
  } = opts;

  app.get("/ggui/console/info", async (_req, res) => {
    applyDevtoolSecurityHeaders(res);
    let pending: Awaited<ReturnType<PairingService["activeInit"]>> = null;
    if (pairingService) {
      try {
        pending = await pairingService.activeInit();
      } catch (err) {
        // `activeInit` is a read — failure here shouldn't 500 the
        // landing page. Log + return null; operator sees "no pending
        // pair code" which matches reality (we couldn't read one).
        logger.warn("console_active_init_failed", {
          error: String(err),
        });
        pending = null;
      }
    }

    // Provider/model specifics (`generation: { provider, model }`)
    // are intentionally NOT surfaced yet — the `UiGenerator` contract
    // doesn't expose a read-only identity on the handle. Adding that
    // is a generator-package change; the dashboard card lands on the
    // simpler `generation.wired` boolean until then.
    let blueprintCount = 0;
    if (uiRegistry) {
      try {
        const list = await uiRegistry.list();
        blueprintCount = list.length;
      } catch (err) {
        logger.warn("console_info_blueprint_count_failed", {
          error: String(err),
        });
      }
    }
    const primitiveCount = (primitiveCatalogs ?? []).reduce(
      (sum, c) => sum + c.manifest.primitives.length,
      0
    );
    // Generation probe — `wired` reports dep binding; `hasCredentials`
    // actually resolves BYOK credentials via the same seam the render
    // handler uses, so the operator-facing pill can distinguish
    // three honest states: off / needs-key / ready. The split avoids
    // a green "wired" pill next to a "text-only" meta misleading
    // operators when creds are missing.
    //
    // Probe is best-effort: resolveLlm failure (filesystem hiccup,
    // malformed `~/.ggui/credentials.json`) reports
    // `hasCredentials: false`, matching operator expectation
    // "whatever is on disk, this won't fire right now." Absence of
    // creds is a non-error path per the GenerationDeps contract.
    let generationHasCredentials = false;
    if (generation) {
      try {
        const probeResult = await generation.resolveLlm({
          appId: DEFAULT_BUILDER_APP_ID,
          requestId: `console-info-probe-${randomUUID()}`,
        });
        generationHasCredentials = probeResult !== null;
      } catch (err) {
        logger.warn("console_info_credential_probe_failed", {
          error: String(err),
        });
      }
    }

    const capabilities = {
      toolCount,
      blueprintCount,
      primitiveCount,
      agentWired: mcpAppsEnabled,
      generation: {
        wired: generation !== undefined,
        hasCredentials: generationHasCredentials,
      },
    } as const;

    res.json({
      server: info.name,
      version: info.version,
      ...(info.description !== undefined ? { description: info.description } : {}),
      mode,
      pairing: {
        enabled: pairingEnabled,
        pending,
      },
      capabilities,
      storage,
    });
  });
}
