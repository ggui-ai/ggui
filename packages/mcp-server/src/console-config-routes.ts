/**
 * Console manifest-read route.
 *
 *   GET /ggui/console/config — VSCode-settings-style read of the
 *   resolved `ggui.json`. Returns the parsed manifest, the raw
 *   file contents for display, and the introspected v1 JSON Schema
 *   (which carries field descriptions via the `.describe()` calls
 *   on `GguiJsonV1`).
 *
 * Source resolution: walks up from `process.cwd()` to find the
 * nearest `ggui.json`. Honest about three states:
 *   - found + valid → `{source: {found:true, path}, manifest, raw, schema}`
 *   - found + invalid → `{source: {found:true, path, error: {message}},
 *     raw, schema}` (no manifest field — the operator inspects the raw
 *     bytes + sees the validation error so they can fix the file)
 *   - not found → `{source: {found:false, searchedFrom}, schema}`
 *     (the schema still ships so operators can browse what would be
 *     configurable IF a manifest existed)
 *
 * Read-only. Form controls on the same payload and a PATCH
 * endpoint with atomic write + conflict detection layer on top.
 */

import { GguiJsonV1 } from "@ggui-ai/project-config";
import { findGguiJson, safeLoadGguiJson } from "@ggui-ai/project-config/node";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Structured logger for read/conversion warnings. */
  readonly logger: Logger;
}

/**
 * Mount `GET /ggui/console/config` onto the express app. Returns
 * nothing — the route self-registers.
 */
export function mountConsoleConfigRoutes(opts: MountOptions): void {
  const { app, logger } = opts;

  app.get("/ggui/console/config", async (_req, res) => {
    applyDevtoolSecurityHeaders(res);
    const searchedFrom = process.cwd();
    const safeSchema = (() => {
      try {
        // `unrepresentable: 'any'` keeps fields backed by `.transform()`
        // (e.g. `generation.model`, parsed at the schema boundary into
        // a typed `LlmRoute`) in the JSON Schema as `{}` instead of
        // throwing. Transforms are runtime-only; the JSON-Schema view
        // serves the console SPA as documentation, so a permissive
        // shape is the honest projection.
        return z.toJSONSchema(GguiJsonV1, { unrepresentable: "any" });
      } catch (err) {
        logger.warn("console_config_schema_conversion_failed", {
          error: String(err),
        });
        return {};
      }
    })();
    const path = findGguiJson(searchedFrom);
    if (path === null) {
      res.json({
        source: { found: false as const, searchedFrom },
        schema: safeSchema,
      });
      return;
    }
    let raw: string | null = null;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      logger.warn("console_config_read_failed", { path, error: String(err) });
    }
    const result = safeLoadGguiJson(path);
    if (!result.success) {
      const cause = result.error.cause;
      const errorMessage = cause instanceof Error ? cause.message : result.error.message;
      res.json({
        source: {
          found: true as const,
          path,
          error: { message: errorMessage },
        },
        ...(raw !== null ? { raw } : {}),
        schema: safeSchema,
      });
      return;
    }
    res.json({
      source: { found: true as const, path },
      manifest: result.data,
      ...(raw !== null ? { raw } : {}),
      schema: safeSchema,
    });
  });
}
