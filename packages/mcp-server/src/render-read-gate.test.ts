import { describe, expect, it } from "vitest";
import { renderReadAllowed } from "./render-read-gate.js";
// `HandlerContext` isn't exported from `./build-mcp.js` (only imported
// there); import from its actual home, matching render-read-gate.ts.
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";

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
    expect(renderReadAllowed(bareRow, undefined)).toBe(false);
  });

  it("denies cross-app reads for every identity kind", () => {
    expect(
      renderReadAllowed(bareRow, ctx({ appId: "app_b", authSource: "apikey", apiKeyHash: "h" }))
    ).toBe(false);
    expect(
      renderReadAllowed(
        subjectRow,
        ctx({ appId: "app_b", authSource: "oidc", userId: "guuey:g_alice" })
      )
    ).toBe(false);
    expect(renderReadAllowed(bareRow, ctx({ appId: "app_b", authSource: "anonymous" }))).toBe(
      false
    );
  });

  it("allows a federated user reading their own subject-bound row", () => {
    expect(
      renderReadAllowed(
        subjectRow,
        ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_alice" })
      )
    ).toBe(true);
  });

  it("denies a federated user reading another subject's row (same app)", () => {
    expect(
      renderReadAllowed(subjectRow, ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_bob" }))
    ).toBe(false);
  });

  it("denies an oauth-login user reading another subject's row (same app)", () => {
    expect(
      renderReadAllowed(subjectRow, ctx({ appId: APP, authSource: "oauth", userId: "guuey:g_bob" }))
    ).toBe(false);
  });

  it("allows an email-login user reading their own subject-bound row", () => {
    expect(
      renderReadAllowed(
        subjectRow,
        ctx({ appId: APP, authSource: "email", userId: "guuey:g_alice" })
      )
    ).toBe(true);
  });

  it("allows an app credential of the owning app without a subject check (tenant trust)", () => {
    expect(
      renderReadAllowed(subjectRow, ctx({ appId: APP, authSource: "apikey", apiKeyHash: "h" }))
    ).toBe(true);
  });

  it("allows a federated user on a row without endUserIdentity (same app)", () => {
    expect(
      renderReadAllowed(bareRow, ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_alice" }))
    ).toBe(true);
  });

  it("allows single-app builder/anonymous flows (same default app)", () => {
    expect(
      renderReadAllowed({ appId: "builder" }, ctx({ appId: "builder", authSource: "anonymous" }))
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
      renderReadAllowed(legacyOnly, ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_bob" }))
    ).toBe(true);
  });

  it("denies a cross-user read of a subject-bound row", () => {
    expect(
      renderReadAllowed(subjectRow, ctx({ appId: APP, authSource: "oidc", userId: "guuey:g_bob" }))
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
    expect(renderReadAllowed(devPathRow, bootstrapCtx)).toBe(true);

    // And the inverse: a row that genuinely belongs to a person is NOT
    // readable by a bootstrap credential carrying the sessionId.
    expect(renderReadAllowed(subjectRow, bootstrapCtx)).toBe(false);
  });
});
