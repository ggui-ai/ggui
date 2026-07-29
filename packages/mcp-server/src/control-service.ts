/**
 * `/control` — the control plane.
 *
 * ggui serves exactly TWO MCP surfaces:
 *
 *   - **Data plane** — the agent routes (`universalMcpPath`, plus the
 *     per-tenant `${pathPrefix}/:appId` variant when configured). Carries
 *     the `agent` + `runtime` audiences: the tools an agent calls while a
 *     session is running.
 *   - **Control plane** — this service. Carries the `protocol` + `ops`
 *     audiences: design-time spec/discovery (anonymous) and operator-class
 *     account management (authenticated, state-changing calls
 *     confirm-gated).
 *
 * Audience TAGS stay normative — `audience` on a handler still declares
 * its caller class, and the `ggui_protocol_*` / `ggui_ops_*` wire-name
 * prefixes still encode it. What this module retires is one-HTTP-route-
 * per-audience MOUNTING: `protocol` and `ops` land on the same path.
 *
 * WHY one route for two audiences: an HTTP route carries ONE auth
 * posture. Design-time spec tools must answer bearer-less (an agent
 * authoring a blueprint has no account yet); operator tools must not.
 * Two routes forced a deployment to choose per route, which is why the
 * two surfaces could never be pointed at by a single client config. A
 * service mount is the seam that mixes both: the route is anonymous-
 * capable, and each ops handler re-imposes auth for itself.
 *
 * The per-tool wrappers, in application order (innermost first):
 *
 *   1. {@link withConfirmGate} — state-changing ops only. Turns one
 *      call into a deliberate two-call sequence so an agent cannot
 *      silently mint credentials, spend credits, or delete resources.
 *   2. {@link withAuthGate} — every ops tool. Rejects callers the auth
 *      adapter never authenticated (the anonymous synthetic), so an ops
 *      handler never runs against a phantom identity.
 *   3. {@link stripAudience} — every tool. Service handlers MUST NOT
 *      carry an `audience` tag (the mount path IS the audience); the tag
 *      is consumed by the data-plane route filter and is meaningless
 *      inside a service, so dropping it is lossless.
 *
 * Ordering matters: the auth gate sits OUTSIDE the confirm gate, so an
 * unauthenticated caller gets an auth error rather than a confirmation
 * preview that leaks which operations exist against which account.
 */
import {
  AuthRequiredError,
  type HandlerContext,
  type SharedHandler,
} from "@ggui-ai/mcp-server-handlers";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { McpService } from "./mcp-mounts.js";

type AnyHandler = SharedHandler<ZodRawShape, ZodRawShape>;

/** Every audience tag a handler may declare. */
export type AudienceTag = "agent" | "runtime" | "protocol" | "ops";

/** HTTP path the control plane mounts at. */
export const CONTROL_PATH = "/control";

/** Service name the control plane reports in validation errors + telemetry. */
export const CONTROL_SERVICE_NAME = "control";

/** Audiences the data plane (agent routes) serves. */
export const DATA_PLANE_AUDIENCES: ReadonlyArray<AudienceTag> = ["agent", "runtime"];

/** Audiences the control plane serves. */
export const CONTROL_PLANE_AUDIENCES: ReadonlyArray<AudienceTag> = ["protocol", "ops"];

/**
 * Return the subset of `set` whose `audience` tag intersects `allowed`.
 * The single projection from audience tags to mount surfaces — both
 * planes read it, so a handler can never land on both or on neither.
 *
 * Handlers with `audience: undefined` default to `['agent']`: an
 * untagged handler is agent-callable, which keeps zero-config OSS
 * deployments (whose handlers rarely tag anything) on the data plane.
 */
export function filterHandlersByAudience(
  set: ReadonlyArray<AnyHandler>,
  allowed: ReadonlyArray<AudienceTag>
): ReadonlyArray<AnyHandler> {
  return set.filter((h) => {
    const tags = h.audience ?? (["agent"] as const);
    return tags.some((t) => allowed.includes(t));
  });
}

/**
 * Ops tools that answer in ONE call — reads, lists, and card-openers
 * that change no state. Every other `ops`-tagged tool is treated as
 * state-changing and confirm-gated.
 *
 * The classification is default-DENY on purpose. A curated
 * "these ones are mutating" list has a silent failure mode: land a new
 * state-changing ops tool, forget the list, and it ships un-gated with
 * nothing to notice. Inverting it makes the forgotten case a visible
 * annoyance (an extra confirmation round-trip on a read) instead of an
 * invisible hole, which is the trade the Protocol and Contract Bar asks
 * for — an unflagged gap is a failure in disguise.
 *
 * Deployments that register their own read-only ops tools extend this
 * via `CreateGguiServerOptions.control.singleCallOps` rather than
 * patching this set.
 *
 * `ggui_ops_setup_byok` is a deliberate entry: it LISTS provider-key
 * status and returns the BYOK card — the set/remove tools are the real
 * mutations. Confirm-gating it would break the card's inline render on
 * the first call, because the confirmation preview does not carry the
 * card's discriminant.
 */
export const SINGLE_CALL_OPS: ReadonlySet<string> = new Set<string>([
  "ggui_ops_get_credit_balance",
  "ggui_ops_get_my_blueprint_source",
  "ggui_ops_get_org_balance",
  "ggui_ops_list_apps",
  "ggui_ops_list_blueprints",
  "ggui_ops_list_connector_keys",
  "ggui_ops_list_credit_transactions",
  "ggui_ops_list_my_apps",
  "ggui_ops_list_my_blueprints",
  "ggui_ops_list_orgs",
  "ggui_ops_list_provider_keys",
  "ggui_ops_setup_byok",
]);

