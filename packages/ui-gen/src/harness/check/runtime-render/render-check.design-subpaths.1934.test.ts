// ggui#1934 — the render-check sandbox refused `@ggui-ai/design/tokens` while production serves it: the
// sandbox pre-resolved a hand-kept list of five design specifiers, and the package's ESM-only exports
// leave the `require` fallback unable to load any other. A card importing tokens failed `render-no-throw`
// on a probe while it rendered when served. The list is now the renderer's own served-specifier map.
import { describe, expect, it } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import { ASSET_SHIM_FOR_SPECIFIER } from "@ggui-ai/design/rendering";
import { runRenderCheck, sandboxDesignModules } from "./render-check.js";

const contract: DataContract = {
  propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
};

const cardImporting = (specifier: string, name: string): string => `
import { Text } from '@ggui-ai/design';
import { ${name} } from '${specifier}';

interface Props { title: string }

export default function Component(props: Props) {
  void ${name};
  return <Text>{props.title}</Text>;
}
`;

const served = Object.keys(ASSET_SHIM_FOR_SPECIFIER).filter((id) => id === "@ggui-ai/design" || id.startsWith("@ggui-ai/design/"));

describe("the render-check sandbox serves every design specifier production serves (ggui#1934)", () => {
  it("covers the served map, less the operator's app-components registry", () => {
    const covered = sandboxDesignModules().map(([id]) => id);
    expect(covered).toContain("@ggui-ai/design/tokens");
    expect([...covered, "@ggui-ai/design/app-components"].sort()).toEqual([...served].sort());
  });

  it.each(sandboxDesignModules().map(([id, moduleId]) => [id, moduleId]))(
    "a card importing from %s loads and renders",
    async (id, moduleId) => {
      const mod: object = await import(moduleId);
      const name = Object.keys(mod).find((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default" && k !== "Text");
      expect(name, `${moduleId} exports a name`).toBeDefined();
      const result = await runRenderCheck({ sourceCode: cardImporting(id, name ?? ""), mockupProps: { title: "Hello" }, contract });
      const failures = result.issues.filter((i) => i.outcome === "failed");
      expect(failures, JSON.stringify(failures)).toHaveLength(0);
    },
    30000,
  );

  it("a card importing tokens' animation preset renders (the stock-ticker cell's import)", async () => {
    const result = await runRenderCheck({ sourceCode: cardImporting("@ggui-ai/design/tokens", "animation"), mockupProps: { title: "Hello" }, contract });
    expect(result.issues.filter((i) => i.outcome === "failed")).toEqual([]);
  }, 30000);
});
