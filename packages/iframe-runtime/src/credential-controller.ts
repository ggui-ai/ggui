/**
 * The view's live credential and its one refresh (ggui#1496 part B,
 * runtime half).
 *
 * A view holds one live credential: the `wsToken` its token-bearing
 * transports carry (the WS subscribe, and the `sseUrl` / `pollingUrl`
 * query). When the server refuses it as expired, the view asks its host
 * to relay `ggui_runtime_refresh_ws_token`, the same `tools/call` relay the
 * bridge-pull rung uses, and adopts the fresh credential. This module owns
 * the credential and the budget; the runtime owns the ladders and tells it
 * when a credential expired or was accepted.
 *
 * The budget is one predicate per rung class:
 *   - On a token rung (a WS refusal, the polling 410, the boot): a credential
 *     that came back from a refresh and has NOT been accepted on a token rung
 *     is never refreshed again, whether it was refused or left the token
 *     rungs (the loop guard); any other expired credential gets exactly one
 *     refresh. A credential is marked spent when its refresh is REQUESTED, so
 *     triggers that fire together produce one request.
 *   - On the bridge rung (ggui#1734): no rung carries the credential there, so
 *     only the view's own clock can say it expired, and a relaying host's pull
 *     circuit half-opens only on a refresh the session grants. So the view
 *     asks again from the bridge whenever the current credential's `expiresAt`
 *     has passed and at least {@link BRIDGE_REFRESH_INTERVAL_MS} has passed
 *     since its last attempt on ANY rung — whatever that attempt answered,
 *     because the attempt that fails is the one inside the outage that opened
 *     the circuit. The interval is the storm bound, and it is the floor that
 *     keeps a view whose clock runs ahead of the server's from reading every
 *     fresh credential as expired.
 *
 * Expiry is always reported by the caller, from the slice's `expiresAt` or
 * from a refusal signal, never derived from a token's issue time: a
 * chained token can legitimately live less than a full TTL.
 */
import { withWsToken } from "@ggui-ai/protocol/integrations/mcp-apps";
import { DEFAULT_WS_TOKEN_TTL_SEC } from "@ggui-ai/protocol/transport/websocket";
import { unwrapCallToolResult } from "./call-tool-unwrap.js";
import { domainErrorCodeOf, isErrorToolResult, toolResultText } from "./tool-result-error.js";
import type { HeldCredential } from "./types.js";

export type { HeldCredential };

/** What reported the expiry. Every source but `boot` follows a drop. */
export type ExpirySource = "ws" | "polling" | "bridge" | "boot";

export type RefreshOutcome =
  | { readonly kind: "adopted"; readonly credential: HeldCredential }
  /** A plain refusal: `BOOTSTRAP_INVALID` or `BOOTSTRAP_NOT_SUPPORTED`, or any other code a server sends. */
  | { readonly kind: "refused"; readonly code: string }
  /** The session is gone, or not visible to the caller: the pull's own not-found. */
  | { readonly kind: "not-found" }
  /** The relay rejected the call, or answered something this reader does not recognise. */
  | { readonly kind: "relay-error"; readonly message: string }
  | { readonly kind: "skipped"; readonly reason: "budget" | "stale-ladder" };

/** The host's `tools/call` relay, bound by the runtime to the App's `callServerTool`. */
export type RefreshCallTool = (
  name: "ggui_runtime_refresh_ws_token",
  args: { readonly envelope: string }
) => Promise<unknown>;

export interface CredentialControllerOptions {
  readonly initial: HeldCredential;
  readonly callTool: RefreshCallTool;
  /** Called with each adopted credential, after it becomes current. */
  readonly onAdopt?: (credential: HeldCredential) => void;
  /** Test seam: defaults to a `setTimeout` wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam: defaults to `Math.random`. */
  readonly random?: () => number;
  /** Test seam: the view's clock, in ms; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface CredentialController {
  current(): HeldCredential;
  /** The credential was accepted on a token rung (a WS or SSE ack, or a polling `ok`). */
  markAccepted(credential: HeldCredential): void;
  /**
   * Whether a bridge pull should report `credential` expired now (ggui#1734):
   * it is the current credential, its `expiresAt` has passed by the view's
   * clock, and {@link BRIDGE_REFRESH_INTERVAL_MS} has passed since the last
   * refresh attempt on any rung (or there was none). A credential with no
   * `expiresAt` is never due.
   */
  dueOnBridge(credential: HeldCredential): boolean;
  /**
   * `credential` is the one the reporting ladder was built with. `retry`
   * re-sends the SAME request after a relay error, inside the one budgeted
   * refresh; a definitive answer is never retried.
   */
  onExpired(
    credential: HeldCredential,
    source: ExpirySource,
    retry?: RefreshRetry
  ): Promise<RefreshOutcome>;
}

/** How many times a refresh is re-sent after a relay error. */
export interface RefreshRetry {
  readonly retries: number;
}

/**
 * A server restart (close code 1012) drops every view at once, so a refresh after a drop
 * waits a uniform random delay up to this bound, spreading the burst at each
 * host's relay. A boot refresh is not synchronised and does not wait.
 */
export const REFRESH_JITTER_MAX_MS = 5_000;

