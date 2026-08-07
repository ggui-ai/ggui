import { describe, expect, it } from "vitest";
import { renderReadAllowed } from "./render-read-gate.js";
// `HandlerContext` isn't exported from `./build-mcp.js` (only imported
// there); import from its actual home, matching render-read-gate.ts.
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";

const APP = "app_a";
const subjectRow = {
  appId: APP,
  endUserIdentity: {
    userId: "guuey:g_alice",
    provider: "custom" as const,
    authenticatedAt: "2026-08-07T00:00:00.000Z",
  },
};
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

  it("allows single-tenant builder/anonymous flows (same default app)", () => {
    expect(
      renderReadAllowed({ appId: "builder" }, ctx({ appId: "builder", authSource: "anonymous" }))
    ).toBe(true);
  });
});
