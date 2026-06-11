/**
 * Console MCP-tool inventory route.
 *
 *   GET /ggui/console/mcp/tools — registered MCP-tool inventory for
 *   the console SPA's `/mcp` page. Operator-facing "what tools does
 *   my server expose?" — same handler set the `/mcp` JSON-RPC
 *   endpoint surfaces via `tools/list`, but rendered as cards
 *   instead of curl output.
 *
 * Currently LIST-only — name + title? + description + input/output
 * JSON Schema. A "test invoke" form is deferred — invoking a tool
 * from the console needs a same-origin bearer claim story (console
 * session cookie currently authenticates only the live-channel WS
 * upgrade).
 *
 * Schema conversion: handlers carry Zod raw shapes; the wire
 * needs JSON Schema. `z.toJSONSchema(z.object(rawShape))` does
 * the conversion. Failure (e.g. an exotic Zod type the v4
 * converter doesn't yet support) reports `{}` for that field
 * and warn-logs — operators still see name + description, just
 * without typed input/output detail.
 */

import type { SharedHandler } from "@ggui-ai/mcp-server-handlers";
import type { Express } from "express";
import { z, type ZodRawShape } from "zod";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Composed handler list the inventory projects. */
  readonly handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>;
  /** Structured logger for schema-conversion warnings. */
  readonly logger: Logger;
}

/**
 * Mount `GET /ggui/console/mcp/tools` onto the express app. Returns
 * nothing — the route self-registers.
 */
export function mountConsoleMcpToolsRoutes(opts: MountOptions): void {
  const { app, handlers, logger } = opts;

  app.get("/ggui/console/mcp/tools", async (_req, res) => {
    applyDevtoolSecurityHeaders(res);
    interface ToolInfo {
      readonly name: string;
      readonly title?: string;
      readonly description: string;
      readonly inputSchema: unknown;
      readonly outputSchema: unknown;
    }

    const safeToJsonSchema = (shape: ZodRawShape): unknown => {
      try {
        return z.toJSONSchema(z.object(shape));
      } catch (err) {
        logger.warn("console_mcp_tools_schema_conversion_failed", {
          error: String(err),
        });
        return {};
      }
    };

    const tools: ToolInfo[] = handlers.map((h) => {
      const summary: ToolInfo = {
        name: h.name,
        ...(h.title !== undefined ? { title: h.title } : {}),
        description: h.description,
        inputSchema: safeToJsonSchema(h.inputSchema),
        outputSchema: safeToJsonSchema(h.outputSchema),
      };
      return summary;
    });
    // Stable sort by name for deterministic operator reading order
    // — handlers are registered in module-import order, which is
    // arbitrary from the operator's perspective.
    tools.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ tools, total: tools.length });
  });
}
