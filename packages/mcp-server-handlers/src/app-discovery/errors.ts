/**
 * Typed errors thrown by app-discovery handlers.
 *
 * Lives alongside the handlers (not in `@ggui-ai/protocol`) for the
 * same reason `renders/errors.ts` does — these are
 * handler-flow diagnostics, not contract-shape violations.
 */

/**
 * Thrown by `ggui_list_gadgets` (and any future tenant-
 * scoped app-discovery tool) when the caller supplies an explicit
 * `appId` that does NOT match `ctx.appId` resolved by the upstream
 * auth adapter. Cross-tenant probes get a uniform error so the
 * existence of an alternate `appId` is not leaked.
 *
 * Recovery: omit `appId` to default to `ctx.appId`, or call from a
 * deployment where the caller's identity resolves to the requested
 * app.
 */
export class AppAccessDeniedError extends Error {
  readonly code = "app_access_denied" as const;
  constructor(message?: string) {
    super(
      message ??
        "app_access_denied: the supplied appId does not match the caller identity. Omit the appId field to default to the caller-resolved app, or invoke from a deployment whose auth resolves to the requested app."
    );
    this.name = "AppAccessDeniedError";
  }
}
