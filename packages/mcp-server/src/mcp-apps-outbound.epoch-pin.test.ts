/**
 * Epoch-pinned history reads (#483).
 *
 * `ui://ggui/render/{sessionId}[/{key}]#N` names the IMMUTABLE
 * epoch-N record; the bare URI names the live head. These tests pin:
 *
 *   - the SDK's template matching tolerates the `#N` pin (the
 *     server-side half of the encoding probe — the seam module owns
 *     the encoding, these tests own "reads resolve"),
 *   - a superseded pin serves the RECONSTRUCTED historical props
 *     (ledger walk with epoch-stamped filtering: the update that
 *     mints N+1 stamps its props N+1 — they never leak into #N),
 *   - pinned immutability: two reads of a superseded record are
 *     byte-identical,
 *   - pin === head falls through to the live mount; pin > head is
 *     NOT_FOUND,
 *   - a pin whose reign is not in the ledger (no events — e.g. #0
 *     with no amends, or horizon eviction) is the same terminal
 *     posture as a missing locator.
 */
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryGguiSessionStore } from "@ggui-ai/mcp-server-core/in-memory";
import type { ComponentGguiSession } from "@ggui-ai/protocol";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import { registerGguiRenderResourceTemplate } from "./mcp-apps-outbound.js";

const APP = "app-epoch-test";
const SID = "render-epoch-1";
const ownerCtx = { appId: APP } as HandlerContext;
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

async function boot(): Promise<{
  client: Client;
  store: InMemoryGguiSessionStore;
  close: () => Promise<void>;
}> {
  const store = new InMemoryGguiSessionStore();
  const server = new McpServer({ name: "epoch-pin-test", version: "0.0.1" });
  registerGguiRenderResourceTemplate(server, {
    renderStore: store,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: () => ownerCtx,
    logger: silentLogger,
  });
  const client = new Client({ name: "epoch-pin-host", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, store, close: () => client.close() };
}

/**
 * Seed the canonical two-epoch history:
 *   epoch 0 reign — mint at {count: 0}, one amend to {count: 1}
 *   epoch 1 head  — update mints #1 at {count: 5}
 */
async function seedHistory(store: InMemoryGguiSessionStore): Promise<void> {
  const base: ComponentGguiSession = {
    type: "component",
    id: SID,
    appId: APP,
    componentCode: "export default function X(){return null}",
    props: { count: 0 },
    eventSequence: 0,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    expiresAt: 1_900_000_000_000,
  };
  await store.commit({ render: base, appId: APP });
  // Amend during epoch 0's reign (stamped 0).
  await store.appendEvent({
    sessionId: SID,
    type: "ui.updated",
    data: { sessionId: SID, props: { count: 1 }, epoch: 0 },
  });
  // The update that mints #1: props stamped 1, THEN the boundary.
  await store.appendEvent({
    sessionId: SID,
    type: "ui.updated",
    data: { sessionId: SID, props: { count: 5 }, epoch: 1 },
  });
  await store.appendEvent({
    sessionId: SID,
    type: "ui.reminted",
    data: { epoch: 1 },
  });
  await store.commit({
    render: { ...base, props: { count: 5 }, epoch: 1 },
    appId: APP,
  });
}

function shellText(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const first = result.contents[0] as { text?: string };
  return first.text ?? "";
}

describe("epoch-pinned resource reads (#483)", () => {
  it("a superseded pin serves the reconstructed historical props — immutably", async () => {
    const { client, store, close } = await boot();
    await seedHistory(store);
    // State-at-supersession of #0 is the AMENDED value (count: 1) —
    // the freeze semantics — never the next record's 5.
    const read1 = await client.readResource({ uri: `ui://ggui/render/${SID}#0` });
    expect(shellText(read1)).toContain('\\"count\\":1');
    expect(shellText(read1)).not.toContain('\\"count\\":5');
    const read2 = await client.readResource({ uri: `ui://ggui/render/${SID}#0` });
    expect(shellText(read2)).toBe(shellText(read1));
    await close();
  });

  it("the bare URI serves the live head", async () => {
    const { client, store, close } = await boot();
    await seedHistory(store);
    const read = await client.readResource({ uri: `ui://ggui/render/${SID}` });
    expect(shellText(read)).toContain('\\"count\\":5');
    await close();
  });

  it("pin === head falls through to the live mount", async () => {
    const { client, store, close } = await boot();
    await seedHistory(store);
    const read = await client.readResource({ uri: `ui://ggui/render/${SID}#1` });
    expect(shellText(read)).toContain('\\"count\\":5');
    await close();
  });

  it("pin > head names a record that does not exist", async () => {
    const { client, store, close } = await boot();
    await seedHistory(store);
    await expect(
      client.readResource({ uri: `ui://ggui/render/${SID}#7` }),
    ).rejects.toThrow();
    await close();
  });

  it("a pin whose reign left no ledger trace is the same terminal posture as a miss", async () => {
    const { client, store, close } = await boot();
    // Head at epoch 2 but an EMPTY ledger — the pinned reigns are
    // unreachable (horizon eviction / pre-#483 history).
    const base: ComponentGguiSession = {
      type: "component",
      id: SID,
      appId: APP,
      componentCode: "export default function X(){return null}",
      props: { count: 9 },
      epoch: 2,
      eventSequence: 0,
      createdAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_000_000,
      expiresAt: 1_900_000_000_000,
    };
    await store.commit({ render: base, appId: APP });
    await expect(
      client.readResource({ uri: `ui://ggui/render/${SID}#0` }),
    ).rejects.toThrow();
    await close();
  });
});
