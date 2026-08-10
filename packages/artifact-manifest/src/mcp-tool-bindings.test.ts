import { describe, expect, expectTypeOf, it } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import type { BlueprintManifest } from "./blueprint-manifest.js";
import type { GadgetManifest } from "./gadget-manifest.js";
import {
  MCP_TOOL_BINDING_NAME_RE,
  mcpToolBindingSchema,
  mcpToolsSchema,
  resolveMcpToolBindings,
  type McpToolBinding,
} from "./mcp-tool-bindings.js";

describe("MCP_TOOL_BINDING_NAME_RE", () => {
  it("accepts MCP-style tool and server names", () => {
    for (const name of ["get_weather", "weather.v2", "Get-Weather_2", "a", "A".repeat(128)]) {
      expect(MCP_TOOL_BINDING_NAME_RE.test(name)).toBe(true);
    }
  });

  it("rejects empty, over-long, and out-of-charset names", () => {
    for (const name of ["", "A".repeat(129), "has space", "slash/name", "colon:name", "tool☃"]) {
      expect(MCP_TOOL_BINDING_NAME_RE.test(name)).toBe(false);
    }
  });
});

describe("mcpToolBindingSchema", () => {
  it("parses a bare tool binding", () => {
    expect(mcpToolBindingSchema.safeParse({ tool: "get_weather" }).success).toBe(true);
  });

  it("parses a (server, tool) binding", () => {
    expect(
      mcpToolBindingSchema.safeParse({
        server: "weather-server",
        tool: "get_weather",
      }).success
    ).toBe(true);
  });

  it("rejects a missing tool with issue path `tool`", () => {
    const result = mcpToolBindingSchema.safeParse({
      server: "weather-server",
    });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("tool");
  });

  it("rejects unknown keys (strict object)", () => {
    expect(
      mcpToolBindingSchema.safeParse({
        tool: "get_weather",
        endorsement: true,
      }).success
    ).toBe(false);
  });
});

