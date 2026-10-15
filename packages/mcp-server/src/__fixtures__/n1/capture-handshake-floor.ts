/**
 * Captures the first OPEN release's `ggui_handshake` (ggui#1333) into two
 * fixtures beside it: the advertised `outputSchema`
 * (`handshake.output-schema.open-floor.json`) and one real result
 * (`handshake.result.open-floor.json`). Together they are the N−1 floor the
 * next additive output field rests on — `output-schema-open.wire.test.ts`
 * checks two ACCEPTANCES, never equality: the floor schema accepts a newer
 * payload, and the served schema accepts the floor payload. Run from the
 * package dir: `tsx src/__fixtures__/n1/capture-handshake-floor.ts`.
 * Re-capture ONLY when the pairing of record moves (VERSION-POLICY §3.6);
 * an additive handshake field inside the pairing leaves both files as they
 * are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryKeyValueStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiHandshakeHandler,
  type HandlerContext,
  type HandshakeNegotiator,
} from '@ggui-ai/mcp-server-handlers';
import { buildMcpServer } from '../../build-mcp.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return silentLogger;
  },
};
const ctx: HandlerContext = { appId: 'app-1', requestId: 'r-capture' };
const negotiator: HandshakeNegotiator = {
  decide: () => ({
    action: 'reuse',
    reason: 'capture',
    suggestion: {
      origin: 'cache',
      rationale: 'capture',
      blueprintMeta: { blueprintId: 'bp_capture', contractHash: 'hash_capture', variance: {} },
    },
    effectiveContract: {},
  }),
};
const handler = createGguiHandshakeHandler({ kvStore: new InMemoryKeyValueStore(), negotiator });
const server = buildMcpServer({ name: 'capture', version: '0' }, [handler], () => ctx, silentLogger);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'capture', version: '0' });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const { tools } = await client.listTools();
const tool = tools.find((t) => t.name === 'ggui_handshake');
if (tool?.outputSchema === undefined) throw new Error('ggui_handshake advertises no outputSchema');
// One real result of the floor release — the previous release's PAYLOAD the
// N−1 rule pins against today's validator.
const result = await client.callTool({
  name: 'ggui_handshake',
  arguments: { intent: 'A weekly availability grid', blueprintDraft: { contract: {} } },
});
if (result.isError === true || result.structuredContent === undefined) {
  throw new Error('ggui_handshake did not answer with structuredContent');
}
const dir = path.dirname(fileURLToPath(import.meta.url));
const capturedBy = 'src/__fixtures__/n1/capture-handshake-floor.ts (ggui#1333, the first open release)';
const schemaOut = path.join(dir, 'handshake.output-schema.open-floor.json');
const resultOut = path.join(dir, 'handshake.result.open-floor.json');
fs.writeFileSync(
  schemaOut,
  `${JSON.stringify({ tool: 'ggui_handshake', capturedBy, outputSchema: tool.outputSchema }, null, 2)}\n`,
);
fs.writeFileSync(
  resultOut,
  `${JSON.stringify({ tool: 'ggui_handshake', capturedBy, structuredContent: result.structuredContent }, null, 2)}\n`,
);
await client.close();
await server.close();
process.stdout.write(`wrote ${schemaOut}\nwrote ${resultOut}\n`);
