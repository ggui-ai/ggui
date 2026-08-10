/**
 * Drift-pin: `@ggui-ai/protocol`'s `searchBlueprintsInputShape.tool` /
 * `.server` inline the SAME charset as {@link MCP_TOOL_BINDING_NAME_RE}
 * (`oss/packages/protocol/src/schemas/mcp.ts:136,143`). The inlining
 * is intentional — protocol cannot import artifact-manifest, the
 * dependency points the other way — so this is the drift catch on
 * the artifact-manifest side, the higher-level package, which CAN
 * import protocol.
 *
 * Two independent proofs, so a drift that only shows up in one form
 * still fails the build:
 *   1. Structural — the actual `RegExp` each Zod schema was built
 *      with, extracted via Zod v4's `$ZodCheckRegex` check node,
 *      compared by `.source` + `.flags`.
 *   2. Behavioral — a probe set of valid/invalid names fed through
 *      both the standalone regex and the live protocol schemas.
 */
import { z } from "zod";
import { searchBlueprintsInputShape } from "@ggui-ai/protocol";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_BINDING_NAME_RE } from "./mcp-tool-bindings.js";

/** Extract the `RegExp` a `.regex(...)` check was built with, if any. */
function extractRegexCheck(schema: z.ZodString): RegExp | undefined {
  for (const check of schema.def.checks ?? []) {
    if (check instanceof z.core.$ZodCheckRegex) {
      return check._zod.def.pattern;
    }
  }
  return undefined;
}

/**
 * `searchBlueprintsInputShape.tool` / `.server` are both
 * `z.string().regex(...).optional()` — a known concrete shape, so no
 * generic unwrap is needed.
 */
function regexOf(schema: z.ZodOptional<z.ZodString>): RegExp {
  const pattern = extractRegexCheck(schema.def.innerType);
  if (pattern === undefined) {
    throw new Error("expected a .regex(...) check on the schema");
  }
  return pattern;
}

const PROBE_NAMES = [
  "",
  "a",
  "get_weather",
  "weather.v2",
  "Get-Weather_2",
  "A".repeat(128),
  "A".repeat(129),
  "has space",
  "slash/name",
  "colon:name",
  "tool☃",
];

describe("searchBlueprintsInputShape tool/server regexes stay pinned to MCP_TOOL_BINDING_NAME_RE", () => {
  it("tool: .source and .flags are identical to MCP_TOOL_BINDING_NAME_RE", () => {
    const toolRegex = regexOf(searchBlueprintsInputShape.tool);
    expect(toolRegex.source).toBe(MCP_TOOL_BINDING_NAME_RE.source);
    expect(toolRegex.flags).toBe(MCP_TOOL_BINDING_NAME_RE.flags);
  });

  it("server: .source and .flags are identical to MCP_TOOL_BINDING_NAME_RE", () => {
    const serverRegex = regexOf(searchBlueprintsInputShape.server);
    expect(serverRegex.source).toBe(MCP_TOOL_BINDING_NAME_RE.source);
    expect(serverRegex.flags).toBe(MCP_TOOL_BINDING_NAME_RE.flags);
  });

  it("tool: the live protocol schema agrees with MCP_TOOL_BINDING_NAME_RE on every probe name", () => {
    const toolSchema = z.object({ tool: searchBlueprintsInputShape.tool });
    for (const name of PROBE_NAMES) {
      const expected = MCP_TOOL_BINDING_NAME_RE.test(name);
      const actual = toolSchema.safeParse({ tool: name }).success;
      expect(actual, `tool=${JSON.stringify(name)}`).toBe(expected);
    }
  });

  it("server: the live protocol schema agrees with MCP_TOOL_BINDING_NAME_RE on every probe name", () => {
    const serverSchema = z.object({ server: searchBlueprintsInputShape.server });
    for (const name of PROBE_NAMES) {
      const expected = MCP_TOOL_BINDING_NAME_RE.test(name);
      const actual = serverSchema.safeParse({ server: name }).success;
      expect(actual, `server=${JSON.stringify(name)}`).toBe(expected);
    }
  });
});
