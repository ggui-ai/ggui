/**
 * `ggui_runtime_refresh_ws_token` is an AUTHORIZED re-mint (ggui#1496 part B,
 * S1–S2). It re-mints a live credential only for a caller that the read
 * door's own predicate (`renderReadAllowed`: the app, then the subject)
 * admits on the live row. It answers in a fixed order:
 *   1. a deployment with no render store, verifier or minter → BOOTSTRAP_NOT_SUPPORTED;
 *   2. an envelope that fails its HMAC or kind → BOOTSTRAP_INVALID;
 *   3. a missing, foreign or subject-refused session → the SAME not-found
 *      `ggui_runtime_pull` throws, byte-identical;
 *   4. a store read that throws → that error, and nothing minted;
 *   5. otherwise a ROOT mint through the deployment's minter, whatever the
 *      envelope's age.
 * The refresh window no longer bounds this path: the host's authorized
 * connection does, per call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryGguiSessionStore } from "@ggui-ai/mcp-server-core/in-memory";
import { mintWsToken, verifyToken, verifyWsTokenSignature } from "@ggui-ai/mcp-server-core";
import type { ComponentGguiSession } from "@ggui-ai/protocol";
import type { HandlerContext } from "../types.js";
import { GguiSessionNotFoundError } from "./errors.js";
import {
  createGguiRefreshWsTokenHandler,
  type GguiRefreshWsTokenHandlerDeps,
} from "./refresh-ws-token.js";
import { createGguiRuntimePullHandler } from "./runtime-pull.js";

const SECRET = "refresh-1496-secret";
const verify: NonNullable<GguiRefreshWsTokenHandlerDeps["verify"]> = (envelope) => {
  const r = verifyWsTokenSignature(envelope, SECRET);
  return r.ok
    ? {
        ok: true,
        sessionId: r.claims.sessionId,
        appId: r.claims.appId,
        rootIat: r.claims.rootIat ?? r.claims.iat,
      }
    : { ok: false };
};
const mint: NonNullable<GguiRefreshWsTokenHandlerDeps["mint"]> = (sessionId, appId) => {
  const { token, claims } = mintWsToken({ sessionId, appId }, SECRET);
  return { token, expiresAt: new Date(claims.exp * 1000).toISOString() };
};

function card(id: string, appId: string): ComponentGguiSession {
  return {
    type: "component",
    id,
    appId,
    componentCode: "/* card */",
    eventSequence: 0,
    createdAt: 0,
    lastActivityAt: 0,
    // Far future, so the live row never expires under the fake clocks below.
    expiresAt: Date.UTC(2100, 0, 1),
  };
}

async function seeded(opts: { id: string; appId: string; userId?: string }) {
  const store = new InMemoryGguiSessionStore();
  await store.commit({
    appId: opts.appId,
    render: card(opts.id, opts.appId),
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
  });
  return store;
}

const ctxOf = (appId: string, userId?: string): HandlerContext => ({
  appId,
  requestId: "req-1496",
  ...(userId !== undefined ? { userId } : {}),
});

