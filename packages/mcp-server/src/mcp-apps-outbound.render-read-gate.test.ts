/**
 * Handler-level byte-identity coverage for the render-resource read
 * gate (render-read-gate.ts, wired into `registerGguiRenderResourceTemplate`
 * — see docs/superpowers/specs/2026-08-07-rehydration-access-control-design.md §3).
 *
 * `render-read-gate.test.ts` pins `renderReadAllowed`'s allow/deny
 * decision in isolation. This file pins the OUTER contract the gate
 * exists to serve: a caller who reads a sessionId they cannot access
 * (denied) must receive a response BYTE-IDENTICAL to the response for
 * a sessionId that never existed (missing) — so the read surface
 * cannot be used as a sessionId-existence oracle by a same-probe
 * attacker. `renderReadAllowed` unit tests alone can't catch a
 * regression where the handler computes the correct allow/deny
 * boolean but then leaks row-derived state through a different code
 * path on deny (exactly the bug fix 1 in the final review addressed:
 * deny used to early-return the loading shell while a miss of the
 * same resume URI could resolve the registry-fallback shell).
 *
 * Two probes are covered, matching spec §6 bullet 3 + the tenancy-gate
 * matrix intent:
 *   - blueprint-less (legacy single-segment URI): neither read can
 *     resolve anything, so both must FAIL, with the identical typed
 *     JSON-RPC error.
 *   - registry-fallback (resume URI with a registered blueprint):
 *     both denied-row and missing-row reads of the SAME blueprintKey
 *     must return the byte-identical registry-fallback shell — this
 *     is the case that failed before fix 1 (deny early-returned
 *     instead of falling through to the registry fallback the miss
 *     case reaches).
 *
 * Comparison method: responses are compared after normalizing out the
 * caller-supplied `sessionId` (it necessarily differs between the two
 * probes — one targets a real row's id, the other a random id the
 * attacker picked — but it is echoed verbatim from the request URI,
 * never derived from the row, so it carries no oracle signal). Every
 * OTHER byte must match exactly.
 */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  InMemoryGguiSessionStore,
  InMemoryVectorStore,
  InMemoryBlueprintIndex,
  InMemoryCodeStore,
  MockEmbeddingProvider,
} from "@ggui-ai/mcp-server-core/in-memory";
import { registerBlueprint } from "@ggui-ai/mcp-server-handlers";
import { GGUI_RENDER_RESOURCE_URI } from "@ggui-ai/protocol/integrations/mcp-apps";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import { registerGguiRenderResourceTemplate } from "./mcp-apps-outbound.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const ROW_APP_ID = "app_owner";
const CALLER_APP_ID = "app_caller"; // cross-app relative to ROW_APP_ID
const DEFAULT_APP_ID_FALLBACK = "builder";

const callerCtx: HandlerContext = {
  appId: CALLER_APP_ID,
  authSource: "apikey",
  apiKeyHash: "test-hash",
  requestId: "req-cross-app",
};

interface Fixture {
  client: Client;
  server: McpServer;
  renderStore: InMemoryGguiSessionStore;
  close: () => Promise<void>;
}

