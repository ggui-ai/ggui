import type { HandlerContext } from "../types.js";

export type OpsBlueprintAppAccess =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "not_found" | "not_owner" };

export interface OpsBlueprintAppAuthorizer {
  (ctx: HandlerContext, appId: string): Promise<OpsBlueprintAppAccess>;
}

export class CrossAppCurationUnavailableError extends Error {
  readonly code = "cross_app_curation_unavailable" as const;
  constructor(toolName: string) {
    super(
      `${toolName}: cross_app_curation_unavailable — this deployment does not accept an appId different from the caller's bound app. Bind an app-access authorizer to enable cross-app curation.`
    );
    this.name = "CrossAppCurationUnavailableError";
  }
}

export class AppCurationDeniedError extends Error {
  readonly code = "app_curation_denied" as const;
  constructor(
    toolName: string,
    appId: string,
    readonly reason: "not_found" | "not_owner"
  ) {
    super(
      reason === "not_found"
        ? `${toolName}: app ${JSON.stringify(appId)} not found.`
        : `${toolName}: app ${JSON.stringify(appId)} is not curatable by this caller — variant curation is limited to the app's operator.`
    );
    this.name = "AppCurationDeniedError";
  }
}

export interface ResolveEffectiveAppIdArgs {
  readonly toolName: string;
  readonly inputAppId: string | undefined;
  readonly ctx: HandlerContext;
  readonly authorize?: OpsBlueprintAppAuthorizer;
}

/**
 * One resolution rule for the whole ops-blueprint family.
 *
 * Seam bound → the authorizer is the single authority on app access:
 * it is consulted on EVERY call (input omitted or equal included), so
 * fast paths live inside the deployment's authorizer where its trust
 * model is visible — never here.
 *
 * Seam unbound → legacy bound-only posture, fail closed on cross-app.
 */
export async function resolveEffectiveAppId(args: ResolveEffectiveAppIdArgs): Promise<string> {
  const { toolName, inputAppId, ctx, authorize } = args;
  const effective = inputAppId ?? (ctx.appId !== "" ? ctx.appId : undefined);
  if (effective === undefined) {
    throw new Error(
      `${toolName}: missing caller identity (appId empty) — bind an app identity or pass the appId input.`
    );
  }
  if (authorize !== undefined) {
    const access = await authorize(ctx, effective);
    if (!access.allowed) throw new AppCurationDeniedError(toolName, effective, access.reason);
    return effective;
  }
  if (inputAppId !== undefined && inputAppId !== ctx.appId) {
    throw new CrossAppCurationUnavailableError(toolName);
  }
  return effective;
}