async function refresh(deps: GguiRefreshWsTokenHandlerDeps, envelope: string, ctx: HandlerContext) {
  return createGguiRefreshWsTokenHandler(deps).handler({ envelope }, ctx);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ggui_runtime_refresh_ws_token is an authorized re-mint (ggui#1496 part B)", () => {
  it("keeps its runtime audience and app-only visibility", () => {
    const h = createGguiRefreshWsTokenHandler({});
    expect(h.name).toBe("ggui_runtime_refresh_ws_token");
    expect(h.audience).toEqual(["runtime"]);
    expect(h._meta).toMatchObject({ ui: { visibility: ["app"] } });
  });

  it("1. answers BOOTSTRAP_NOT_SUPPORTED when the deployment wires no store, verifier or minter", async () => {
    const store = await seeded({ id: "s1", appId: "A" });
    const envelope = mintWsToken({ sessionId: "s1", appId: "A" }, SECRET).token;
    for (const deps of [
      { verify, mint },
      { renderStore: store, mint },
      { renderStore: store, verify },
    ]) {
      const out = await refresh(deps, envelope, ctxOf("A"));
      expect(out).toMatchObject({ ok: false, code: "BOOTSTRAP_NOT_SUPPORTED" });
    }
  });

  it("2. answers BOOTSTRAP_INVALID for a tampered envelope or a missing one", async () => {
    const store = await seeded({ id: "s1", appId: "A" });
    const good = mintWsToken({ sessionId: "s1", appId: "A" }, SECRET).token;
    const tampered = `${good.slice(0, -2)}xx`;
    expect(await refresh({ renderStore: store, verify, mint }, tampered, ctxOf("A"))).toMatchObject(
      {
        ok: false,
        code: "BOOTSTRAP_INVALID",
      }
    );
    const h = createGguiRefreshWsTokenHandler({ renderStore: store, verify, mint });
    expect(await h.handler({}, ctxOf("A"))).toMatchObject({ ok: false, code: "BOOTSTRAP_INVALID" });
  });

  it("5. re-mints a ROOT for its own session at ANY age — the window no longer bounds it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const store = await seeded({ id: "s1", appId: "A" });
    const old = mintWsToken({ sessionId: "s1", appId: "A" }, SECRET).token;
    vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
    expect(
      verifyToken(old, SECRET, "ws").ok,
      "the presented envelope is long expired — control"
    ).toBe(false);
    const spy = vi.fn(mint);
    const out = await refresh({ renderStore: store, verify, mint: spy }, old, ctxOf("A"));
    expect(out.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith("s1", "A");
    const fresh = out.ok ? out.envelope : "";
    const v = verifyToken(fresh, SECRET, "ws");
    expect(v.ok).toBe(true);
    expect(v.ok && v.claims.sessionId).toBe("s1");
  });

  it("3. a missing session throws ggui_runtime_pull's not-found, byte-identical, and mints nothing", async () => {
    const store = new InMemoryGguiSessionStore();
    const envelope = mintWsToken({ sessionId: "gone", appId: "A" }, SECRET).token;
    const spy = vi.fn(mint);
    const refreshErr = await refresh(
      { renderStore: store, verify, mint: spy },
      envelope,
      ctxOf("A")
    ).then(
      () => null,
      (e: unknown) => e
    );
    const pullErr = await createGguiRuntimePullHandler({ renderStore: store })
      .handler({ sessionId: "gone", sinceSequence: 0 }, ctxOf("A"))
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(refreshErr).toBeInstanceOf(GguiSessionNotFoundError);
    expect(pullErr).toBeInstanceOf(GguiSessionNotFoundError);
    expect((refreshErr as Error).message).toBe((pullErr as Error).message);
    expect(spy).not.toHaveBeenCalled();
  });

  /** `ggui_runtime_pull`'s own refusal for `sessionId`, from a store where the pull refuses it. */
  async function pullRefusal(
    store: InMemoryGguiSessionStore,
    sessionId: string,
    ctx: HandlerContext
  ): Promise<unknown> {
    return createGguiRuntimePullHandler({ renderStore: store })
      .handler({ sessionId, sinceSequence: 0 }, ctx)
      .then(
        () => null,
        (e: unknown) => e
      );
  }

  it("3. a session of another app gets the pull's not-found, byte-identical, and mints nothing", async () => {
    const store = await seeded({ id: "sB", appId: "B" });
    const envelope = mintWsToken({ sessionId: "sB", appId: "B" }, SECRET).token;
    const spy = vi.fn(mint);
    const foreign = await refresh(
      { renderStore: store, verify, mint: spy },
      envelope,
      ctxOf("A")
    ).then(
      () => null,
      (e: unknown) => e
    );
    const pulled = await pullRefusal(store, "sB", ctxOf("A"));
    expect(foreign).toBeInstanceOf(GguiSessionNotFoundError);
    expect(pulled).toBeInstanceOf(GguiSessionNotFoundError);
    expect((foreign as Error).message).toBe((pulled as Error).message);
    expect(spy).not.toHaveBeenCalled();
  });

  it("3. an envelope whose app disagrees with the live row's gets the same not-found, and mints nothing", async () => {
    const store = await seeded({ id: "s1", appId: "A" });
    // A validly signed envelope that names app B for a session the store holds under app A.
    const envelope = mintWsToken({ sessionId: "s1", appId: "B" }, SECRET).token;
    const spy = vi.fn(mint);
    const err = await refresh({ renderStore: store, verify, mint: spy }, envelope, ctxOf("A")).then(
      () => null,
      (e: unknown) => e
    );
    const pulled = await pullRefusal(new InMemoryGguiSessionStore(), "s1", ctxOf("A"));
    expect(err).toBeInstanceOf(GguiSessionNotFoundError);
    expect((err as Error).message).toBe((pulled as Error).message);
    expect(spy).not.toHaveBeenCalled();
  });

  it("3. the subject rung: another user of the same app gets the pull's not-found, byte-identical, and mints nothing; the subject and an app credential pass", async () => {
    const store = await seeded({ id: "s1", appId: "A", userId: "u1" });
    const envelope = mintWsToken({ sessionId: "s1", appId: "A" }, SECRET).token;
    const spy = vi.fn(mint);
    const other = await refresh(
      { renderStore: store, verify, mint: spy },
      envelope,
      ctxOf("A", "u2")
    ).then(
      () => null,
      (e: unknown) => e
    );
    // The pull has no subject rung, so its refusal for the same id comes from a store without the row.
    const pulled = await pullRefusal(new InMemoryGguiSessionStore(), "s1", ctxOf("A", "u2"));
    expect(other).toBeInstanceOf(GguiSessionNotFoundError);
    expect((other as Error).message).toBe((pulled as Error).message);
    expect(spy).not.toHaveBeenCalled();
    expect(
      (await refresh({ renderStore: store, verify, mint }, envelope, ctxOf("A", "u1"))).ok,
      "the subject itself"
    ).toBe(true);
    expect(
      (await refresh({ renderStore: store, verify, mint }, envelope, ctxOf("A"))).ok,
      "app trust"
    ).toBe(true);
  });

  it("4. a store read that throws surfaces that error — never the not-found — and mints nothing", async () => {
    const store = await seeded({ id: "s1", appId: "A" });
    vi.spyOn(store, "get").mockRejectedValue(new Error("store offline"));
    const envelope = mintWsToken({ sessionId: "s1", appId: "A" }, SECRET).token;
    const spy = vi.fn(mint);
    const err = await refresh({ renderStore: store, verify, mint: spy }, envelope, ctxOf("A")).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GguiSessionNotFoundError);
    expect((err as Error).message).toBe("store offline");
    expect(spy).not.toHaveBeenCalled();
  });

  it("S6: one line per refresh, and one per refusal, with ids only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const store = await seeded({ id: "s1", appId: "A" });
    const envelope = mintWsToken({ sessionId: "s1", appId: "A" }, SECRET).token;
    vi.setSystemTime(new Date("2026-09-01T00:10:00Z"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await refresh({ renderStore: store, verify, mint }, envelope, {
      ...ctxOf("A"),
      authSource: "apikey",
    });
    expect(info.mock.calls.map((c) => String(c[0]))).toEqual([
      '[ggui] ws_token_refreshed {"sessionId":"s1","appId":"A","source":"apikey","rootAgeSec":600}',
    ]);
    await refresh({ renderStore: store, verify, mint }, envelope, ctxOf("B")).catch(
      () => undefined
    );
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      '[ggui] ws_token_refresh_refused {"reason":"not_found","source":null}',
    ]);
  });

  it("S6: a chained envelope's rootAgeSec counts from its chain's root, not from its own iat (slice 2)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const store = await seeded({ id: "s1", appId: "A" });
    const rootIat = Math.floor(Date.now() / 1000);
    vi.setSystemTime(new Date("2026-09-01T00:05:00Z"));
    // A `/state` renewal minted 5 minutes into the chain.
    const chained = mintWsToken({ sessionId: "s1", appId: "A", rootIat }, SECRET).token;
    vi.setSystemTime(new Date("2026-09-01T00:10:00Z"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await refresh({ renderStore: store, verify, mint }, chained, ctxOf("A"));
    expect(info.mock.calls.map((c) => String(c[0]))).toEqual([
      '[ggui] ws_token_refreshed {"sessionId":"s1","appId":"A","source":null,"rootAgeSec":600}',
    ]);
  });
});
