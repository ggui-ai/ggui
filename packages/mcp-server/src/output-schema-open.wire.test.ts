/**
 * An advertised output object MUST NOT be closed (ggui#1333).
 *
 * The SDK projects each tool's registered output object into `tools/list`
 * in zod's OUTPUT mode, which closes every object (`additionalProperties:
 * false`) whether or not the zod object is strict; a TS-SDK host caches that
 * document and refuses a result that carries a member it does not name
 * ("Structured content does not match the tool's output schema"). So an
 * optional output field added in release N — MINOR by VERSION-POLICY §1.2 —
 * failed every host that listed tools against N−1, and the only way to add
 * one was to declare it one release before emitting it (ggui#1336).
 *
 * The fix decouples the ADVERTISED document from the PARSE: what the server
 * registers for `tools/list` is an OPEN derivation of the handler's output
 * shape (every object node loose, the top level included); what the server
 * validates a payload with is the handler's own shape, unchanged, so an
 * undeclared member is still stripped before the wire. Two things are pinned
 * here, on the wire through a real SDK client:
 *
 *   1. no `additionalProperties: false` anywhere under any advertised
 *      `outputSchema` — nested objects, array items, union arms, optional and
 *      nullable members, record values, and the top level;
 *   2. the strip gate still holds — a handler that returns a member its
 *      shape does not name sends a payload WITHOUT it, and the client's own
 *      validation (against the advertised schema) accepts the result.
 *
 * Both registration paths are covered: a plain tool (`registerTool`) and a
 * UI tool (`registerAppTool`, the ext-apps door), since the two type their
 * `outputSchema` differently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { InMemoryKeyValueStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiHandshakeHandler,
  type HandlerContext,
  type HandshakeNegotiator,
  type SharedHandler,
} from '@ggui-ai/mcp-server-handlers';
import { describe, expect, it } from 'vitest';
import { z, type ZodRawShape } from 'zod';
import { buildMcpServer } from './build-mcp.js';

/** The JSON Schema document the SDK's validator takes — the same type the client validates results with. */
type JsonSchemaType = Parameters<AjvJsonSchemaValidator['getValidator']>[0];

/**
 * The first open release's served `ggui_handshake` outputSchema and one real
 * result of that release (both captured by
 * `__fixtures__/n1/capture-handshake-floor.ts`). FROZEN until the pairing of
 * record moves (VERSION-POLICY §3.6): the N−1 obligation is two acceptances,
 * never equality — the floor schema accepts a newer payload, and the served
 * schema accepts the floor payload — so an additive handshake field inside
 * the pairing turns nothing here red.
 */
const HANDSHAKE_FLOOR_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/n1/handshake.output-schema.open-floor.json',
);
const HANDSHAKE_FLOOR_RESULT_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/n1/handshake.result.open-floor.json',
);

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return silentLogger;
  },
};

const ctx: HandlerContext = { appId: 'app-1', requestId: 'r-open-output' };

