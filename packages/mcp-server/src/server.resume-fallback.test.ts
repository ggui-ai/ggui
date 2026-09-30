/**
 * The resource read's registry-only fallback (ggui#1601), pinned through a
 * real `resources/read` on `createGguiServer`.
 *
 * When a `ui://ggui/render/{sessionId}/{blueprintKey}` locator's render row
 * is gone and no identity record re-mints it, the read falls back to the
 * blueprint registry: `findBlueprintExact` over the factory's vector store and
 * index, under the DEFAULT app id, at the key's default variant. Two facts
 * bound what that fallback can ever mount, and both are pinned here:
 *
 * 1. It reads the vector store the factory holds. With no `vectors` supplied,
 *    that is the factory's own in-memory store, so an index binding alone
 *    (one whose row lives in some other store) mounts nothing: the read fails
 *    typed.
 * 2. Its scope is the default app id and nothing else. A card registered
 *    under any other app is never found by it, whatever the caller.
 *
 * The fixture wires code delivery (a code store and its base URL), as a
 * hosted deployment does, so a card the fallback finds really mounts. Each
 * negative case therefore reads `NOT_FOUND` from a server fully able to mount,
 * and has a control on the same fixture that DOES mount.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  InMemoryBlueprintIndex,
  InMemoryBlueprintStore,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryRenderIdentityStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from "@ggui-ai/mcp-server-core/in-memory";
import { findBlueprintExact, registerBlueprint } from "@ggui-ai/mcp-server-handlers";
import { createGguiServer } from "./server.js";

const RESOURCE_URI = "ui://ggui/render";
/** The default app id the fallback is scoped to (the OSS single-app identity). */
const DEFAULT_APP_ID = "builder";
const OTHER_APP_ID = "app_customer";
const SESSION_ID = "render_gone";
const COMPONENT_CODE = "export default function Card(){return null;}";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface WireError {
  readonly code: number;
  readonly data?: { readonly code?: string };
}

/** Register the card under `appId` into `vectorStore` + `index`; returns its resume key. */
async function registerCard(
  vectorStore: InMemoryVectorStore,
  index: InMemoryBlueprintIndex,
  appId: string,
): Promise<string> {
  const registered = await registerBlueprint(
    { embedding: new MockEmbeddingProvider(), vectorStore, index },
    appId,
    {
      kind: "template",
      contract: {},
      intent: "a card to resume",
      componentCode: COMPONENT_CODE,
      source: { kind: "user" },
    },
  );
  return registered.contractKey;
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (close) {
    await close();
    close = null;
  }
});

/**
 * Boot the factory with a render store holding no row, and a durable
 * substrate holding no record, so a read of any locator reaches the fallback.
 * `vectors` is passed only when given: absent, the factory uses its default.
 */
async function boot(options: {
  readonly index: InMemoryBlueprintIndex;
  readonly vectors?: InMemoryVectorStore;
}): Promise<Client> {
  const server = createGguiServer({
    logger: silentLogger,
    renderChannel: true,
    mcpApps: true,
    wsTokenSecret: "test-secret-32bytes-for-hmac-1234",
    renderStore: new InMemoryGguiSessionStore(),
    renderIdentityStore: new InMemoryRenderIdentityStore({ durability: "durable" }),
    durableBlueprints: {
      blueprintStore: new InMemoryBlueprintStore({ durability: "durable" }),
      codeStore: new InMemoryCodeStore({ durability: "durable" }),
    },
    index: options.index,
    ...(options.vectors !== undefined ? { vectors: options.vectors } : {}),
    // Code delivery, as a hosted deployment wires it: a found card mounts.
    codeStore: new InMemoryCodeStore(),
    codeBaseUrl: "https://assets.example",
  });
  const httpServer = await server.listen(0, "127.0.0.1");
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("server.address() did not return AddressInfo");
  const client = new Client({ name: "resume-fallback-client", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer dev" } },
    }),
  );
  close = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

async function readFailure(client: Client, key: string): Promise<WireError> {
  try {
    await client.readResource({ uri: `${RESOURCE_URI}/${SESSION_ID}/${key}` });
  } catch (err) {
    return err as WireError;
  }
  throw new Error("the read mounted; expected a typed failure");
}

describe("createGguiServer — the resume fallback mounts only a card in the factory's own store, under the default app (ggui#1601)", () => {
  it("with the factory's default store, a read whose row and record are gone fails typed, even when the index binds the key under the default app", async () => {
    // The row lives in a store the factory is NOT given; the index it IS given
    // binds the key under the default app.
    const elsewhere = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const key = await registerCard(elsewhere, index, DEFAULT_APP_ID);
    // The binding is real: the same lookup the fallback makes resolves it
    // against the store that holds the row.
    expect(await findBlueprintExact({ vectorStore: elsewhere, index }, DEFAULT_APP_ID, "template", key)).not.toBeNull();

    const client = await boot({ index });
    const err = await readFailure(client, key);
    expect(err.data?.code).toBe("NOT_FOUND");
    expect(err.code).toBe(-32002);
  });

  it("control: the same fixture mounts when the factory is given the store that holds the row", async () => {
    const vectors = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const key = await registerCard(vectors, index, DEFAULT_APP_ID);

    const client = await boot({ index, vectors });
    const read = await client.readResource({ uri: `${RESOURCE_URI}/${SESSION_ID}/${key}` });
    expect(read.contents).toHaveLength(1);
  });

  it("looks only under the default app: a card registered under another app is never found, though the same card under the default app is", async () => {
    const vectors = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const key = await registerCard(vectors, index, OTHER_APP_ID);

    const client = await boot({ index, vectors });
    const err = await readFailure(client, key);
    expect(err.data?.code).toBe("NOT_FOUND");
    expect(err.code).toBe(-32002);

    // The same card, now also under the default app: the fallback finds it.
    expect(await registerCard(vectors, index, DEFAULT_APP_ID)).toBe(key);
    const read = await client.readResource({ uri: `${RESOURCE_URI}/${SESSION_ID}/${key}` });
    expect(read.contents).toHaveLength(1);
  });
});