describe("mcpToolsSchema", () => {
  it("rejects an empty array", () => {
    expect(mcpToolsSchema.safeParse([]).success).toBe(false);
  });

  it("rejects 17 entries", () => {
    const seventeen = Array.from({ length: 17 }, (_, i) => ({
      tool: `tool-${i}`,
    }));
    expect(mcpToolsSchema.safeParse(seventeen).success).toBe(false);
  });

  it("accepts 16 distinct entries", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ({
      tool: `tool-${i}`,
    }));
    expect(mcpToolsSchema.safeParse(sixteen).success).toBe(true);
  });

  it("rejects exact duplicate (server, tool) pairs with issue path on the array", () => {
    const result = mcpToolsSchema.safeParse([
      { server: "weather-server", tool: "get_weather" },
      { server: "weather-server", tool: "get_weather" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects exact duplicate bare pairs", () => {
    expect(
      mcpToolsSchema.safeParse([{ tool: "get_weather" }, { tool: "get_weather" }]).success
    ).toBe(false);
  });

  it("accepts the same tool on two servers, plus a bare entry (no exact dup)", () => {
    expect(
      mcpToolsSchema.safeParse([
        { server: "server-a", tool: "get_weather" },
        { server: "server-b", tool: "get_weather" },
        { tool: "get_weather" },
      ]).success
    ).toBe(true);
  });

  it("is case-sensitive — `Get_Weather` and `get_weather` are distinct", () => {
    expect(
      mcpToolsSchema.safeParse([{ tool: "Get_Weather" }, { tool: "get_weather" }]).success
    ).toBe(true);
  });

  it("reports charset violations at the entry path (`0.tool`)", () => {
    const result = mcpToolsSchema.safeParse([{ tool: "has space" }]);
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("0.tool");
  });

  it("McpToolBinding infers { server?: string; tool: string }", () => {
    expectTypeOf<McpToolBinding>().toEqualTypeOf<{
      server?: string;
      tool: string;
    }>();
  });
});

describe("resolveMcpToolBindings", () => {
  const GADGET_BASE: GadgetManifest = {
    kind: "gadget",
    scope: "@my-org",
    name: "weather-card",
    version: "0.1.0",
    bundle: "src/index.ts",
    visibility: "public",
    description: "Renders a weather card.",
    exports: [
      {
        hook: "useWeatherCard",
        description: "Renders a weather card.",
        usage: "Use to display current weather conditions.",
        example: { city: "Berlin" },
      },
    ],
  };

  const BLUEPRINT_BASE: BlueprintManifest = {
    kind: "blueprint",
    scope: "@my-org",
    name: "weather-card",
    version: "0.1.0",
    visibility: "public",
    source: "export default function Card() { return null; }",
  };

  const CONTRACT: DataContract = {
    propsSpec: {
      properties: {
        current: { schema: { type: "object" }, sourceTool: "get_weather" },
        forecast: { schema: { type: "object" }, sourceTool: "get_forecast" },
        city: { schema: { type: "string" } },
      },
    },
    streamSpec: {
      alerts: { schema: { type: "object" }, source: { tool: "stream_alerts" } },
      refresh: { schema: { type: "object" }, source: { tool: "get_weather" } },
      local: { schema: { type: "object" } },
    },
  };

  it("declared wins entirely — derivation does not run when mcpTools is present", () => {
    const resolved = resolveMcpToolBindings({
      ...BLUEPRINT_BASE,
      contract: CONTRACT,
      mcpTools: [{ server: "weather-server", tool: "render_weather" }],
    });
    expect(resolved).toEqual({
      source: "declared",
      bindings: [{ server: "weather-server", tool: "render_weather" }],
    });
  });

  it("derives the deduped union of propsSpec sourceTool + streamSpec source.tool as bare entries", () => {
    const resolved = resolveMcpToolBindings({
      ...BLUEPRINT_BASE,
      contract: CONTRACT,
    });
    expect(resolved).toEqual({
      source: "derived",
      bindings: [{ tool: "get_weather" }, { tool: "get_forecast" }, { tool: "stream_alerts" }],
    });
  });

  it("returns undefined for a blueprint whose contract names no tools", () => {
    expect(
      resolveMcpToolBindings({
        ...BLUEPRINT_BASE,
        contract: {
          propsSpec: { properties: { city: { schema: { type: "string" } } } },
        },
      })
    ).toBeUndefined();
  });

  it("returns undefined for a contract-less blueprint without mcpTools", () => {
    expect(resolveMcpToolBindings(BLUEPRINT_BASE)).toBeUndefined();
  });

  it("never derives for gadgets — undefined without mcpTools", () => {
    expect(resolveMcpToolBindings(GADGET_BASE)).toBeUndefined();
  });

  it("returns declared bindings for a gadget that declares them", () => {
    const resolved = resolveMcpToolBindings({
      ...GADGET_BASE,
      mcpTools: [{ tool: "get_weather" }],
    });
    expect(resolved).toEqual({
      source: "declared",
      bindings: [{ tool: "get_weather" }],
    });
  });

  it("derivation filters charset-invalid lineage names silently rather than rejecting", () => {
    const resolved = resolveMcpToolBindings({
      ...BLUEPRINT_BASE,
      contract: {
        propsSpec: {
          properties: {
            empty: { schema: { type: "object" }, sourceTool: "" },
            invalidChars: { schema: { type: "object" }, sourceTool: "has space" },
            customer: { schema: { type: "object" }, sourceTool: "get_customer" },
          },
        },
        streamSpec: {
          badChannel: { schema: { type: "object" }, source: { tool: "bad/tool" } },
          invoiceEvents: { schema: { type: "object" }, source: { tool: "watch_invoices" } },
        },
      },
    });
    expect(resolved).toEqual({
      source: "derived",
      bindings: [{ tool: "get_customer" }, { tool: "watch_invoices" }],
    });
  });

  it("derivation caps at 16 entries in first-appearance order, same bound as a declared list", () => {
    const properties: Record<string, { schema: { type: "object" }; sourceTool: string }> = {};
    for (let i = 1; i <= 17; i++) {
      properties[`p${i}`] = {
        schema: { type: "object" },
        sourceTool: `tool_${String(i).padStart(2, "0")}`,
      };
    }
    const resolved = resolveMcpToolBindings({
      ...BLUEPRINT_BASE,
      contract: { propsSpec: { properties } },
    });
    expect(resolved?.source).toBe("derived");
    expect(resolved?.bindings.length).toBe(16);
    expect(resolved?.bindings).toEqual(
      Array.from({ length: 16 }, (_, i) => ({
        tool: `tool_${String(i + 1).padStart(2, "0")}`,
      }))
    );
  });

  it("manifest mcpTools field infers ReadonlyArray<McpToolBinding> | undefined on both kinds", () => {
    expectTypeOf<GadgetManifest["mcpTools"]>().toEqualTypeOf<
      ReadonlyArray<McpToolBinding> | undefined
    >();
    expectTypeOf<BlueprintManifest["mcpTools"]>().toEqualTypeOf<
      ReadonlyArray<McpToolBinding> | undefined
    >();
  });
});