async function connect(handlers: SharedHandler<ZodRawShape, ZodRawShape>[]) {
  const server = buildMcpServer({ name: 'open-output', version: '0' }, handlers, () => ctx, silentLogger, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'open-output-test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Every `additionalProperties: false` under a JSON Schema document, by path. */
function closedObjectsIn(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => closedObjectsIn(item, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' && value === false) out.push(path);
    out.push(...closedObjectsIn(value, `${path}.${key}`));
  }
  return out;
}

/**
 * Whether an `additionalProperties` value is the open/closed MARKER (`false`,
 * `true`, `{}`) rather than a schema. A `z.record`'s VALUE schema is also
 * projected under `additionalProperties`, and that subtree must stay in the
 * comparison — stripping every `additionalProperties` key would discard a
 * record's value schema on both sides and hide a derivation that mangled it.
 */
function isOpenClosedMarker(value: unknown): boolean {
  if (typeof value === 'boolean') return true;
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * The same document with every open/closed MARKER removed (an
 * `additionalProperties` whose value is `false`, `true` or `{}`), at every
 * depth — record value schemas kept — and without the top-level `$schema`
 * envelope key, the one key zod's own `toJSONSchema` writes and the SDK's
 * `tools/list` document does not carry.
 */
function withoutAdditionalProperties(node: unknown, top = true): unknown {
  if (Array.isArray(node)) return node.map((item) => withoutAdditionalProperties(item, false));
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(
        ([key, value]) =>
          !(key === 'additionalProperties' && isOpenClosedMarker(value)) && !(top && key === '$schema'),
      )
      .map(([key, value]) => [key, withoutAdditionalProperties(value, false)]),
  );
}

/** The shape under test: an object at every depth the handlers' outputs use. */
const nestedShape = {
  top: z.string(),
  nested: z.object({ a: z.number(), deeper: z.object({ b: z.boolean() }) }),
  list: z.array(z.object({ item: z.string() })),
  arm: z.union([z.object({ kind: z.literal('x'), x: z.number() }), z.object({ kind: z.literal('y'), y: z.string() })]),
  maybe: z.object({ c: z.string() }).optional(),
  orNull: z.object({ d: z.string() }).nullable(),
  byKey: z.record(z.string(), z.object({ e: z.number() })),
};

const plainTool: SharedHandler<ZodRawShape, ZodRawShape> = {
  name: 'open_probe_plain',
  description: 'open output probe (registerTool path)',
  audience: ['ops'],
  inputSchema: { x: z.string() },
  outputSchema: nestedShape,
  async handler() {
    return {
      top: 't',
      nested: { a: 1, deeper: { b: true } },
      list: [{ item: 'i' }],
      arm: { kind: 'x', x: 2 },
      orNull: null,
      byKey: { k: { e: 3 } },
      memberThisReleaseDoesNotName: 'must be stripped',
    };
  },
};

const uiTool: SharedHandler<ZodRawShape, ZodRawShape> = {
  name: 'open_probe_ui',
  description: 'open output probe (registerAppTool path)',
  audience: ['agent'],
  inputSchema: { x: z.string() },
  outputSchema: nestedShape,
  _meta: { ui: { visibility: ['model'] } },
  async handler() {
    return {
      top: 't',
      nested: { a: 1, deeper: { b: true } },
      list: [],
      arm: { kind: 'y', y: 'why' },
      orNull: { d: 'd' },
      byKey: {},
    };
  },
};

describe('an advertised output object is never closed (ggui#1333)', () => {
  it('tools/list carries no additionalProperties:false under any outputSchema, on both registration paths', async () => {
    const { client, close } = await connect([plainTool, uiTool]);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const name of ['open_probe_plain', 'open_probe_ui']) {
        const schema = byName.get(name)?.outputSchema;
        expect(schema, name).toBeDefined();
        expect(closedObjectsIn(schema), name).toEqual([]);
      }
      // Control — the walker sees a closed object when one is there.
      expect(closedObjectsIn({ type: 'object', additionalProperties: false })).toEqual(['$']);
    } finally {
      await close();
    }
  });

  it('nothing else moved: the advertised document equals the output-mode projection of the handler shape at every node except additionalProperties', async () => {
    const { client, close } = await connect([plainTool]);
    try {
      const { tools } = await client.listTools();
      const advertised = tools.find((t) => t.name === 'open_probe_plain')?.outputSchema;
      const original = z.toJSONSchema(z.object(nestedShape), { io: 'output' });
      // Control — the two documents DO differ before the one key is set aside.
      expect(advertised).not.toEqual(original);
      const compared = withoutAdditionalProperties(advertised);
      // Control — the record's VALUE schema (projected under additionalProperties) is still in the comparison.
      expect(JSON.stringify(compared)).toContain('"byKey"');
      expect(JSON.stringify(compared)).toContain('"e":{"type":"number"}'); // only the record's value schema names `e`
      expect(compared).toEqual(withoutAdditionalProperties(original));
    } finally {
      await close();
    }
  });

  it('the floor for the next additive field: the served schema, validated as the SDK client validates, accepts a payload with one added member; the closed form of the same schema refuses it (control)', async () => {
    const { client, close } = await connect([plainTool]);
    try {
      const { tools } = await client.listTools();
      const served = tools.find((t) => t.name === 'open_probe_plain')?.outputSchema;
      if (served === undefined) throw new Error('open_probe_plain advertises no outputSchema');
      const laterRelease = {
        top: 't',
        nested: { a: 1, deeper: { b: true, addedLater: 'deep' } },
        list: [{ item: 'i', addedLater: 1 }],
        arm: { kind: 'x', x: 2, addedLater: true },
        orNull: null,
        byKey: { k: { e: 3, addedLater: [] } },
        addedLater: 'top',
      };
      const validator = new AjvJsonSchemaValidator();
      expect(validator.getValidator(served)(laterRelease).valid).toBe(true);
      // Control: the same document closed again — what every release before this one advertised — refuses it.
      const closedAgain: JsonSchemaType = JSON.parse(
        JSON.stringify(served, (key, value) => (key === 'additionalProperties' ? false : value)),
      );
      expect(closedObjectsIn(closedAgain)).not.toEqual([]);
      expect(validator.getValidator(closedAgain)(laterRelease).valid).toBe(false);
    } finally {
      await close();
    }
  });

  it('N−1 on the floor (ggui_handshake): the first open release\'s schema accepts a real result of this release with one added member, and this release\'s served schema accepts the floor release\'s result', async () => {
    const floor = JSON.parse(fs.readFileSync(HANDSHAKE_FLOOR_FIXTURE, 'utf8')) as {
      readonly tool: string;
      readonly outputSchema: JsonSchemaType;
    };
    const floorResult = JSON.parse(fs.readFileSync(HANDSHAKE_FLOOR_RESULT_FIXTURE, 'utf8')) as {
      readonly tool: string;
      readonly structuredContent: unknown;
    };
    expect(floor.tool).toBe('ggui_handshake');
    expect(floorResult.tool).toBe('ggui_handshake');
    expect(closedObjectsIn(floor.outputSchema)).toEqual([]);
    const negotiator: HandshakeNegotiator = {
      decide: () => ({
        action: 'reuse',
        reason: 'floor',
        suggestion: {
          origin: 'cache',
          rationale: 'floor',
          blueprintMeta: { blueprintId: 'bp_floor', contractHash: 'hash_floor', variance: {} },
        },
        effectiveContract: {},
      }),
    };
    const handshake = createGguiHandshakeHandler({ kvStore: new InMemoryKeyValueStore(), negotiator });
    const { client, close } = await connect([handshake]);
    try {
      const { tools } = await client.listTools();
      const served = tools.find((t) => t.name === 'ggui_handshake')?.outputSchema;
      if (served === undefined) throw new Error('ggui_handshake advertises no outputSchema');
      expect(closedObjectsIn(served)).toEqual([]);
      const result = await client.callTool({
        name: 'ggui_handshake',
        arguments: { intent: 'A weekly availability grid', blueprintDraft: { contract: {} } },
      });
      expect(result.isError).toBeFalsy();
      const validator = new AjvJsonSchemaValidator();
      // (a) A host holding the FLOOR schema accepts this release's result, plus a member the floor never named.
      const laterRelease = { ...(result.structuredContent ?? {}), addedLater: 'a member the floor does not name' };
      expect(validator.getValidator(floor.outputSchema)(laterRelease).valid).toBe(true);
      // (b) This release's SERVED schema accepts the floor release's result — the previous release's payload
      // against today's validator, the fixture the N−1 rule names.
      expect(validator.getValidator(served)(floorResult.structuredContent).valid).toBe(true);
      // Control — the floor schema re-closed refuses the added member.
      const floorClosed: JsonSchemaType = JSON.parse(
        JSON.stringify(floor.outputSchema, (key, value) => (key === 'additionalProperties' && isOpenClosedMarker(value) ? false : value)),
      );
      expect(validator.getValidator(floorClosed)(laterRelease).valid).toBe(false);
    } finally {
      await close();
    }
  });

  it('the strip gate still holds: a member the shape does not name never reaches the wire, and the client accepts the result', async () => {
    const { client, close } = await connect([plainTool]);
    try {
      const result = await client.callTool({ name: 'open_probe_plain', arguments: { x: 'a' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        top: 't',
        nested: { a: 1, deeper: { b: true } },
        list: [{ item: 'i' }],
        arm: { kind: 'x', x: 2 },
        orNull: null,
        byKey: { k: { e: 3 } },
      });
      expect(result.structuredContent).not.toHaveProperty('memberThisReleaseDoesNotName');
    } finally {
      await close();
    }
  });
});