async function boot(opts: {
  registryFallback: boolean;
}): Promise<Fixture & { blueprintKey?: string }> {
  const renderStore = new InMemoryGguiSessionStore();
  const server = new McpServer({ name: "test", version: "0.0.1" });

  let blueprintKey: string | undefined;
  const registryDeps = opts.registryFallback
    ? {
        vectorStore: new InMemoryVectorStore(),
        index: new InMemoryBlueprintIndex(),
      }
    : undefined;

  if (opts.registryFallback && registryDeps) {
    const embedding = new MockEmbeddingProvider();
    const registered = await registerBlueprint(
      { embedding, vectorStore: registryDeps.vectorStore, index: registryDeps.index },
      DEFAULT_APP_ID_FALLBACK,
      {
        kind: "template",
        contract: {},
        intent: "registry-fallback probe",
        componentCode: "export default function Card(){return null;}",
        source: { kind: "user" },
      },
    );
    blueprintKey = registered.contractKey;
  }

  registerGguiRenderResourceTemplate(server, {
    renderStore,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: () => callerCtx,
    logger: silentLogger,
    ...(registryDeps
      ? {
          vectorStore: registryDeps.vectorStore,
          index: registryDeps.index,
          defaultAppIdFallback: DEFAULT_APP_ID_FALLBACK,
          codeStore: new InMemoryCodeStore(),
          codeBaseUrl: "https://code.example",
        }
      : {}),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gate-test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    renderStore,
    blueprintKey,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Strip the caller-supplied, attacker-known sessionId from a resource
 *  response before comparing — see file banner. Everything else must
 *  match verbatim. */
function normalize(contents: unknown, sessionId: string): unknown {
  return JSON.parse(JSON.stringify(contents).split(sessionId).join("<SID>"));
}

interface ReadFailure {
  readonly code: number;
  readonly message: string;
  readonly data: unknown;
}

/**
 * Read a locator that must FAIL, and return the failure. Positive
 * assertion rather than a bare throw-pin: a read that succeeded, or one
 * that raised an untyped error, has to fail this helper rather than
 * satisfy it.
 */
async function readFailure(client: Client, uri: string): Promise<ReadFailure> {
  try {
    await client.readResource({ uri });
  } catch (err) {
    if (err instanceof McpError) {
      return { code: err.code, message: err.message, data: err.data };
    }
    throw err;
  }
  throw new Error(`read of ${uri} returned a result; expected a typed failure`);
}

describe("render-resource read gate — deny is byte-identical to miss", () => {
  it("blueprint-less probe: denied row and missing row fail with the identical typed error", async () => {
    const f = await boot({ registryFallback: false });
    try {
      const deniedSessionId = (await f.renderStore.create({ appId: ROW_APP_ID })).id;
      const missingSessionId = randomUUID();

      const deniedRead = await readFailure(
        f.client,
        `${GGUI_RENDER_RESOURCE_URI}/${deniedSessionId}`,
      );
      const missingRead = await readFailure(
        f.client,
        `${GGUI_RENDER_RESOURCE_URI}/${missingSessionId}`,
      );

      expect(normalize(deniedRead, deniedSessionId)).toEqual(
        normalize(missingRead, missingSessionId),
      );
      // Sanity: both really carry a classification, not some empty
      // shape both sides happen to agree on. This server keeps no
      // durable record, which is a property it must state for the
      // denied row too — a `NOT_FOUND` here and `NOT_SUPPORTED` there
      // would rebuild the oracle out of the failure codes.
      expect(deniedRead.data).toEqual({ code: "NOT_SUPPORTED" });
    } finally {
      await f.close();
    }
  });

  it("registry-fallback probe: denied row and missing row of the same blueprintKey both return the byte-identical registry shell", async () => {
    const f = await boot({ registryFallback: true });
    try {
      const deniedSessionId = (await f.renderStore.create({ appId: ROW_APP_ID })).id;
      const missingSessionId = randomUUID();
      const key = f.blueprintKey;
      expect(typeof key).toBe("string");

      const deniedRead = await f.client.readResource({
        uri: `${GGUI_RENDER_RESOURCE_URI}/${deniedSessionId}/${key}`,
      });
      const missingRead = await f.client.readResource({
        uri: `${GGUI_RENDER_RESOURCE_URI}/${missingSessionId}/${key}`,
      });

      // Neither side may fall back to the dead loading shell — the
      // blueprint is registered under `defaultAppIdFallback` and keyed
      // only by the URI's blueprintKey, so BOTH probes should resolve
      // the registry-only rehydrate shell.
      const missingText = (missingRead.contents[0] as { text: string }).text;
      expect(missingText).not.toContain('data-ggui-shell="loading"');

      expect(normalize(deniedRead.contents, deniedSessionId)).toEqual(
        normalize(missingRead.contents, missingSessionId),
      );
      // The registry shell's own appId comes from `defaultAppIdFallback`
      // (registry defaults), NEVER from the denied row's real appId —
      // pin that explicitly so a future regression that threads the
      // row's appId back in fails loudly here, not just on the
      // aggregate byte-identity check above.
      expect(missingText).not.toContain(ROW_APP_ID);
      expect(missingText).toContain(DEFAULT_APP_ID_FALLBACK);
    } finally {
      await f.close();
    }
  });

  it("warn-logs render_resource_read_denied on the denied read (server-side signal preserved)", async () => {
    const warn = vi.fn();
    const renderStore = new InMemoryGguiSessionStore();
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerGguiRenderResourceTemplate(server, {
      renderStore,
      runtimeUrl: "https://runtime.example/bundle.js",
      getContext: () => callerCtx,
      logger: { ...silentLogger, warn },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "gate-test-client-2", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const deniedSessionId = (await renderStore.create({ appId: ROW_APP_ID })).id;
      // The read now fails, but the server-side audit line is what this
      // test is about: a refusal the caller cannot see must still be
      // visible to the operator.
      await readFailure(client, `${GGUI_RENDER_RESOURCE_URI}/${deniedSessionId}`);
      expect(warn).toHaveBeenCalledWith(
        "render_resource_read_denied",
        expect.objectContaining({
          sessionId: deniedSessionId,
          rowAppId: ROW_APP_ID,
          callerAppId: CALLER_APP_ID,
        }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