/**
 * The boot refresh of a live-only slice is the view's only way to a live
 * channel, and so is a bridge-rung refresh (the ladder has left every token
 * rung), so a relay error on either (the host's relay failed, or the
 * server's store read threw) is re-sent this many times inside the one
 * attempt — before the boot reports `EXPIRED_BOOTSTRAP`, or before the bridge
 * waits out its next interval — each after a uniform random wait between
 * these bounds.
 */
export const REFRESH_RELAY_ERROR_RETRIES = 2;
export const REFRESH_RETRY_DELAY_MIN_MS = 1_000;
export const REFRESH_RETRY_DELAY_MAX_MS = 3_000;

/**
 * The bridge rung's attempt clock (ggui#1734): from the bridge, a view asks
 * for a refresh at most once per this span, counted from its last attempt on
 * any rung and whatever that attempt answered. It is the server's default
 * credential lifetime, the one number both readers share; a server that
 * mints longer-lived credentials slows the heartbeat through `expiresAt`, a
 * shorter-lived one does not speed it past this floor.
 */
export const BRIDGE_REFRESH_INTERVAL_MS = DEFAULT_WS_TOKEN_TTL_SEC * 1_000;

const REFRESH_TOOL = "ggui_runtime_refresh_ws_token";

export function createCredentialController(
  opts: CredentialControllerOptions
): CredentialController {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  let current = opts.initial;
  const spent = new Set<string>();
  const accepted = new Set<string>();
  /** The view's clock at the last refresh request, on any rung. */
  let lastAttemptAt: number | undefined;

  const expired = (credential: HeldCredential): boolean =>
    credential.expiresAt !== undefined && Date.parse(credential.expiresAt) <= now();
  const intervalPassed = (): boolean =>
    lastAttemptAt === undefined || now() - lastAttemptAt >= BRIDGE_REFRESH_INTERVAL_MS;

  const mayRefresh = (credential: HeldCredential, source: ExpirySource): boolean =>
    source === "bridge"
      ? expired(credential) && intervalPassed()
      : !spent.has(credential.wsToken) &&
        !(credential.origin === "refreshed" && !accepted.has(credential.wsToken));

  const requestRefresh = async (credential: HeldCredential): Promise<RefreshOutcome> => {
    let result: unknown;
    try {
      result = await opts.callTool(REFRESH_TOOL, { envelope: credential.wsToken });
    } catch (err) {
      return { kind: "relay-error", message: err instanceof Error ? err.message : String(err) };
    }
    return readRefreshResult(credential, result);
  };

  return {
    current: () => current,
    markAccepted(credential) {
      accepted.add(credential.wsToken);
    },
    dueOnBridge: (credential) => credential === current && mayRefresh(credential, "bridge"),
    async onExpired(credential, source, retry) {
      if (credential !== current) return { kind: "skipped", reason: "stale-ladder" };
      if (!mayRefresh(credential, source)) return { kind: "skipped", reason: "budget" };
      spent.add(credential.wsToken);
      lastAttemptAt = now();
      if (source !== "boot") await sleep(Math.floor(random() * REFRESH_JITTER_MAX_MS));
      let outcome = await requestRefresh(credential);
      for (let left = retry?.retries ?? 0; left > 0 && outcome.kind === "relay-error"; left--) {
        const spread = REFRESH_RETRY_DELAY_MAX_MS - REFRESH_RETRY_DELAY_MIN_MS;
        await sleep(REFRESH_RETRY_DELAY_MIN_MS + Math.floor(random() * spread));
        outcome = await requestRefresh(credential);
      }
      if (outcome.kind === "adopted") {
        current = outcome.credential;
        opts.onAdopt?.(outcome.credential);
      }
      return outcome;
    },
  };
}

function readRefreshResult(from: HeldCredential, result: unknown): RefreshOutcome {
  if (isErrorToolResult(result)) {
    // A thrown server error reaches the view as an error result whose text is
    // a domain error, exactly as the pull's not-found does.
    const text = toolResultText(result) ?? "";
    if (domainErrorCodeOf(result) === "session_not_found") return { kind: "not-found" };
    return {
      kind: "relay-error",
      message: text.length > 0 ? text : "refresh answered an error with no text",
    };
  }
  const payload = unwrapCallToolResult(result);
  if (payload !== null) {
    const ok = payload["ok"];
    const envelope = payload["envelope"];
    const expiresAt = payload["expiresAt"];
    if (
      ok === true &&
      typeof envelope === "string" &&
      envelope.length > 0 &&
      typeof expiresAt === "string"
    ) {
      return { kind: "adopted", credential: adopt(from, envelope, expiresAt) };
    }
    const code = payload["code"];
    if (ok === false && typeof code === "string") return { kind: "refused", code };
  }
  return {
    kind: "relay-error",
    message: "refresh answered a result this runtime does not recognise",
  };
}

/** The refreshed credential: the new token, its expiry, and each token-bearing URL re-derived for it. */
function adopt(from: HeldCredential, wsToken: string, expiresAt: string): HeldCredential {
  const sseUrl = from.sseUrl !== undefined ? withWsToken(from.sseUrl, wsToken) : undefined;
  const pollingUrl =
    from.pollingUrl !== undefined ? withWsToken(from.pollingUrl, wsToken) : undefined;
  return {
    wsToken,
    wsUrl: from.wsUrl,
    expiresAt,
    ...(sseUrl !== undefined ? { sseUrl } : {}),
    ...(pollingUrl !== undefined ? { pollingUrl } : {}),
    origin: "refreshed",
  };
}
