import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  renderReadAllowed,
  renderReadVerdict,
  renderReadVerdictLogged,
  type RenderReadDoor,
  type RenderReadLineFields,
} from "./render-read-gate.js";
import type { HandlerContext } from "../types.js";

/** A sink that swallows the gate's lines; the predicate tests below are about the verdict. */
const quiet = { info: () => undefined };
/** The predicate alone — door and sink fixed, since these tests are about the verdict. */
const allowed = (row: { appId: string; userId?: string }, caller: HandlerContext | undefined) =>
  renderReadAllowed(row, caller, "resources_read", quiet);

const APP = "app_a";
// #446 — the subject is `userId`, written at commit. This fixture used
// to carry an `endUserIdentity` block, which is precisely why the rung
// looked exercised while binding nothing in production: no writer has
// populated that field since the repo split.
const subjectRow = { appId: APP, userId: "guuey:g_alice" };
const bareRow = { appId: APP };

function ctx(
  partial: Partial<HandlerContext> & Pick<HandlerContext, "appId" | "authSource">
): HandlerContext {
  return { requestId: "req-1", ...partial };
}

describe("renderReadAllowed", () => {
  it("denies when no request context is available (fail closed)", () => {
    expect(allowed(bareRow, undefined)).toBe(false);
  });

  it("denies cross-app reads for every identity kind", () => {
    expect(
      allowed(bareRow, ctx({ appId: "app_b", authSource: "apikey", apiKeyHash: "h" }))
    ).toBe(false);
    expect(
      allowed(
        subjectRow,
        ctx({ appId: "app_b", authSource: "oidc", userId: "guuey:g_alice" })
      )
    ).toBe(false);
    expect(allowed(bareRow, ctx({ appId: "app_b", authSource: "anonymous" }))).toBe(
      false
    );
  });

  it("allows a federated user reading their own subject-bound row", () => {
    expect(
      allowed(
        subjectRow,
        ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_alice" })
      )
    ).toBe(true);
  });

  it("denies a federated user reading another subject's row (same app)", () => {
    expect(
      allowed(subjectRow, ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_bob" }))
    ).toBe(false);
  });

  it("denies an oauth-login user reading another subject's row (same app)", () => {
    expect(
      allowed(subjectRow, ctx({ appId: APP, authSource: "oauth", userId: "guuey:g_bob" }))
    ).toBe(false);
  });

  it("allows an email-login user reading their own subject-bound row", () => {
    expect(
      allowed(
        subjectRow,
        ctx({ appId: APP, authSource: "email", userId: "guuey:g_alice" })
      )
    ).toBe(true);
  });

  it("allows an app credential of the owning app without a subject check (tenant trust)", () => {
    expect(
      allowed(subjectRow, ctx({ appId: APP, authSource: "apikey", apiKeyHash: "h" }))
    ).toBe(true);
  });

  it("allows a federated user on a row without endUserIdentity (same app)", () => {
    expect(
      allowed(bareRow, ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_alice" }))
    ).toBe(true);
  });

  it("allows single-app builder/anonymous flows (same default app)", () => {
    expect(
      allowed({ appId: "builder" }, ctx({ appId: "builder", authSource: "anonymous" }))
    ).toBe(true);
  });

  it("ignores a stale endUserIdentity block — the subject is userId alone", () => {
    // A row carrying the legacy block but NO userId has no subject as
    // far as the gate is concerned. Reading the block instead would
    // resurrect exactly the field the repo split stopped writing.
    const legacyOnly = {
      appId: APP,
      endUserIdentity: {
        userId: "guuey:g_alice",
        provider: "custom" as const,
        authenticatedAt: "2026-08-07T00:00:00.000Z",
      },
    } as { appId: string; userId?: string };
    expect(
      allowed(legacyOnly, ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_bob" }))
    ).toBe(true);
  });

  it("denies a cross-user read of a subject-bound row", () => {
    expect(
      allowed(subjectRow, ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_bob" }))
    ).toBe(false);
  });

  it("never treats a sessionId-shaped credential as the subject (the #446 trap)", () => {
    // `subscribe.ts`'s WS bootstrap path synthesizes an identity whose
    // `userId` IS the sessionId — a render-scoped credential, not a
    // person. If that ever reached a row as its subject, the row would
    // be bound to a value every holder of the bootstrap token presents,
    // and the gate would pass them all. A row minted by that path
    // carries NO subject, so it passes on the app rung like any other
    // unbound row — and crucially it must not MATCH the credential.
    const sessionId = "rnd_01JD3";
    const devPathRow = { appId: APP };
    const bootstrapCtx = ctx({ appId: APP, authSource: "apikey", userId: sessionId });
    expect(allowed(devPathRow, bootstrapCtx)).toBe(true);

    // And the inverse: a row that genuinely belongs to a person is NOT
    // readable by a bootstrap credential carrying the sessionId.
    expect(allowed(subjectRow, bootstrapCtx)).toBe(false);
  });
});

describe("renderReadVerdict — which rung decided, and the one case #1553 measures", () => {
  const appKey = ctx({ appId: APP, authSource: "apikey", apiKeyHash: "h" });
  const alice = ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_alice" });
  const bob = ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_bob" });

  it("names the rung on every path, and agrees with renderReadAllowed", () => {
    const cases = [
      [subjectRow, undefined, { allowed: false, rung: "no-context", appTrustOverSubject: false }],
      [subjectRow, ctx({ appId: "other", authSource: "apikey", apiKeyHash: "h" }), { allowed: false, rung: "app", appTrustOverSubject: false }],
      [subjectRow, alice, { allowed: true, rung: "subject", appTrustOverSubject: false }],
      [subjectRow, bob, { allowed: false, rung: "subject", appTrustOverSubject: false }],
      [subjectRow, appKey, { allowed: true, rung: "app-trust", appTrustOverSubject: true }],
      [bareRow, appKey, { allowed: true, rung: "app-trust", appTrustOverSubject: false }],
      [bareRow, alice, { allowed: true, rung: "app-trust", appTrustOverSubject: false }],
    ] as const;
    for (const [row, caller, expected] of cases) {
      expect(renderReadVerdict(row, caller)).toEqual(expected);
      expect(renderReadAllowed(row, caller, 'resources_read', quiet)).toBe(expected.allowed);
    }
  });
});

describe("renderReadVerdictLogged / renderReadAllowed — one emitter behind every door (ggui#1553)", () => {
  const appKey = ctx({ appId: APP, authSource: "apikey", apiKeyHash: "h" });
  const alice = ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_alice" });
  const bob = ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_bob" });
  const DOORS: readonly RenderReadDoor[] = [
    "resources_read",
    "refresh_ws_token",
    "live_channel_subscribe",
    "ggui_runtime_pull",
    "ggui_emit",
    "ggui_runtime_submit_action",
    "ggui_runtime_sync_context",
    "ggui_update",
    "ggui_amend",
  ];
  function sink() {
    const lines: Array<[string, RenderReadLineFields]> = [];
    return { lines, info: (event: string, fields: RenderReadLineFields) => void lines.push([event, fields]) };
  }

  it("every door: the per-read line on every allow, the admit line exactly once and only on the disagreement case, nothing on a deny", () => {
    for (const door of DOORS) {
      const s = sink();
      expect(renderReadAllowed(subjectRow, appKey, door, s)).toBe(true);
      expect(s.lines).toEqual([
        ["render_resource_read", { door, appId: APP, source: "apikey", appTrustOverSubject: true }],
        ["render_read_app_trust_over_subject", { door, appId: APP, source: "apikey" }],
      ]);
      s.lines.length = 0;
      expect(renderReadAllowed(subjectRow, alice, door, s)).toBe(true);
      expect(s.lines).toEqual([["render_resource_read", { door, appId: APP, source: "oidc", appTrustOverSubject: false }]]);
      s.lines.length = 0;
      expect(renderReadAllowed(bareRow, appKey, door, s)).toBe(true);
      expect(s.lines).toEqual([["render_resource_read", { door, appId: APP, source: "apikey", appTrustOverSubject: false }]]);
      s.lines.length = 0;
      expect(renderReadAllowed(subjectRow, bob, door, s)).toBe(false);
      expect(renderReadAllowed(subjectRow, ctx({ appId: "other", authSource: "apikey", apiKeyHash: "h" }), door, s)).toBe(false);
      expect(renderReadAllowed(subjectRow, undefined, door, s)).toBe(false);
      expect(s.lines).toEqual([]);
    }
  });

  it("a caller that resolved only the two gated fields (the live channel's bearer pair) reports source null", () => {
    const s = sink();
    expect(renderReadAllowed(subjectRow, { appId: APP }, "live_channel_subscribe", s)).toBe(true);
    expect(s.lines).toEqual([
      ["render_resource_read", { door: "live_channel_subscribe", appId: APP, source: null, appTrustOverSubject: true }],
      ["render_read_app_trust_over_subject", { door: "live_channel_subscribe", appId: APP, source: null }],
    ]);
  });

  it("without a sink, each line falls back to ONE console.info text line, emitted from the gate", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      expect(renderReadAllowed(subjectRow, appKey, "ggui_emit")).toBe(true);
      expect(info.mock.calls.map((c) => String(c[0]))).toEqual([
        '[ggui] render_resource_read {"door":"ggui_emit","appId":"app_a","source":"apikey","appTrustOverSubject":true}',
        '[ggui] render_read_app_trust_over_subject {"door":"ggui_emit","appId":"app_a","source":"apikey"}',
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it("logging changes nothing about the verdict", () => {
    for (const [row, caller] of [
      [subjectRow, appKey],
      [subjectRow, alice],
      [subjectRow, bob],
      [bareRow, alice],
      [subjectRow, undefined],
    ] as const) {
      expect(renderReadVerdictLogged(row, caller, "ggui_update", quiet)).toEqual(renderReadVerdict(row, caller));
    }
  });

  it("pin: no door in this package calls the unlogged predicate — a site that bypasses the emitter is a door with no denominator", () => {
    // Scope: this package's renders directory. The two doors in @ggui-ai/mcp-server
    // (`resources/read`, the live channel's bearer subscribe) are outside it and are
    // pinned by their behaviour suites there, not by this read of the source.
    const dir = new URL("./", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "render-read-gate.ts")
      .filter((f) => /\brenderReadVerdict\(/.test(readFileSync(new URL(f, dir), "utf8")));
    expect(offenders).toEqual([]);
  });
});