/**
 * Return a copy of the handler with the `audience` tag removed.
 * `validateMcpServices` rejects service handlers that carry one.
 */
export function stripAudience<I extends ZodRawShape, O extends ZodRawShape, D>(
  h: SharedHandler<I, O, D>
): SharedHandler<I, O, D> {
  const { audience: _omit, ...rest } = h;
  return rest;
}

/**
 * Require an authenticated caller.
 *
 * The control plane is anonymous-CAPABLE so design-time spec tools
 * answer bearer-less. In that mode the transport synthesizes a builder
 * identity (`authSource: 'anonymous'`) for requests that presented no
 * credential — or presented one the adapter rejected. An un-gated ops
 * handler would then run against that synthetic rather than refusing,
 * which is how a caller with no account would read and write a phantom
 * shared tenant.
 *
 * The gate is on `ctx.authSource`, not on which identity FIELDS are
 * populated: every deployment tier proves identity differently
 * (single-user builder, per-app key, per-user key, OIDC), and only the
 * source distinguishes "the adapter authenticated this request" from
 * "the transport let it through". Transports map
 * {@link AuthRequiredError} to 401 so clients can prompt for sign-in.
 */
export function withAuthGate<I extends ZodRawShape, O extends ZodRawShape, D>(
  h: SharedHandler<I, O, D>
): SharedHandler<I, O, D> {
  return {
    ...h,
    async handler(input: Record<string, unknown>, ctx: HandlerContext): Promise<D> {
      if (ctx.authSource === undefined || ctx.authSource === "anonymous") {
        throw new AuthRequiredError(
          `${h.name} is an operator tool and needs an authenticated caller. Present a bearer token this deployment accepts.`
        );
      }
      return h.handler(input, ctx);
    },
  };
}

/** Map every field of a Zod raw-shape to its `.optional()` form. */
function optionalize(shape: ZodRawShape): ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [key, (value as ZodTypeAny).optional()])
  );
}

/**
 * Wrap a state-changing handler in a stateless two-call confirmation
 * gate. The first call (no `confirm: true`) returns a preview and runs
 * nothing; a second call carrying `confirm: true` delegates to the
 * inner handler.
 *
 * The `confirm` input field and the confirmation output fields live
 * only on this wrapper — the underlying shared handler is untouched, so
 * neither the field nor its `.describe()` text reaches any other
 * caller of the same handler.
 *
 * The declared output schema is the inner schema with every field made
 * optional, PLUS the confirmation fields, so both the preview (only
 * confirmation fields) and a real commit response (inner fields)
 * validate against it.
 */
export function withConfirmGate<I extends ZodRawShape, O extends ZodRawShape, D>(
  h: SharedHandler<I, O, D>
): SharedHandler<ZodRawShape, ZodRawShape> {
  const inputSchema: ZodRawShape = {
    ...h.inputSchema,
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Set true to actually perform this state-changing operation. Omitted/false returns a confirmation preview instead."
      ),
  };
  const outputSchema: ZodRawShape = {
    ...optionalize(h.outputSchema),
    confirmationRequired: z.boolean().optional(),
    confirmationPrompt: z.string().optional(),
  };
  return {
    ...h,
    description: `${h.description} (State-changing: the first call returns a confirmation prompt; re-call with confirm:true to proceed.)`,
    inputSchema,
    outputSchema,
    async handler(input: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> {
      if (input.confirm !== true) {
        return {
          confirmationRequired: true,
          confirmationPrompt: `Calling ${h.name} will change account state. Show the human exactly what will happen and, only with their explicit approval, call ${h.name} again with confirm:true.`,
        };
      }
      const { confirm: _confirm, ...rest } = input;
      return h.handler(rest, ctx);
    },
  };
}

export interface BuildControlServiceArgs {
  /**
   * The server's fully composed handler list. The control plane filters
   * it by audience itself, so callers hand over the same array the data
   * plane reads — membership can never drift between the two.
   */
  readonly handlers: ReadonlyArray<AnyHandler>;
  /**
   * Additional ops tool names that answer in one call. Merged with
   * {@link SINGLE_CALL_OPS}; use it for deployment-registered read-only
   * ops tools that would otherwise be confirm-gated by the default-deny
   * rule.
   */
  readonly singleCallOps?: ReadonlyArray<string>;
}

/**
 * Assemble the control plane: every `protocol`-tagged handler served
 * as-is (anonymous), every `ops`-tagged handler auth-gated and — unless
 * it is a known single-call read — confirm-gated.
 *
 * Always `anonymous: true`: the route must answer bearer-less for the
 * design-time tools, and the per-handler auth gate is what keeps the
 * ops half closed.
 */
export function buildControlService(args: BuildControlServiceArgs): McpService {
  const singleCall = new Set<string>([...SINGLE_CALL_OPS, ...(args.singleCallOps ?? [])]);
  const protocolTools = filterHandlersByAudience(args.handlers, ["protocol"]);
  const opsTools = filterHandlersByAudience(args.handlers, ["ops"]);

  const handlers: AnyHandler[] = [
    ...protocolTools.map((h) => stripAudience(h)),
    ...opsTools.map((h) => {
      const confirmed = singleCall.has(h.name) ? h : withConfirmGate(h);
      return stripAudience(withAuthGate(confirmed));
    }),
  ];

  return {
    name: CONTROL_SERVICE_NAME,
    path: CONTROL_PATH,
    handlers,
    anonymous: true,
  };
}
