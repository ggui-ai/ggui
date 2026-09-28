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
 * The budget is one predicate:
 *   - a credential that came back from a refresh and has NOT been accepted
 *     on a token rung is never refreshed again, whether it was refused or
 *     left the token rungs (the loop guard);
 *   - any other expired credential gets exactly one refresh.
 * A credential is marked spent when its refresh is REQUESTED, so triggers
 * that fire together (a WS refusal, the polling 410, entering the bridge)
 * produce one request.
 *
 * Expiry is always reported by the caller, from the slice's `expiresAt` or
 * from a refusal signal, never derived from a token's issue time: a
 * chained token can legitimately live less than a full TTL.
 */
import { parseDomainErrorText } from "@ggui-ai/protocol";
import { withWsToken } from "@ggui-ai/protocol/integrations/mcp-apps";
import { unwrapCallToolResult } from "./call-tool-unwrap.js";
import type { HeldCredential } from "./types.js";

export type { HeldCredential };

/** What reported the expiry. Every source but `boot` follows a drop. */
export type ExpirySource = "ws" | "polling" | "bridge" | "boot";

export type RefreshOutcome =
  | { readonly kind: "adopted"; readonly credential: HeldCredential }
  /** A plain refusal: `BOOTSTRAP_INVALID`, `BOOTSTRAP_NOT_SUPPORTED`, or an N−1 server's `REFRESH_WINDOW_CLOSED`. */
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
}

export interface CredentialController {
  current(): HeldCredential;
  /** The credential was accepted on a token rung (a WS or SSE ack, or a polling `ok`). */
  markAccepted(credential: HeldCredential): void;
  /** `credential` is the one the reporting ladder was built with. */
  onExpired(credential: HeldCredential, source: ExpirySource): Promise<RefreshOutcome>;
}

/**
 * A server restart (close code 1012) drops every view at once, so a refresh after a drop
 * waits a uniform random delay up to this bound, spreading the burst at each
 * host's relay. A boot refresh is not synchronised and does not wait.
 */
export const REFRESH_JITTER_MAX_MS = 5_000;

const REFRESH_TOOL = "ggui_runtime_refresh_ws_token";

export function createCredentialController(
  opts: CredentialControllerOptions
): CredentialController {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  let current = opts.initial;
  const spent = new Set<string>();
  const accepted = new Set<string>();

  const mayRefresh = (credential: HeldCredential): boolean =>
    !spent.has(credential.wsToken) &&
    !(credential.origin === "refreshed" && !accepted.has(credential.wsToken));

  return {
    current: () => current,
    markAccepted(credential) {
      accepted.add(credential.wsToken);
    },
    async onExpired(credential, source) {
      if (credential !== current) return { kind: "skipped", reason: "stale-ladder" };
      if (!mayRefresh(credential)) return { kind: "skipped", reason: "budget" };
      spent.add(credential.wsToken);
      if (source !== "boot") await sleep(Math.floor(random() * REFRESH_JITTER_MAX_MS));
      let result: unknown;
      try {
        result = await opts.callTool(REFRESH_TOOL, { envelope: credential.wsToken });
      } catch (err) {
        return { kind: "relay-error", message: err instanceof Error ? err.message : String(err) };
      }
      const outcome = readRefreshResult(credential, result);
      if (outcome.kind === "adopted") {
        current = outcome.credential;
        opts.onAdopt?.(outcome.credential);
      }
      return outcome;
    },
  };
}

/** The text of a tool result's first text block, if it has one. */
function firstText(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null) return undefined;
  const text = Reflect.get(first, "text");
  return typeof text === "string" ? text : undefined;
}

function readRefreshResult(from: HeldCredential, result: unknown): RefreshOutcome {
  const isError =
    typeof result === "object" && result !== null && Reflect.get(result, "isError") === true;
  if (isError) {
    // A thrown server error reaches the view as an error result whose text is
    // a domain error, exactly as the pull's not-found does.
    const text = firstText(result) ?? "";
    if (parseDomainErrorText(text)?.code === "session_not_found") return { kind: "not-found" };
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
