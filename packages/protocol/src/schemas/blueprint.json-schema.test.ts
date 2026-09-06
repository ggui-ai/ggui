import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { blueprintSourceSchema, llmBlueprintSourceSchema } from './blueprint';
import { blueprintMetaSchema } from './handshake-suggestion';
import { blueprintEntryWireSchema } from './mcp';

/**
 * ggui#924 — `blueprintSourceSchema` is embedded in tool-reachable input
 * schemas, which every MCP server renders to JSON Schema for `tools/list`.
 * A schema node with no JSON-Schema form (`z.custom`) makes that call
 * fail for every self-hoster, so the provenance arm must render — with the
 * de-modeled grammar visible as a `pattern` — and the embedders with it.
 */
describe('blueprint provenance schemas render to JSON Schema (tools/list)', () => {
  it('llmBlueprintSourceSchema renders, with the identity grammar and the ref prefixes as patterns', () => {
    const json = z.toJSONSchema(llmBlueprintSourceSchema);
    const props = json['properties'] as Record<string, { pattern?: string; type?: string }>;
    expect(props['generator']?.type).toBe('string');
    expect(props['generator']?.pattern).toMatch(/ui-gen-/);
    expect(props['model']?.type).toBe('string');
    expect(props['model']?.pattern).toMatch(/anthropic\|gemini\|openai\|bedrock\|openrouter/);
  });

  it('blueprintSourceSchema (the union) renders', () => {
    expect(() => z.toJSONSchema(blueprintSourceSchema)).not.toThrow();
  });

  it('every embedder of the union renders', () => {
    expect(() => z.toJSONSchema(blueprintEntryWireSchema)).not.toThrow();
    expect(() => z.toJSONSchema(blueprintMetaSchema)).not.toThrow();
  });
});
