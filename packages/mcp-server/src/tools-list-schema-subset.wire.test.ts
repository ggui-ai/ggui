/**
 * ggui#1637 — every input schema this server serves on `tools/list` stays inside the JSON Schema subset the major
 * model APIs accept as function parameters. Google's `generateContent` refuses a schema with a definition that reaches
 * itself through required members only ("ref loops are only supported if they include optional or nullable property
 * values, or a potentially-zero-length array items"), and a host that forwards `tools/list` verbatim would then fail
 * every request before generation. A loop through an optional property or an array's `items` is accepted. So is a loop
 * that is not a loop, and only that is pinned here. Measured against Google's API (#1637): the JSON-value definition's
 * object arm (`additionalProperties` back to itself) was the one refused loop, and neither a `{type: null}` alternative
 * nor an OpenAPI `nullable` flag made Google accept it. This test cannot call Google; it reads the served schemas and
 * applies the rule, so the class cannot return with the next recursive definition.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return silentLogger;
  },
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (v: Json | undefined): v is { [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Edge {
  readonly from: string;
  readonly to: string;
  /** True when the path to the `$ref` passes through an optional property or an array's `items`. */
  readonly safe: boolean;
  readonly at: string;
}

/** Every `$ref` to a definition, from each definition, with whether its path passes through a member that may be absent. */
function definitionEdges(schema: Json): readonly Edge[] {
  if (!isObject(schema)) return [];
  const defs = isObject(schema['definitions']) ? schema['definitions'] : isObject(schema['$defs']) ? schema['$defs'] : {};
  const edges: Edge[] = [];
  const walk = (from: string, node: Json, safe: boolean, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(from, n, safe, `${at}/${i}`));
      return;
    }
    if (!isObject(node)) return;
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      const m = /^#\/(?:definitions|\$defs)\/(.+)$/.exec(ref);
      if (m?.[1] !== undefined) edges.push({ from, to: m[1], safe, at });
    }
    const required = Array.isArray(node['required']) ? node['required'].filter((r): r is string => typeof r === 'string') : [];
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' || key === 'definitions' || key === '$defs') continue;
      if (key === 'properties' && isObject(value)) {
        for (const [prop, sub] of Object.entries(value)) walk(from, sub, safe || !required.includes(prop), `${at}/properties/${prop}`);
      } else if (key === 'items') {
        walk(from, value, true, `${at}/items`);
      } else {
        walk(from, value, safe, `${at}/${key}`);
      }
    }
  };
  for (const [name, def] of Object.entries(defs)) walk(name, def, false, `definitions/${name}`);
  return edges;
}

/** A cycle among definitions made only of edges through required members, or null. */
function requiredOnlyLoop(schema: Json): readonly Edge[] | null {
  const out = new Map<string, Edge[]>();
  for (const e of definitionEdges(schema)) if (!e.safe) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const onPath = new Map<string, number>();
  const done = new Set<string>();
  const path: Edge[] = [];
  const dfs = (node: string): readonly Edge[] | null => {
    onPath.set(node, path.length);
    for (const e of out.get(node) ?? []) {
      const back = onPath.get(e.to);
      if (back !== undefined) return [...path.slice(back), e];
      if (done.has(e.to)) continue;
      path.push(e);
      const found = dfs(e.to);
      if (found) return found;
      path.pop();
    }
    onPath.delete(node);
    done.add(node);
    return null;
  };
  for (const node of out.keys()) {
    if (done.has(node)) continue;
    const found = dfs(node);
    if (found) return found;
  }
  return null;
}

describe('the rule itself, on hand-made schemas (ggui#1637)', () => {
  it('flags a definition that reaches itself through an object arm, the served shape Google refused', () => {
    const refused: Json = {
      type: 'object',
      properties: { v: { $ref: '#/definitions/j' } },
      required: ['v'],
      definitions: { j: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: { $ref: '#/definitions/j' } }] } },
    };
    expect(requiredOnlyLoop(refused)?.map((e) => e.at)).toEqual(['definitions/j/anyOf/1/additionalProperties']);
    // Google refused this form too: a null alternative does not make the loop optional.
    const nullAlt: Json = { definitions: { j: { anyOf: [{ type: 'object', additionalProperties: { anyOf: [{ $ref: '#/definitions/j' }, { type: 'null' }] } }] } } };
    expect(requiredOnlyLoop(nullAlt)).not.toBeNull();
  });

  it('accepts a loop through array items or an optional property, and the object arm with open values', () => {
    const arrays: Json = { definitions: { j: { anyOf: [{ type: 'array', items: { $ref: '#/definitions/j' } }] } } };
    const optional: Json = { definitions: { s: { type: 'object', properties: { properties: { type: 'object', additionalProperties: { $ref: '#/definitions/s' } } } } } };
    const open: Json = { definitions: { j: { anyOf: [{ type: 'array', items: { $ref: '#/definitions/j' } }, { type: 'object', additionalProperties: {} }] } } };
    expect(requiredOnlyLoop(arrays)).toBeNull();
    expect(requiredOnlyLoop(optional)).toBeNull();
    expect(requiredOnlyLoop(open)).toBeNull();
  });
});

describe('every served input schema is inside the model-API subset (ggui#1637)', () => {
  let server: GguiServer;
  let client: Client;
  let tools: ReadonlyArray<{ readonly name: string; readonly inputSchema: Json }> = [];

  beforeAll(async () => {
    // The full data-plane surface a real agent's `tools/list` sees: the render family needs `mcpApps`, emit needs
    // `renderChannel`, and the runtime tools ride the same route.
    server = createGguiServer({
      logger: silentLogger,
      renderChannel: true,
      mcpApps: { wsUrl: 'ws://localhost/ws' },
      wsTokenSecret: 'test-secret-for-schema-subset',
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('server.address() did not return AddressInfo');
    client = new Client({ name: 'schema-subset', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
        requestInit: { headers: { authorization: 'Bearer t' } },
      }),
    );
    const listed = await client.listTools();
    tools = listed.tools.map((t) => ({ name: t.name, inputSchema: JSON.parse(JSON.stringify(t.inputSchema)) as Json }));
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('serves the tools whose schemas carry the recursive JSON value, so the check below is not empty', () => {
    const names = tools.map((t) => t.name);
    for (const name of ['ggui_handshake', 'ggui_render', 'ggui_runtime_sync_context']) expect(names).toContain(name);
  });

  it('no served input schema has a definition that reaches itself through required members only', () => {
    const offenders = tools.flatMap((t) => {
      const loop = requiredOnlyLoop(t.inputSchema);
      return loop ? [`${t.name}: ${loop.map((e) => e.at).join(' -> ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });
});
