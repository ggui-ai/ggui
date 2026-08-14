import { describe, expect, it, vi } from "vitest";
import type { HandlerContext } from "../types.js";
import {
  AppAccessDeniedError,
  CrossAppCurationUnavailableError,
  resolveEffectiveAppId,
  type OpsBlueprintAppAuthorizer,
} from "./app-access.js";

function ctx(appId: string): HandlerContext {
  return { appId, requestId: "req-1" };
}
const allow: OpsBlueprintAppAuthorizer = vi.fn(async () => ({ allowed: true as const }));

describe("resolveEffectiveAppId", () => {
  it("throws the missing-identity error naming the appId input when neither source is set", async () => {
    await expect(
      resolveEffectiveAppId({
        toolName: "t",
        inputAppId: undefined,
        ctx: ctx(""),
        authorize: allow,
      })
    ).rejects.toThrow(/missing caller identity.*appId input/i);
  });

  it("seam bound: calls the authorizer on EVERY resolution, including omitted input", async () => {
    const authorize = vi.fn(async () => ({ allowed: true as const }));
    const out = await resolveEffectiveAppId({
      toolName: "t",
      inputAppId: undefined,
      ctx: ctx("app-1"),
      authorize,
    });
    expect(out).toBe("app-1");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ appId: "app-1" }), "app-1");
  });

  it("seam bound: calls the authorizer when input equals ctx.appId", async () => {
    const authorize = vi.fn(async () => ({ allowed: true as const }));
    await resolveEffectiveAppId({
      toolName: "t",
      inputAppId: "app-1",
      ctx: ctx("app-1"),
      authorize,
    });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("seam bound: denied not_found and not_owner carry distinct messages", async () => {
    const notFound: OpsBlueprintAppAuthorizer = async () => ({
      allowed: false,
      reason: "not_found",
    });
    const notOwner: OpsBlueprintAppAuthorizer = async () => ({
      allowed: false,
      reason: "not_owner",
    });
    const err1 = await resolveEffectiveAppId({
      toolName: "t",
      inputAppId: "x",
      ctx: ctx(""),
      authorize: notFound,
    }).catch((e: unknown) => e);
    const err2 = await resolveEffectiveAppId({
      toolName: "t",
      inputAppId: "x",
      ctx: ctx(""),
      authorize: notOwner,
    }).catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(AppAccessDeniedError);
    expect(err2).toBeInstanceOf(AppAccessDeniedError);
    expect((err1 as Error).message).not.toBe((err2 as Error).message);
  });

  it("seam UNBOUND: bound-only legacy posture — ctx.appId proceeds, equal input proceeds", async () => {
    await expect(
      resolveEffectiveAppId({ toolName: "t", inputAppId: undefined, ctx: ctx("app-1") })
    ).resolves.toBe("app-1");
    await expect(
      resolveEffectiveAppId({ toolName: "t", inputAppId: "app-1", ctx: ctx("app-1") })
    ).resolves.toBe("app-1");
  });

  it("seam UNBOUND: differing explicit appId fails closed with the named code", async () => {
    const err = await resolveEffectiveAppId({
      toolName: "t",
      inputAppId: "other",
      ctx: ctx("app-1"),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossAppCurationUnavailableError);
    expect((err as CrossAppCurationUnavailableError).code).toBe("cross_app_curation_unavailable");
  });
});
