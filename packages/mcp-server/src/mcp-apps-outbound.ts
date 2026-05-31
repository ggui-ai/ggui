/**
 * MCP Apps outbound wiring — the server-side half of the
 * `ggui_render -> ui://ggui/render -> iframe -> live channel` delivery path.
 *
 * Responsibilities of this module (and nothing else):
 *
 *   1. Advertise the `io.modelcontextprotocol/ui` capability on every
 *      fresh `McpServer` instance so MCP Apps hosts know the server
 *      speaks the UI extension.
 *   2. Register `ui://ggui/render` as a static resource servable via
 *      MCP `resources/read`. The resource body is the thin-shell HTML
 *      hosts sandbox-render when they see `_meta.ui.resourceUri` on a
 *      `ggui_render` result.
 *
 * Boundary discipline:
 *
 *   - This module imports from `@ggui-ai/protocol/integrations/mcp-apps`
 *     (the subpath). It does NOT expose MCP-Apps-specific shapes back
 *     into `build-mcp.ts`, `server.ts`, or the blueprint handlers.
 *   - Capability advertisement and resource registration are the ONLY
 *     server-wide concerns here. Bootstrap-token mint + live-channel
 *     bootstrap-auth live in separate slices of the same overall
 *     outbound path.
 *
 * Why the shell body lives here:
 *
 *   The thin shell is static content; it depends on nothing except the
 *   MIME constant and the HTML. Keeping it next to the registration
 *   means a future refactor of the shell edits one file. The
 *   `@ggui-ai/react` package does NOT ship the shell as a separate
 *   build target — per the design lock, the shell is served by the
 *   same `@ggui-ai/mcp-server` instance that mints the bootstrap.
 */

import type {
  BlueprintIndex,
  RenderStore,
  VectorStore,
} from "@ggui-ai/mcp-server-core";
import {
  deriveBundleOrigins,
  deriveContractBundle,
  derivePublicEnvProjection,
  deriveRenderMeta,
  findBlueprintExact,
  type Blueprint,
} from "@ggui-ai/mcp-server-handlers/renders";
import type { Render } from "@ggui-ai/protocol";
import { deriveContextDefault, type ContextSpec } from "@ggui-ai/protocol";
import {
  GGUI_RENDER_RESOURCE_MIME,
  GGUI_RENDER_RESOURCE_URI,
  MCP_APPS_UI_CAPABILITY,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  deriveContextName,
  type McpAppAiGguiRenderMeta,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { createHash } from "node:crypto";

/**
 * Thin-shell body served from `ui://ggui/render` (C8 pivot).
 *
 * **Architectural role.** The shell is a ~30 LOC bootstrap wrapper -
 * it runs a minimal `ui/initialize` preflight to read the
 * `ai.ggui/render.runtimeUrl` slice field, then dynamic-script-loads
 * the `@ggui-ai/iframe-runtime` bundle from that URL. Every rendering
 * concern - WS open, subscribe, render mount, component code eval,
 * adapter install - belongs to the renderer bundle (shipped C7a-d),
 * not here.
 *
 * **Why bootstrap-driven URL.** `srcdoc` iframes have `about:srcdoc`
 * as their URL, so relative paths can't resolve to the MCP server's
 * HTTP listener. The server-controlled `runtimeUrl` lands on the
 * `ai.ggui/render.runtimeUrl` slice field and the shell picks it up
 * from the first `ui/initialize` response - origin-agnostic, works
 * under OSS same-origin AND hosted-cloud CDN deployments.
 *
 * **Why `<script type="module">`.** `@ggui-ai/iframe-runtime` is bundled as
 * ESM (its own runtime.ts:5 declares the contract: "the thin-shell
 * HTML loads it via `<script type="module" src=".../renderer.js">`").
 * Loading the bundle as a classic `<script src=...>` throws
 * `SyntaxError: Unexpected token 'export'` synchronously when the
 * browser parses the bundle - the renderer never executes, the
 * lifecycle never advances past `mounting`, and any host-side spec
 * pinning `data-ggui-mcp-app-iframe-lifecycle="code-ready"` hangs
 * to timeout. The shell honours the renderer's published contract by
 * setting `s.type='module'` before assigning `s.src`.
 *
 * **Failure envelope (C8 Deliverable 4).** Pre-renderer failures
 * surface to the parent via
 * `postMessage({type:'ggui:bootstrap-failed', reason, message}, '*')`:
 *
 *   - `BOOTSTRAP_META_MISSING` - `ui/initialize` returned without a
 *     valid `ai.ggui/render` slice OR without a `runtimeUrl` field on
 *     it.
 *   - `BUNDLE_FETCH_FAILED` - `<script src>` errored (network failure,
 *     404, CSP reject with an observable `error` event).
 *
 * Post-renderer failures (WS handshake / auth / session-mismatch) are
 * the renderer bundle's responsibility - `runtime.ts::postBootFailure`
 * emits the same `ggui:bootstrap-failed` envelope AND, for post-WS-open
 * failures, a `_ggui:contract-error` envelope on the live channel per
 * `ContractErrorCode` additions (C8 Commit 1/3).
 *
 * **Adapter boundary unchanged.** The preflight's `message` listener
 * routes ONLY responses to its own pending JSON-RPC ids. MCP Apps
 * lifecycle notifications from the host (`ui/notifications/message`,
 * `ui/update-model-context`) are dropped. This mirrors the pre-C8
 * posture - the shell still MUST NOT mutate session state from
 * arbitrary host messages. ADAPTER BOUNDARY enforced by the
 * `pending[m.id]` route-by-id check.
 *
 * **Double `ui/initialize` is intentional.** The shell runs a minimal
 * preflight solely to fetch `runtimeUrl`; the renderer bundle's
 * autostart path runs its own `ui/initialize` for the full bootstrap
 * parse. MCP Apps hosts handle repeats idempotently - the preflight's
 * cost is a single postMessage round-trip.
 *
 * Exported as a string constant for tests; not part of the public
 * package API. Vanilla JS, no build step, no external deps. The shell
 * must work in any browser that implements MCP Apps; no modern-ES
 * features.
 */
/**
 * Inline body of the thin shell's bootstrap `<script>` block.
 *
 * Split from {@link GGUI_SESSION_SHELL_HTML} so the exact bytes the
 * browser sees inside the `<script>...</script>` tag are addressable
 * for CSP-hash purposes — see {@link GGUI_SESSION_SHELL_SCRIPT_HASH}.
 *
 * The browser's CSP `'sha256-...'` source-expression is computed over
 * the literal text content of the `<script>` element (everything
 * between the opening and closing tags, including leading and trailing
 * whitespace inside). Concatenating this constant unchanged into the
 * shell HTML means the runtime hash and the constant-time hash agree.
 *
 * NEVER mutate this constant without also bumping
 * {@link GGUI_SESSION_SHELL_SCRIPT_HASH} — the
 * `mcp-apps-outbound.test.ts` drift test recomputes the hash and fails
 * loudly if they diverge.
 */
const GGUI_RENDER_SHELL_SCRIPT_BODY = `
(function(){'use strict';
// MCP Apps shell. Speaks the canonical postMessage protocol from
// @modelcontextprotocol/ext-apps:
//   1. iframe -> host: ui/initialize
//   2. iframe -> host: ui/notifications/initialized
//   3. host -> iframe: ui/notifications/tool-result (per CallToolResult)
// On tool-result, read the slice envelope from _meta (spec-canonical
// CallToolResult _meta at the top level, or the first-party
// params.toolOutput._meta shape), set window.__GGUI_META__ to the
// envelope, fetch runtime as blob, inject as script.
// Runtime auto-mounts inline. No nested iframe (claudemcpcontent.com
// CSP frame-src forbids cross-origin frames). State machine matches
// buildSelfContainedShell so the same runtime mounts both paths.
//
// R5 (2026-05-26): the historic /r/<shortCode> HTTP fallback was
// removed along with the bearer-by-obscurity model -- hosts that strip
// _meta no longer have a recovery path here. Spec-canonical hosts
// deliver _meta inline and are unaffected.
//
// Phase B (2026-05-27): the historic two-slice envelope
// (\`ai.ggui/session\` + \`ai.ggui/stack-item\`) collapsed to ONE flat
// \`ai.ggui/render\` slice. runtimeUrl now lives directly on the
// render slice; renderId is the canonical identity.
var rpcId=1,pending={};
var rootEl=document.getElementById('ggui-root');
rootEl.style.cssText='display:flex;flex-direction:column;height:100%;min-height:300px;margin:0';
var mounted=false;
function setOverlay(text){
  if(mounted)return;
  rootEl.innerHTML='<div style="font:14px system-ui,sans-serif;padding:24px;color:#666">'+text+'</div>';
}
function postNotification(method,params){
  try{window.parent.postMessage({jsonrpc:'2.0',method:method,params:params||{}},'*');}catch(e){}
}
function postRpc(method,params){
  return new Promise(function(res,rej){
    var id=rpcId++;pending[id]={res:res,rej:rej};
    try{window.parent.postMessage({jsonrpc:'2.0',id:id,method:method,params:params||{}},'*');}
    catch(e){delete pending[id];rej(e);}
  });
}
function postBootstrapFailed(reason,message){
  // Surface every shell-layer bootstrap-failure path as a typed
  // RendererBootFailedMessage envelope so hosts pinning the C9
  // error pane (McpAppIframe onError, IframeErrorPane) see the
  // failure instead of staring at the inert overlay until the test
  // times out. Reason codes match BootstrapFailureReason.
  try{window.parent.postMessage({type:'ggui:bootstrap-failed',reason:reason,message:message},'*');}catch(e){}
}
async function mountFromMeta(envelope){
  if(mounted)return;
  // Slice envelope shape (Phase B): { "ai.ggui/render": { renderId,
  // appId, runtimeUrl, ... } }. runtimeUrl on the render slice is
  // the only load-bearing field at the shell layer — it tells us
  // which iframe-runtime bundle to fetch. Everything else is
  // optional; the runtime decides at boot time based on the meta
  // it reads from window.__GGUI_META__.
  var renderSlice=envelope&&envelope['ai.ggui/render'];
  var runtimeUrl=renderSlice&&renderSlice.runtimeUrl;
  if(!envelope||typeof runtimeUrl!=='string'){
    setOverlay('Bootstrap payload malformed.');
    postBootstrapFailed('BOOTSTRAP_MALFORMED','Bootstrap payload malformed.');
    return;
  }
  setOverlay('Loading UI…');
  window.__GGUI_META__=envelope;
  // Load the runtime bundle via a direct cross-origin script tag
  // (governed by CSP script-src) instead of fetch + Blob (governed by
  // CSP connect-src). claude.ai's claudemcpcontent.com iframe CSP
  // forbids cross-origin connect-src so fetch throws TypeError
  // 'Failed to fetch', but allows cross-origin script-src when the
  // bundle responds with the right CORS headers (the iframe-runtime
  // mount sets them). The self-contained shell already uses this
  // pattern; legacy postMessage shell now matches it.
  try{
    var s=document.createElement('script');
    s.type='module';
    // crossorigin=anonymous opts into CORS-mode error reporting.
    // Without it, cross-origin script tags get a sanitized
    // "script error" with no details, masking the real cause
    // (CSP block, CORS reject, module-evaluation throw). With it,
    // the error event surfaces the actual message in the iframe
    // console -- the bundle ships ACAO=* so credentialed mode is
    // unnecessary.
    s.crossOrigin='anonymous';
    s.src=runtimeUrl;
    s.onload=function(){mounted=true;};
    s.onerror=function(e){
      var msg='Runtime bundle failed to load: '+(e&&e.message||'script error');
      setOverlay(msg);
      postBootstrapFailed('BUNDLE_FETCH_FAILED',msg);
    };
    rootEl.innerHTML='';
    document.body.appendChild(s);
  }catch(e){
    var msg='Runtime bundle failed to load: '+(e&&e.message||e);
    setOverlay(msg);
    postBootstrapFailed('BUNDLE_FETCH_FAILED',msg);
  }
}
function readMetaFromInitResult(result){
  if(!result||typeof result!=='object')return null;
  var toolOutput=result.toolOutput;
  if(!toolOutput||typeof toolOutput!=='object')return null;
  var meta=toolOutput._meta;
  if(!meta||typeof meta!=='object')return null;
  // Single slice-envelope key (Phase B: ai.ggui/render). Only the
  // render slice's runtimeUrl is load-bearing at the shell layer;
  // the runtime reads everything else off window.__GGUI_META__
  // after we set it.
  var renderSlice=meta['ai.ggui/render'];
  if(!renderSlice||typeof renderSlice!=='object')return null;
  if(typeof renderSlice.runtimeUrl!=='string')return null;
  return meta;
}
function hasAiGguiMetaPlaceholder(result){
  // Detect the protocol-violation case where the host signaled
  // "I tried to deliver meta" (toolOutput._meta carries an
  // ai.ggui/render key) but it's malformed. Fail-fast with
  // BOOTSTRAP_META_MISSING rather than waiting forever.
  if(!result||typeof result!=='object')return false;
  var toolOutput=result.toolOutput;
  if(!toolOutput||typeof toolOutput!=='object')return false;
  var meta=toolOutput._meta;
  if(!meta||typeof meta!=='object')return false;
  return 'ai.ggui/render' in meta;
}
function readMetaFromCallToolResult(params){
  // MCP Apps spec (specification/2026-01-26/apps.mdx:1145-1155):
  //   ui/notifications/tool-result
  //   params: CallToolResult  // Standard MCP type
  // So params IS the CallToolResult and _meta lives at the top
  // level (NOT under params.toolOutput, which is where the
  // first-party McpAppIframe convention wraps it). Spec-compliant
  // hosts (Claude Desktop, claude.ai Connector, Claude Code) deliver
  // slice-envelope material here.
  if(!params||typeof params!=='object')return null;
  var meta=params._meta;
  if(!meta||typeof meta!=='object')return null;
  var renderSlice=meta['ai.ggui/render'];
  if(!renderSlice||typeof renderSlice!=='object')return null;
  if(typeof renderSlice.runtimeUrl!=='string')return null;
  return meta;
}
window.addEventListener('message',function(ev){
  var m=ev&&ev.data;
  if(!m||m.jsonrpc!=='2.0')return;
  if(m.id!=null&&pending[m.id]){
    var p=pending[m.id];delete pending[m.id];
    if(m.error)p.rej(m.error);else p.res(m.result);
    return;
  }
  if(m.method==='ui/notifications/tool-result'){
    // Spec-compliant hosts: m.params IS the CallToolResult; _meta is
    // at the top level. Try this FIRST so Claude Desktop / claude.ai
    // Connector / Claude Code land here.
    var specB=readMetaFromCallToolResult(m.params);
    if(specB){mountFromMeta(specB);return;}
    // First-party McpAppIframe convention: slice envelope nested under
    // params.toolOutput._meta. First-party hosts (Studio, Portal,
    // console) use this shape for both init-response and post-init
    // notification.
    var bb=readMetaFromInitResult(m.params);
    if(bb){mountFromMeta(bb);return;}
    // R5 (2026-05-26) -- the /r/<shortCode> HTTP fallback was removed
    // along with the bearer-by-obscurity model. Hosts that strip
    // _meta on the tool-result wire have no fallback path here;
    // spec-canonical hosts deliver meta inline and land in the two
    // branches above.
  }
});
setOverlay('Initializing…');
var initTimer=setTimeout(function(){
  setOverlay('Host did not respond to ui/initialize within 3s.');
},3000);
postRpc('ui/initialize',{
  appCapabilities:{},
  appInfo:{name:'ggui-session',version:'1.0.0'},
  protocolVersion:'2026-01-26'
}).then(function(result){
  clearTimeout(initTimer);
  postNotification('ui/notifications/initialized',{});
  // Path B: slice envelope inline in ui/initialize result. Hosts
  // using <McpAppIframe>'s first-party dispatch deliver meta here
  // and never send a separate ui/notifications/tool-result.
  var b=readMetaFromInitResult(result);
  if(b){mountFromMeta(b);return;}
  // Protocol-violation surface: host signalled an attempt
  // (toolOutput._meta carries ai.ggui/render) but it's malformed.
  // Fail fast so hosts pinning a typed error envelope don't sit on
  // the Path-A waiting overlay forever.
  if(hasAiGguiMetaPlaceholder(result)){
    var msg='ui/initialize result missing valid ai.ggui/render.runtimeUrl';
    setOverlay(msg);
    postBootstrapFailed('BOOTSTRAP_META_MISSING',msg);
    return;
  }
  // Path A: wait for the host to send ui/notifications/tool-result
  // with structuredContent.{url, shortCode}. MCP Apps hosts that don't
  // implement the reading-B inline-meta convention land here.
  setOverlay('Waiting for tool result…');
}).catch(function(e){
  clearTimeout(initTimer);
  setOverlay('ui/initialize failed: '+(e&&e.message||JSON.stringify(e)));
});
})();
`;

// `--ggui-color-surface` is injected at `:root` on this document's
// `<head>` by the iframe-runtime at boot (react-renderer.ts ->
// `<style id="ggui-theme-vars">`), so the `var()` resolves to the
// active theme's exact per-mode surface color at runtime. The static
// `#1e293b` fallback (the dark-mode surface) covers the pre-resolve
// first paint + browsers that drop unresolved custom properties.
//
// # Why paint the document background here (Safari white-canvas fix)
//
// This shell is ALWAYS the **top-level document of a standalone served
// iframe** (`ui://ggui/render`, the `/r/<shortCode>` viewer, the
// sandbox-proxy inner-iframe `srcdoc`). It is NEVER inlined into a host
// page — the host wrapper (`<McpAppIframe>`) only ever loads it AS an
// iframe document, never as part of its own DOM. So painting `html` /
// `body` here is structurally unreachable by inline embedding and
// cannot impose a background on a host page.
//
// The design scope root (`.ggui-rcr-*`) and the sandbox-proxy outer
// document stay `background-color: transparent` by design (so a host
// themeing the chat surface shows through AROUND the rendered content).
// But nothing painted the rendered-content document's OWN backdrop:
// Chrome composited the transparent iframe document over the dark host
// app behind it (looked dark), while Safari renders a transparent
// iframe document's backdrop as the opaque UA `Canvas` color (white) —
// the per-browser divergence the bug reported. The component itself
// themed correctly (its scoped vars resolve); only the page behind it
// diverged. Painting the served document's own surface here removes the
// dependency on a browser honoring iframe transparency.
//
// Value-resolution only — no `--ggui-*` token added or renamed.
const GGUI_RENDER_SHELL_SURFACE = `var(--ggui-color-surface, #1e293b)`;

export const GGUI_RENDER_SHELL_HTML = `<!doctype html>
<html lang="en" style="height:100%;background-color:${GGUI_RENDER_SHELL_SURFACE}"><head><meta charset="utf-8"><title>ggui render</title></head>
<body style="margin:0;height:100%;min-height:480px;background-color:${GGUI_RENDER_SHELL_SURFACE}"><div id="ggui-root" data-ggui-shell="thin" style="height:100%;min-height:480px"></div>
<script>${GGUI_RENDER_SHELL_SCRIPT_BODY}</script></body></html>`;

/**
 * CSP `script-src` source expression that authorises the inline
 * `<script>` block of {@link GGUI_RENDER_SHELL_HTML} when it executes
 * inside an iframe whose CSP is inherited from a parent host.
 *
 * # Why this exists
 *
 * The console's `<McpAppIframe>` mounts the production shell via
 * `srcdoc`. The `about:srcdoc` iframe inherits the parent console
 * SPA's CSP, which intentionally forbids `'unsafe-inline'` for
 * `script-src` (`packages/mcp-server/src/console-headers.ts` —
 * "If a future slice needs inline bootstrapping, add a nonce —
 * NEVER `'unsafe-inline'` for scripts."). Without an authorising
 * source expression for this exact script body, the inline shell
 * is blocked at parse time and the renderer is never fetched. The
 * lifecycle protocol never advances past `mounting`; specs pinning
 * `data-ggui-mcp-app-iframe-lifecycle="code-ready"` time out.
 *
 * Hash CSP is the right shape here: the shell body is **static**
 * and known at build time, and a hash binds the policy to the
 * exact bytes — narrower than `'unsafe-inline'`, narrower than a
 * runtime-generated nonce. If the shell body changes, the hash
 * changes; the drift test in `mcp-apps-outbound.test.ts` catches
 * a stale value.
 *
 * # Where it gets used
 *
 * `console-headers.ts::DEVTOOL_CSP` appends this expression to its
 * `script-src` directive. Hosted closed-runtime session-resource
 * endpoints have their own CSP and serve the same shell — that path
 * needs the same expression added; tracked separately.
 *
 * # What an MCP Apps host (Claude Desktop etc.) does
 *
 * Production hosts set their own CSP on the iframe document — that
 * surface is opaque to ggui. This expression is for the FIRST-PARTY
 * path where the host is `<McpAppIframe>` and the parent SPA owns
 * the CSP it inherits.
 */
export const GGUI_RENDER_SHELL_SCRIPT_HASH: string = `'sha256-${createHash("sha256")
  .update(GGUI_RENDER_SHELL_SCRIPT_BODY)
  .digest("base64")}'`;

/**
 * Register `ui://ggui/render` as a readable resource on an `McpServer`.
 *
 * The resource is STATIC - `resources/read` always returns the same
 * body. Per-session state lives on the live channel, not in the resource.
 *
 * When `publicBaseUrl` is supplied, the resource content carries
 * `_meta.ui.csp.{connectDomains,resourceDomains}` per the MCP Apps spec
 * (specification/2026-01-26/apps.mdx:300-317). The shell needs to fetch
 * the iframe-runtime bundle and open a WebSocket back to the same
 * origin; without these declarations the host applies the default CSP
 * (`connect-src 'none'`) and both are blocked.
 *
 * Without `publicBaseUrl`, the `_meta.ui.csp` block is omitted — falls
 * back to the spec's restrictive default which is fine for first-party
 * same-origin hosts (Studio/Portal/console) where the parent SPA owns
 * the iframe CSP via `<McpAppIframe>`.
 *
 * Returns nothing; the registration mutates the server in place.
 */
/**
 * Build the `_meta.ui.csp.{connectDomains,resourceDomains}` block from
 * an absolute `publicBaseUrl`. Same shape every resource that serves a
 * shell bootstrap needs: the iframe must `script-src` + `connect-src`
 * the runtime bundle, and `wss-src` the live-channel socket. CSP rules
 * do NOT cross-translate `https://` ↔ `wss://`, so the HTTPS origin
 * AND its `wss://` twin are both declared.
 *
 * Returns `undefined` when `publicBaseUrl` is absent or malformed —
 * the caller omits the `_meta` block entirely in that case, falling
 * back to the host's default CSP (fine for same-origin hosts;
 * restrictive for cross-origin claude.ai-style hosts).
 */
function buildCspMeta(
  publicBaseUrl: string | undefined,
  /**
   * Local-dev fallback: when `publicBaseUrl` is absent (first-party
   * same-origin deployments, e.g. `ggui serve` on `127.0.0.1`), derive
   * the CSP block from `runtimeUrl`. The runtime + WS + state endpoints
   * all live on the runtime's origin in same-origin deployments, so
   * declaring it covers every fetch the canvas iframe makes.
   *
   * Without this fallback, local dev with cross-origin sandbox proxies
   * (sample-agent's `:7790/sandbox.html` writing the canvas HTML that
   * references `:6786/_ggui/iframe-runtime.js`) trips a `script-src`
   * violation that blanks the iframe — verified live 2026-05-27.
   */
  runtimeUrl?: string
):
  | {
      readonly ui: {
        readonly csp: {
          readonly connectDomains: readonly string[];
          readonly resourceDomains: readonly string[];
        };
      };
    }
  | undefined {
  const source = publicBaseUrl ?? runtimeUrl;
  if (!source) return undefined;
  try {
    const parsed = new URL(source);
    const origin = parsed.origin;
    const wsScheme = parsed.protocol === "https:" ? "wss:" : "ws:";
    const wsOrigin = `${wsScheme}//${parsed.host}`;
    return {
      ui: {
        csp: {
          connectDomains: [origin, wsOrigin],
          resourceDomains: [origin],
        },
      },
    };
  } catch {
    return undefined;
  }
}

export function registerGguiRenderResource(
  server: McpServer,
  shellHtml: string = GGUI_RENDER_SHELL_HTML,
  publicBaseUrl?: string
): void {
  let cspMeta:
    | {
        ui: {
          csp: {
            connectDomains: readonly string[];
            resourceDomains: readonly string[];
          };
        };
      }
    | undefined;
  if (publicBaseUrl) {
    try {
      const parsed = new URL(publicBaseUrl);
      const origin = parsed.origin;
      // CSP `connect-src` does NOT cross-translate between `https://`
      // and `wss://` — they're independent URL schemes for the
      // browser's URL-match algorithm. Declaring ONLY the HTTPS
      // origin will leave WebSocket subscribes (`wss://<same-host>/ws`)
      // blocked by hosts that compose strict CSPs from this
      // `connectDomains` list (claude.ai's iframe is the live
      // diagnosis case). Declare BOTH schemes so the same physical
      // origin is reachable via HTTPS (`/api/bootstrap`, `/_ggui/
      // iframe-runtime.js`) AND wss (live-channel subscribe).
      const wsScheme = parsed.protocol === "https:" ? "wss:" : "ws:";
      const wsOrigin = `${wsScheme}//${parsed.host}`;
      cspMeta = {
        ui: {
          csp: {
            connectDomains: [origin, wsOrigin],
            resourceDomains: [origin],
          },
        },
      };
    } catch {
      // Malformed `publicBaseUrl` — leave `_meta.ui.csp` off rather
      // than emitting a broken declaration. The host falls back to its
      // restrictive default and operators get the same observable
      // failure they'd get from any other malformed URL setting.
      cspMeta = undefined;
    }
  }

  // `registerAppResource` (from `@modelcontextprotocol/ext-apps/server`)
  // defaults `mimeType` to `RESOURCE_MIME_TYPE` — the same
  // `text/html;profile=mcp-app` value `GGUI_RENDER_RESOURCE_MIME`
  // carries. Letting the canonical helper own the default means the
  // mimeType string lives in ONE place across the ecosystem (the SDK)
  // rather than duplicated in our protocol package.
  registerAppResource(
    server,
    "ggui-render",
    GGUI_RENDER_RESOURCE_URI,
    {
      // `title` / `description` show up in MCP clients that surface
      // resource metadata. Short + concrete.
      title: "ggui render",
      description:
        "Thin-shell iframe bundle that bootstraps a ggui render. MCP Apps hosts fetch this when they see `_meta.ui.resourceUri` on a ggui_render result.",
      mimeType: GGUI_RENDER_RESOURCE_MIME,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: GGUI_RENDER_RESOURCE_MIME,
          text: shellHtml,
          ...(cspMeta !== undefined ? { _meta: cspMeta } : {}),
        },
      ],
    })
  );
}

/**
 * Advertise the `io.modelcontextprotocol/ui` extension capability on
 * an `McpServer`'s underlying `Server`. Idempotent - calling twice on
 * the same server leaves the capability advertised once.
 *
 * We use the `experimental` capability slot (present in every MCP SDK
 * release) rather than `extensions` (post-1.x addition) for broadest
 * client compat. The capability *name* is what matters to hosts; the
 * container field is a pragmatic choice we can migrate if the spec
 * settles on `extensions` later.
 */
export function advertiseMcpAppsUiCapability(server: McpServer): void {
  server.server.registerCapabilities({
    experimental: {
      [MCP_APPS_UI_CAPABILITY]: {},
    },
  });
}

// =============================================================================
// Self-contained shell — third-party MCP Apps host support.
//
// **Why this exists.** The legacy `GGUI_RENDER_SHELL_HTML` (above) is a
// thin postMessage wrapper that depends on the host echoing the
// `ai.ggui/render.runtimeUrl` slice field back through
// `ui/initialize`. That contract is first-party-only — Studio /
// Portal / console implement the echo. Production MCP Apps hosts
// (Claude Desktop, claude.ai web) implement the canonical MCP Apps
// SDK lifecycle, which does NOT commit to forwarding ggui's custom
// `_meta["ai.ggui/*"]` slice block back. Result: the postMessage
// round-trip never resolves, the shell hangs at `mounting`, the
// iframe stays blank.
//
// **The fix.** Per-render HTML inlines the compiled componentCode +
// render id as a `window.__GGUI_META__` global BEFORE the
// runtime bundle's `<script type="module">` runs. The runtime reads
// the global synchronously, mounts the React component, and never
// speaks postMessage / opens a WebSocket. The `ui://ggui/render/{
// renderId}` resource template (registered below) is what binds a
// per-call `_meta.ui.resourceUri` (stamped by `ggui_render.resultMeta`)
// to the right render row.
//
// **Why base64 the componentCode.** Compiled component source contains
// every character that breaks raw embedding inside a `<script>` body
// — quotes, backticks, backslashes, `</script>` sequences, newlines.
// Inlining as base64 in a JSON literal sidesteps every escape concern
// with a 4/3 size overhead that's negligible compared to the
// network/bootstrap savings of skipping postMessage + WS.
//
// **Where the legacy postMessage shell still lives.** The static
// `ui://ggui/render` URI registered by `registerGguiRenderResource`
// stays — first-party hosts still use it. Both registrations co-exist
// on the same MCP server: hosts that fetch the static URI get the
// postMessage shell; hosts that fetch the per-render URI get the
// self-contained shell. `ggui_render` decides which `resourceUri` to
// stamp on a per-call basis.
// =============================================================================

/**
 * Inputs to {@link buildSelfContainedShell}.
 *
 * @public
 */
export interface SelfContainedShellInputs {
  /** Render id whose visible-bits surface is being inlined. */
  readonly renderId: string;
  /** App / tenant id the render is scoped to. */
  readonly appId: string;
  /**
   * Content-addressable URL the iframe fetches the compiled ES module
   * from. Mutually exclusive with {@link systemKind} — exactly one MUST
   * be set. The runtime resolves the URL with `import(codeUrl)` at boot;
   * the response is `Cache-Control: immutable` so subsequent loads of
   * the same compiled bundle hit the browser cache.
   */
  readonly codeUrl?: string;
  /**
   * Hex-encoded sha256 of the bytes served at {@link codeUrl}. Paired
   * with codeUrl (present together, absent together) — surfaces the
   * integrity signal alongside the URL so consumers can dedup across
   * pushes without re-parsing.
   */
  readonly codeHash?: string;
  /**
   * System-card kind identifier, mapped at runtime against the
   * built-in `SYSTEM_CARD_REGISTRY`. Mutually exclusive with
   * {@link codeUrl}.
   */
  readonly systemKind?: string;
  /**
   * Absolute URL of the iframe-runtime bundle the shell loads via
   * `<script type="module" src=...>`. MUST be absolute (or root-
   * relative resolvable from the host's iframe origin) — `srcdoc`
   * iframes have `about:srcdoc` as their URL so a bare relative path
   * cannot resolve. Also inlined on the `__GGUI_META__` global so
   * the iframe-runtime's bootstrap validator (which requires
   * `runtimeUrl` across all modes) accepts the envelope.
   */
  readonly runtimeUrl: string;
  /** Optional theme id forwarded to the renderer. */
  readonly themeId?: string;
  /**
   * Optional color mode (`'light'` | `'dark'`) forwarded to the
   * renderer. The runtime resolves the dark variant of {@link themeId}
   * via `getTheme(id, 'dark')` when this is set; absent / unknown
   * value falls back to `'light'`. Sourced from
   * `LoadedTheme.mode` for preset/file forms; default-source themes
   * omit this field entirely.
   */
  readonly themeMode?: "light" | "dark";
  /**
   * Optional pre-serialized props (must be a JSON string) forwarded
   * to the renderer. Server inlines the string verbatim — the
   * renderer parses + narrows to `Record<string, unknown>` at boot.
   */
  readonly propsJson?: string;
  /**
   * Names of same-server tools whose `_meta.ui.visibility` includes
   * `"app"`, mirrored from {@link McpAppAiGguiRenderMeta.appCallableTools}.
   * Forwarded to the iframe-runtime so its dispatch closure can choose
   * Pattern α (direct `tools/call`) over Pattern β (3-message bridge)
   * per wired action — even on the self-contained `/r/<shortCode>`
   * path where there's no `ui/initialize` round-trip to deliver the
   * field.
   *
   * Empty / absent → no fallout: the runtime's dispatch routes every
   * action through Pattern β.
   */
  readonly appCallableTools?: McpAppAiGguiRenderMeta["appCallableTools"];
  /**
   * Per-action wired-tool mapping for the active render, mirrored
   * from {@link McpAppAiGguiRenderMeta.actionNextSteps}.
   */
  readonly actionNextSteps?: McpAppAiGguiRenderMeta["actionNextSteps"];
  /**
   * Per-slot data for the active render's `contextSpec`, mirrored
   * from {@link McpAppAiGguiRenderMeta.contextSlots}. The runtime
   * synthesizes one `React.createContext(default)` per entry at boot.
   * Without this field, contextSpec UIs render with un-seeded
   * Providers.
   */
  readonly contextSlots?: McpAppAiGguiRenderMeta["contextSlots"];
  /**
   * Permissions-Policy directive list derived from the active render's
   * `clientCapabilities.gadgets[*].permission`.
   * When present (non-empty), inlined onto the bootstrap as
   * `permissionsPolicy` so the iframe-runtime can surface the gate set
   * to in-iframe consumers (debug overlay, permission-aware UI). The
   * actual browser-enforced gate comes from the iframe's
   * `Permissions-Policy` HTTP header (set on the public-render
   * response by `/r/<shortCode>`) or the host's `allow=""` attribute
   * (set from `_meta.ui.permissions` by McpAppIframe) — both derive
   * from the same source. Empty / absent = no permissions requested.
   */
  readonly permissionsPolicy?: readonly string[];
  /**
   * Resolved gadget catalog the iframe runtime dynamically imports at
   * boot. Each entry is `{hook,
   * package?, bundleUrl?}`. The MCP-Apps `_meta` slice channel already
   * forwards this via the render-mutation handler; this field is the
   * symmetric forward for the self-contained shell so `/r/<shortCode>`
   * and `resources/read` iframes don't render as STDLIB-only when the
   * contract declares wrappers.
   */
  readonly gadgets?: McpAppAiGguiRenderMeta["gadgets"];
  /**
   * Content-addressable hash for the active render's compiled
   * contract validators, mirrored from
   * {@link McpAppAiGguiRenderMeta.contractHash}. The iframe-runtime
   * resolves validators via `fetch({@link validatorsUrl})` + dynamic
   * import. Paired with {@link validatorsUrl} — present together or
   * absent together.
   */
  readonly contractHash?: McpAppAiGguiRenderMeta["contractHash"];
  /**
   * URL serving the content-addressable contract-validator bundle,
   * mirrored from {@link McpAppAiGguiRenderMeta.validatorsUrl}.
   * Symmetric forward for the self-contained shell so `/r/<shortCode>`
   * and `resources/read` iframes resolve validators exactly as the
   * MCP-Apps postMessage path does.
   */
  readonly validatorsUrl?: McpAppAiGguiRenderMeta["validatorsUrl"];
  /**
   * Server-filtered public env values that declared wrappers'
   * `requires` cover (minimum-disclosure subset of `App.publicEnv`).
   * Symmetric with the `ai.ggui/render` slice channel — every
   * transport that produces the meta MUST forward this field so
   * wrappers' `getPublicEnv()` reads land.
   */
  readonly publicEnv?: McpAppAiGguiRenderMeta["publicEnv"];
  /**
   * Live-mode WebSocket URL the iframe-runtime opens to receive
   * `props_update` / `stack_*` frames. When set alongside `token` +
   * `expiresAt`, the parser admits the bootstrap as live-mode; when
   * absent, the shell renders the static stack item but receives no
   * push updates after mount (the bug `/r/<shortCode>` exhibited before
   * we threaded the bootstrap minter through this route).
   */
  readonly wsUrl?: string;
  /**
   * Single-use bootstrap token authorising the WS subscribe. Paired
   * with {@link wsUrl} — half-live envelopes (one without the other)
   * are rejected as MALFORMED by the iframe-runtime slice-meta
   * extractors (`parseMetaFromGlobal`, `parseMetaFromToolResult`).
   * Server-minted via
   * the same `mintBootstrap` minter the JSON `/api/bootstrap/<shortCode>`
   * route uses, so both transports share replay-cache state.
   */
  readonly token?: string;
  /**
   * ISO-8601 expiry of {@link token}. Past-due envelopes degrade to
   * static-only mode at parse time; the static UI still mounts, but
   * live updates silently no-op until a fresh push refreshes creds.
   */
  readonly expiresAt?: string;
  /**
   * Monotonic RenderEvent ledger cursor at emit time, mirrored from
   * {@link McpAppAiGguiRenderMeta.lastSequence}. Polling clients
   * initialize the R7 `/events?sinceSequence=N` cursor from this.
   * Absent in pre-R7 envelopes (back-compat); post-R7 it MUST be
   * present.
   */
  readonly lastSequence?: McpAppAiGguiRenderMeta["lastSequence"];
  /**
   * Wire-stamped polling fallback URL — `${base}/api/renders/<id>/events?wsToken=<...>`.
   * When the iframe-runtime's WS transport reaches `'failed'` (CSP
   * blocks `ws://`, corporate firewall, etc.), `@ggui-ai/live-channel`
   * fails over to cursor-based event polling against this URL using
   * `{@link lastSequence}` as the initial cursor.
   *
   * Absent ⇒ runtime stays in WS-only mode. Operators that want the
   * fallback path lit up MUST thread this through (the canvas/inline
   * shell builders do; callers composing their own shells SHOULD).
   */
  readonly pollingUrl?: McpAppAiGguiRenderMeta["pollingUrl"];
}

/**
 * Build the self-contained shell HTML for a given session.
 *
 * The returned HTML is a complete, standalone document: it inlines the
 * compiled component (base64) + session ids in a `window.__GGUI_META__`
 * global, then loads the iframe-runtime bundle via `<script type="module"
 * src={runtimeUrl}>`. The runtime takes over synchronously on import,
 * mounts the component, and the iframe paints WITHOUT any further server
 * round-trip.
 *
 * Pure function — no DOM access, no I/O, no `crypto` randomness. Same
 * inputs always produce identical bytes (modulo input ordering of the
 * bootstrap object's optional fields), which makes the output cacheable
 * and testable.
 *
 * Escapes that matter:
 *   - HTML-entity-escapes the bootstrap JSON for `<` `>` `&` so a
 *     malicious appId / sessionId can't break out of the script tag.
 *   - The componentCode is base64-encoded by the caller before the JSON
 *     stringification runs, so even a raw `</script>` sequence in the
 *     compiled source can't break the surrounding HTML.
 *
 * @public
 */
export function buildSelfContainedShell(opts: SelfContainedShellInputs): string {
  // Discriminate between three modes: system-card, static-component
  // (codeUrl), or live (wsUrl + token). At least one mode MUST be set —
  // the builder rejects an empty bootstrap. Multiple modes may coexist
  // (e.g. codeUrl + live-mode credentials for an iframe that mounts
  // statically but subscribes for updates); the iframe-runtime parser
  // picks per its priority order.
  const isSystem = typeof opts.systemKind === "string" && opts.systemKind.length > 0;
  const hasCodeUrl = typeof opts.codeUrl === "string" && opts.codeUrl.length > 0;
  const hasLive =
    typeof opts.wsUrl === "string" &&
    opts.wsUrl.length > 0 &&
    typeof opts.token === "string" &&
    opts.token.length > 0;
  if (!isSystem && !hasCodeUrl && !hasLive) {
    throw new Error(
      "buildSelfContainedShell: at least one of `codeUrl`, `systemKind`, or live-mode (`wsUrl` + `token`) must be set"
    );
  }
  // Build the single render slice (Phase B: ai.ggui/render collapsed
  // the prior ai.ggui/session + ai.ggui/stack-item pair into one flat
  // shape). The inline global carries the SAME shape as the wire
  // `_meta` envelope so the iframe-runtime's `parseMetaFromGlobal`
  // defers to the same `parseMcpAppAiGguiRenderMeta` parser the
  // postMessage paths use. `runtimeUrl` is required across all modes
  // (the shell-bundled script tag fetches the runtime from there).
  const render: McpAppAiGguiRenderMeta = {
    renderId: opts.renderId,
    appId: opts.appId,
    runtimeUrl: opts.runtimeUrl,
    ...(opts.themeId !== undefined ? { themeId: opts.themeId } : {}),
    ...(opts.themeMode !== undefined ? { themeMode: opts.themeMode } : {}),
    ...(opts.appCallableTools !== undefined && opts.appCallableTools.length > 0
      ? { appCallableTools: opts.appCallableTools }
      : {}),
    ...(opts.permissionsPolicy !== undefined && opts.permissionsPolicy.length > 0
      ? { permissionsPolicy: opts.permissionsPolicy }
      : {}),
    // Wrapper catalog the iframe-runtime dynamic-imports at boot.
    // Symmetric with the `ai.ggui/render` wire-slice `gadgets` field.
    // Without this forward, the self-contained shell path
    // (/r/<shortCode>, resources/read) would render as STDLIB-only —
    // wrapper-using contracts (Leaflet, Mapbox) destructure unknown
    // hooks at runtime.
    ...(opts.gadgets !== undefined && opts.gadgets.length > 0 ? { gadgets: opts.gadgets } : {}),
    // Server-filtered public env values that declared wrappers'
    // `requires` cover. Symmetric forward; without it, wrappers
    // calling `getPublicEnv()` throw at hook-mount on the
    // self-contained shell path.
    ...(opts.publicEnv !== undefined && Object.keys(opts.publicEnv).length > 0
      ? { publicEnv: opts.publicEnv }
      : {}),
    // Live-mode trio. The iframe-runtime rejects half-live envelopes
    // (`wsUrl XOR wsToken` MALFORMED), so we forward all three together
    // or none at all — the caller is responsible for pairing them at
    // mint time. `expiresAt` is degrade-able (past-due → static-only)
    // but is part of the live trio at emit time. The `opts.token`
    // input is renamed to `wsToken` on the slice for wire-field parity.
    ...(opts.wsUrl !== undefined ? { wsUrl: opts.wsUrl } : {}),
    ...(opts.token !== undefined ? { wsToken: opts.token } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    // Polling fallback URL — lights up `@ggui-ai/live-channel`'s
    // events-polling transport when WS is unavailable. Absent ⇒
    // WS-only mode (legacy behavior). See SelfContainedShellInputs
    // .pollingUrl for the URL shape.
    ...(opts.pollingUrl !== undefined ? { pollingUrl: opts.pollingUrl } : {}),
    ...(opts.lastSequence !== undefined ? { lastSequence: opts.lastSequence } : {}),
    // Visible-bits surface — what the iframe is mounting right now.
    // Static-content discriminators (codeUrl / kind) are mutually
    // exclusive; the iframe-runtime rejects the both-set mix.
    ...(isSystem ? { kind: opts.systemKind! } : {}),
    ...(!isSystem && hasCodeUrl
      ? {
          codeUrl: opts.codeUrl!,
          ...(opts.codeHash !== undefined ? { codeHash: opts.codeHash } : {}),
        }
      : {}),
    ...(opts.propsJson !== undefined ? { propsJson: opts.propsJson } : {}),
    ...(opts.actionNextSteps !== undefined && Object.keys(opts.actionNextSteps).length > 0
      ? { actionNextSteps: opts.actionNextSteps }
      : {}),
    ...(opts.contextSlots !== undefined && opts.contextSlots.length > 0
      ? { contextSlots: opts.contextSlots }
      : {}),
    // Content-addressable contract-validator bundle. Iframe-runtime
    // fetches `validatorsUrl` + dynamic-imports to resolve
    // validators. Omitted when the contract declares no
    // runtime-validated schema OR when the server has no CodeStore
    // wired for the bundle write.
    ...(opts.contractHash !== undefined && opts.validatorsUrl !== undefined
      ? {
          contractHash: opts.contractHash,
          validatorsUrl: opts.validatorsUrl,
        }
      : {}),
  };

  // Same wire shape as `_meta` — the iframe-runtime's global parser
  // reuses `parseMcpAppAiGguiRenderMeta` for the single render slice.
  const bootstrap: Record<string, unknown> = {
    [MCP_APP_AI_GGUI_RENDER_META_KEY]: render,
  };

  // JSON.stringify produces valid JS, but `<` / `>` / `&` / `U+2028`
  // / `U+2029` can break HTML or JS parsers when embedded inline.
  // Escape them. `U+2028` / `U+2029` are JS-source line terminators
  // that JSON allows but JS parsers historically choked on; modern
  // engines accept them in strings but the escape is cheap insurance.
  const json = JSON.stringify(bootstrap)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  // HTML-escape the runtimeUrl for the `src` attribute. Server
  // operators control this string but a defensive escape avoids any
  // surprise if a future code path lets user-derived data flow here.
  const safeRuntimeUrl = opts.runtimeUrl
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Standalone served-iframe document — paint its own surface backdrop
  // so the canvas behind the rendered component never depends on a
  // browser honoring iframe transparency (the Safari white-canvas bug).
  // Same gating rationale as `GGUI_RENDER_SHELL_HTML`: this is ALWAYS a
  // top-level iframe document (the `__GGUI_META__` self-contained shell
  // for claude.ai / per-render resource shells), never inlined into a
  // host page, so painting `html`/`body` here cannot regress inline
  // embedding. `var(--ggui-color-surface, …)` resolves to the active
  // theme's per-mode surface once the iframe-runtime injects the `:root`
  // theme vars; the static dark fallback covers pre-resolve paint.
  return `<!doctype html>
<html lang="en" style="background-color:${GGUI_RENDER_SHELL_SURFACE}"><head><meta charset="utf-8"><title>ggui render</title></head>
<body style="background-color:${GGUI_RENDER_SHELL_SURFACE}">
<div id="ggui-root" data-ggui-shell="self-contained"></div>
<script>window.__GGUI_META__ = ${json};</script>
<script type="module" crossorigin="anonymous" src="${safeRuntimeUrl}"></script>
</body></html>`;
}

/**
 * Minimal "loading" HTML served when a per-render resource is fetched
 * for a render whose visible-bits surface has no componentCode yet
 * (placeholder, generation in flight). Renders a tiny status surface
 * so hosts that pin lifecycle selectors don't see a blank document.
 *
 * Hosts SHOULD re-fetch when they observe additional `ggui_render`
 * results on the same render — the per-call `_meta.ui.resourceUri`
 * value stays stable across commits for a render, so re-fetching the
 * same URI returns fresher HTML on the second try.
 *
 * @public
 */
export function buildSelfContainedLoadingShell(renderId: string): string {
  // Standalone served-iframe loading document — same surface-backdrop
  // paint + gating as the thin/self-contained shells so the canvas is
  // dark while the render is still in flight (no Safari white flash).
  return `<!doctype html>
<html lang="en" style="background-color:${GGUI_RENDER_SHELL_SURFACE}"><head><meta charset="utf-8"><title>ggui render</title></head>
<body style="background-color:${GGUI_RENDER_SHELL_SURFACE}">
<div id="ggui-root" data-ggui-shell="loading" data-ggui-render-id="${renderId
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}">Generating UI…</div>
</body></html>`;
}

/**
 * Options for {@link registerGguiRenderResourceTemplate}.
 *
 * @public
 */
export interface GguiRenderResourceTemplateOptions {
  /** RenderStore the template handler reads to find the render's
   *  componentCode. */
  readonly renderStore: RenderStore;
  /** Absolute URL of the iframe-runtime bundle inlined in the shell. */
  readonly runtimeUrl: string;
  /**
   * Content-addressable code-blob store. When wired alongside
   * {@link codeBaseUrl}, the resource template hashes the render's
   * componentCode, writes it to the store, and inlines the resulting
   * `codeUrl` into the shell bootstrap. Without these deps the
   * resource path emits the loading shell when the render is a
   * compiled component (the static-component channel cannot deliver
   * without a URL).
   */
  readonly codeStore?: import("@ggui-ai/mcp-server-core").CodeStore;
  /**
   * Base URL the code-blob route resolves to. Paired with {@link codeStore}.
   */
  readonly codeBaseUrl?: string;
  /**
   * Theme preset id resolved from `ggui.json#theme`. Without this,
   * MCP-Apps hosts (claude.ai, Claude Desktop) that fetch the resource
   * via `resources/read` always render the runtime's baked default
   * theme — `ggui.json#theme: 'indigo'` would only take effect on
   * the direct-browser `/r/<shortCode>` path, not in claude.ai.
   */
  readonly themeId?: string;
  /** Theme color mode resolved from `ggui.json#theme.mode`. */
  readonly themeMode?: "light" | "dark";
  /**
   * Per-app metadata store the resource handler reads to resolve
   * `App.publicEnv` for the bootstrap projection.
   * Symmetric with `/r/<shortCode>`'s lookup; wraps the same store
   * the push gate reads. Absent ⇒ publicEnv stays empty on the
   * resource-served bootstrap (wrappers calling `getPublicEnv` throw
   * at hook-mount with a clear "not provided" message).
   */
  readonly appMetadataStore?: import("@ggui-ai/mcp-server-core").AppMetadataStore;
  /**
   * Vector store backing the blueprint registry. When wired alongside
   * `defaultAppIdFallback`, the resource handler runs a registry-only
   * rehydrate fallback for the two-segment URI shape
   * (`ui://ggui/render/{renderId}/{blueprintKey}`): if the render is
   * gone but the blueprint registry still holds the entry, return the
   * static initial render (default props + default context) instead of
   * the dead "Generating UI…" loading shell. Single-tenant OSS sees
   * meaningful improvement; multi-tenant deployments leave both options
   * undefined to keep the loading-shell behavior on render miss.
   */
  readonly vectorStore?: VectorStore;
  /**
   * Blueprint identity index backing the registry. Required alongside
   * `vectorStore` for the registry-only rehydrate fallback: the resume
   * URI carries only a contract hash, so the handler resolves the
   * default-variant exact key `(template, contractKey, defaultVariantKey)`
   * to the row's UUID via this index. Threaded from the same shared
   * index instance the matcher reads.
   */
  readonly index?: BlueprintIndex;
  /**
   * App-id used for blueprint-registry scoping when the session has
   * been evicted. The registry is per-`appId`, but a missing session
   * has no way to derive its tenant — multi-tenant deployments leave
   * this undefined to fail-safe back to the loading shell. Single-
   * tenant OSS sets `'builder'` (the universal-MCP default identity)
   * and rehydrate works across session expiry / process restart.
   */
  readonly defaultAppIdFallback?: string;
  /**
   * Operator-supplied public origin. When present, every
   * `resources/read` response from this template carries
   * `_meta.ui.csp.{connectDomains,resourceDomains}` so claude.ai's
   * cross-origin iframe CSP allows the runtime bundle, codeUrl
   * fetches, and the live-channel WebSocket. Symmetric with the
   * declaration on the static `ui://ggui/render` resource. Absent ⇒
   * `_meta.ui.csp` omitted and the host's default CSP applies
   * (`connect-src 'none'` in claude.ai — runtime bundle fails to
   * load with a generic "script error").
   */
  readonly publicBaseUrl?: string;
  /**
   * Live-channel WebSocket bootstrap minter. When wired, every
   * `resources/read` response embeds `{wsUrl, wsToken}` in the shell
   * so the iframe-runtime opens a WebSocket immediately on mount and
   * receives `props_update` frames for in-place re-renders.
   *
   * Without this, the per-render resource shell mounts in
   * static-component mode (codeUrl only) — initial render works but
   * server-side state mutations (`ggui_update`) never visibly update
   * the iframe. Spec-compliant MCP-Apps hosts can still re-fetch
   * `resources/read` per-tool-result to get fresh HTML, but in-place
   * live updates require the WS pipe.
   *
   * Mirrors the `mintWsToken` plumbed into the handler-side render
   * machinery in `server.ts`; the resource template owns its own
   * call here because it runs OUTSIDE the per-tool-call context.
   */
  readonly mintWsToken?: (
    renderId: string,
    appId: string,
  ) => {
    readonly wsUrl: string;
    readonly token: string;
    readonly expiresAt: string;
  };
}

/**
 * Renderable picked from a {@link Render} — discriminates between
 * compiled-component renders (carry `componentCode`) and
 * server-emitted system cards (carry `kind`). The shell builders
 * stamp one or the other into `__GGUI_META__`; the runtime
 * decodes by presence of `kind`.
 *
 * Phase B: a render IS the addressable unit — there is no enclosing
 * stack vessel — so this helper is a direct narrowing of a single
 * {@link Render}, not a pick-from-stack scan.
 */
type RenderRenderable =
  | {
      kind?: undefined;
      id: string;
      componentCode: string;
      props?: Record<string, unknown>;
      /** Original source render — carried so the resource handler can
       *  thread it through `deriveRenderMeta` for projection of
       *  permissions / contextSlots / actionNextSteps. */
      source: Render;
    }
  | {
      kind: string;
      id: string;
      componentCode?: undefined;
      props?: Record<string, unknown>;
      source: Render;
    };

function pickComponentFromRender(render: Render | null | undefined): RenderRenderable | null {
  if (!render) return null;
  if (render.type === "mcpApps") return null;
  const propsRaw = "props" in render ? render.props : undefined;
  const props =
    propsRaw !== undefined &&
    propsRaw !== null &&
    typeof propsRaw === "object" &&
    !Array.isArray(propsRaw)
      ? (propsRaw as Record<string, unknown>)
      : undefined;
  if (render.type === "system") {
    if (typeof render.kind === "string" && render.kind.length > 0) {
      return {
        id: render.id,
        kind: render.kind,
        ...(props !== undefined ? { props } : {}),
        source: render,
      };
    }
    return null;
  }
  const code = render.componentCode;
  if (typeof code === "string" && code.length > 0) {
    return {
      id: render.id,
      componentCode: code,
      ...(props !== undefined ? { props } : {}),
      source: render,
    };
  }
  return null;
}

/**
 * Register a `ui://ggui/render/{renderId}` resource template. Each
 * `resources/read` request is resolved by looking up the render in the
 * store and returning the self-contained shell with that
 * componentCode inlined.
 *
 * Per-call `_meta.ui.resourceUri` (stamped by `ggui_render.resultMeta`)
 * pins the URI to a specific renderId; hosts fetch THAT URI rather
 * than the static `ui://ggui/render` one. Both registrations co-exist:
 * legacy postMessage shell at the static URI, self-contained shell at
 * the templated URI.
 *
 * Failure modes:
 *   - Render not found → loading shell (host re-fetches; absent
 *     render is a transient state immediately after `ggui_render`).
 *   - Render found, no componentCode yet → loading shell.
 *   - Render found, componentCode present → self-contained shell.
 *
 * Returns nothing; mutates the server in place.
 *
 * @public
 */
export function registerGguiRenderResourceTemplate(
  server: McpServer,
  opts: GguiRenderResourceTemplateOptions
): void {
  // TWO templates registered against the same handler core:
  //
  //   1. Single-segment legacy URI — `ui://ggui/render/{renderId}`.
  //      Pre-resume-contract chats in claude.ai's history persisted
  //      this shape; we keep the registration so historical messages
  //      still rehydrate (loading shell on render miss).
  //
  //   2. Two-segment resume URI — `ui://ggui/render/{renderId}/
  //      {blueprintKey}`. Stamped by every render since the resume
  //      contract landed. Carries enough state for the handler to do:
  //      (a) parallel render + blueprint registry lookup (no data
  //      dependency between them), (b) registry-only fallback when
  //      the render is gone but the blueprint is still cached
  //      (renders the original card with default props/context
  //      instead of the dead loading shell).
  const legacyTemplate = new ResourceTemplate(`${GGUI_RENDER_RESOURCE_URI}/{renderId}`, {
    // No list-callback — the resource set is unbounded per render
    // count, and `resources/list` would leak render ids across
    // tenants. Hosts discover specific URIs via per-call `_meta.ui.
    // resourceUri` instead.
    list: undefined,
  });
  const resumeTemplate = new ResourceTemplate(
    `${GGUI_RENDER_RESOURCE_URI}/{renderId}/{blueprintKey}`,
    { list: undefined }
  );

  // CSP-meta block forwarded on every shell response when the
  // template was wired with `publicBaseUrl`. claude.ai's iframe
  // applies the host's restrictive default (`connect-src 'none'`)
  // unless the resource declares `_meta.ui.csp.connectDomains` —
  // without that the `<script type="module" src=runtimeUrl>` tag
  // fails with a generic "script error" since cross-origin script
  // loading is blocked. Same shape declared on the static
  // `ui://ggui/render` resource; this is the per-call mirror.
  const templateCspMeta = buildCspMeta(opts.publicBaseUrl, opts.runtimeUrl);
  type CspMeta = NonNullable<ReturnType<typeof buildCspMeta>>;
  type ShellContent = {
    readonly uri: string;
    readonly mimeType: string;
    readonly text: string;
    readonly _meta?: CspMeta;
  };
  /**
   * Merge gadget-declared origins from
   * {@link deriveBundleOrigins} into the base `templateCspMeta`. The
   * base only carries the publicBaseUrl origin (HTTPS + WSS); without
   * the per-stack-item augmentation, gadget bundle / style / API
   * origins (Leaflet tiles, Mapbox API, Stripe SDK, …) are blocked by
   * claude.ai's iframe CSP and the component fails to render. Returns
   * `undefined` when there's no base CSP at all (publicBaseUrl
   * absent — first-party same-origin host).
   */
  const augmentCspMeta = (
    gadgetOrigins: ReturnType<typeof deriveBundleOrigins> | undefined
  ): CspMeta | undefined => {
    if (templateCspMeta === undefined) return undefined;
    if (gadgetOrigins === undefined) return templateCspMeta;
    return {
      ui: {
        csp: {
          connectDomains: [...templateCspMeta.ui.csp.connectDomains, ...gadgetOrigins.connect],
          resourceDomains: [
            ...templateCspMeta.ui.csp.resourceDomains,
            ...gadgetOrigins.script,
            ...gadgetOrigins.style,
          ],
        },
      },
    };
  };
  const shellContents = (
    uri: URL,
    text: string,
    cspMeta: CspMeta | undefined = templateCspMeta
  ): { contents: ShellContent[] } => ({
    contents: [
      {
        uri: uri.href,
        mimeType: GGUI_RENDER_RESOURCE_MIME,
        text,
        ...(cspMeta !== undefined ? { _meta: cspMeta } : {}),
      },
    ],
  });
  const loadingShell = (uri: URL, renderId: string) =>
    shellContents(uri, buildSelfContainedLoadingShell(renderId));

  // Single shared handler powers both templates. `blueprintKey` is
  // optional in the variables map — present for the resume URI shape,
  // absent for the legacy single-segment shape.
  async function handle(
    uri: URL,
    variables: Record<string, string | string[]>
  ): Promise<{ contents: ShellContent[] }> {
    const renderIdRaw = variables["renderId"];
    const renderId = Array.isArray(renderIdRaw) ? renderIdRaw[0] : renderIdRaw;
    if (typeof renderId !== "string" || renderId.length === 0) {
      return loadingShell(uri, "unknown");
    }
    const blueprintKeyRaw = variables["blueprintKey"];
    const blueprintKey = Array.isArray(blueprintKeyRaw) ? blueprintKeyRaw[0] : blueprintKeyRaw;
    const hasResumeKey = typeof blueprintKey === "string" && blueprintKey.length > 0;

    // Parallel lookup. The render and the blueprint registry are
    // independent — even though the render's componentCode could feed
    // the renderable directly, we ALSO want the blueprint entry as a
    // registry-only fallback when the render is gone but the blueprint
    // is still cached (chat-history rehydrate after render TTL or
    // process restart).
    const [stored, blueprint] = await Promise.all([
      opts.renderStore.get(renderId),
      hasResumeKey && opts.vectorStore && opts.index && opts.defaultAppIdFallback
        ? findBlueprintExact(
            { vectorStore: opts.vectorStore, index: opts.index },
            opts.defaultAppIdFallback,
            "template",
            // Resume URI carries only a contract hash — omit variantKey
            // so the lookup resolves the default variant.
            blueprintKey
          )
        : Promise.resolve(null),
    ]);

    // Happy path: render present and renderable. Mount with the live
    // state (current props, current contextSpec values).
    if (stored) {
      const picked = pickComponentFromRender(stored.render);
      if (picked) {
        // Project the active render to the transport-agnostic bootstrap
        // view — same source of truth the render-mutation handler and
        // `/r/<shortCode>` consume. Carries permissionsPolicy when
        // clientCapabilities declares permissions. The MCP Apps
        // resource path emits this only into the inline bootstrap
        // (the browser-enforced gate ultimately comes from the host's
        // `allow=""` attribute when the host translates
        // `_meta.ui.permissions` — set by McpAppIframe consumers).
        const view = deriveRenderMeta(picked.source);
        const isSystem = picked.kind !== undefined;

        // Static-component delivery via codeUrl. The compiled-component
        // path mints a content-addressable URL the iframe-runtime
        // fetches at boot; the loading shell takes over when codeStore +
        // codeBaseUrl aren't wired.
        let codeUrl: string | undefined;
        let codeHash: string | undefined;
        let contractHash: string | undefined;
        let validatorsUrl: string | undefined;
        if (!isSystem && opts.codeStore && opts.codeBaseUrl) {
          try {
            const hash = opts.codeStore.hashOf(picked.componentCode);
            await opts.codeStore.put(hash, picked.componentCode);
            codeHash = hash;
            const base = opts.codeBaseUrl.replace(/\/$/, "");
            codeUrl = `${base}/code/${hash}.js`;
          } catch {
            // Silent — falls through to loading shell below.
          }
          // Content-addressable contract-validator bundle (#109).
          try {
            const bundle = await deriveContractBundle(picked.source);
            if (bundle) {
              await opts.codeStore.put(bundle.contractHash, bundle.bundleSource);
              contractHash = bundle.contractHash;
              const base = opts.codeBaseUrl.replace(/\/$/, "");
              validatorsUrl = `${base}/contract/${bundle.contractHash}.js`;
            }
          } catch {
            // Silent — bundle write failure degrades to no client-side
            // validators (server-side gate is authoritative).
          }
        }
        if (!isSystem && codeUrl === undefined) {
          // Compiled-component render but no codeUrl channel available
          // — emit the loading shell so the operator can refresh once
          // codeStore is wired. Direct-render `/r/<shortCode>` falls
          // through to live-mode instead; this MCP-resource path has
          // no WS-mode fallback (resources/read is one-shot).
          return loadingShell(uri, renderId);
        }

        // Project the wrapper catalog AND the union-filtered
        // publicEnv onto the inline bootstrap so the resource-served
        // iframe matches the MCP-Apps postMessage path. Without this,
        // wrapper-using contracts rendered through `resources/read`
        // mount as STDLIB-only.
        let resourcePublicEnv: Readonly<Record<string, string>> | undefined;
        if (opts.appMetadataStore) {
          try {
            const appRecord = await opts.appMetadataStore.get(stored.appId);
            resourcePublicEnv = derivePublicEnvProjection(picked.source, appRecord?.publicEnv);
          } catch {
            // Silent — wrappers calling getPublicEnv throw clearly.
          }
        }
        // Live-channel bootstrap — when the operator wired
        // {@link GguiRenderResourceTemplateOptions.mintWsToken}, mint a
        // wsToken for this render so the iframe-runtime opens a
        // WebSocket on mount and receives `props_update` frames.
        // Without this, the resource shell renders in static-component
        // mode only — `ggui_update` server-side mutations never
        // visibly reach the live iframe (hosts must re-fetch
        // `resources/read` after every update tool result to see new
        // state).
        let wsUrl: string | undefined;
        let wsToken: string | undefined;
        if (opts.mintWsToken) {
          try {
            const minted = opts.mintWsToken(renderId, stored.appId);
            wsUrl = minted.wsUrl;
            wsToken = minted.token;
          } catch {
            // Silent — falls back to static-component mode.
          }
        }

        const html = buildSelfContainedShell({
          renderId,
          appId: stored.appId,
          ...(isSystem
            ? { systemKind: picked.kind }
            : {
                codeUrl: codeUrl!,
                ...(codeHash !== undefined ? { codeHash } : {}),
              }),
          runtimeUrl: opts.runtimeUrl,
          ...(wsUrl !== undefined && wsToken !== undefined
            ? { wsUrl, token: wsToken }
            : {}),
          ...(opts.themeId !== undefined ? { themeId: opts.themeId } : {}),
          ...(opts.themeMode !== undefined ? { themeMode: opts.themeMode } : {}),
          ...(view.propsJson !== undefined ? { propsJson: view.propsJson } : {}),
          ...(view.actionNextSteps !== undefined ? { actionNextSteps: view.actionNextSteps } : {}),
          ...(view.contextSlots !== undefined ? { contextSlots: view.contextSlots } : {}),
          ...(view.permissionsPolicy !== undefined
            ? { permissionsPolicy: view.permissionsPolicy }
            : {}),
          ...(view.gadgets !== undefined && view.gadgets.length > 0
            ? { gadgets: view.gadgets }
            : {}),
          ...(contractHash !== undefined && validatorsUrl !== undefined
            ? { contractHash, validatorsUrl }
            : {}),
          ...(resourcePublicEnv !== undefined && Object.keys(resourcePublicEnv).length > 0
            ? { publicEnv: resourcePublicEnv }
            : {}),
          // R6 — ledger cursor stamp for polling-cursor alignment.
          lastSequence: stored.eventSequence,
        });
        // Augment per-call CSP with gadget-declared bundle / style /
        // API origins. Without this, claude.ai's iframe CSP only allows
        // the publicBaseUrl origin, so Leaflet wrapper bundles fetched
        // from registry.ggui.ai, leaflet.css fetched from same, and
        // OSM tile requests to tile.openstreetmap.org all get blocked
        // → the component throws and the React error boundary renders
        // "Something went wrong." The /r/<shortCode> HTTP path already
        // derives these via deriveBundleOrigins; this is the per-call
        // resource mirror.
        const gadgetOrigins = deriveBundleOrigins(picked.source);
        return shellContents(uri, html, augmentCspMeta(gadgetOrigins));
      }
    }

    // Registry-only fallback: render is gone (TTL / restart) but the
    // blueprint is still in the registry. Synthesize the shell from
    // the blueprint's componentCode + propsSpec defaults — strictly
    // worse than the live mount (no current props, no preserved
    // context state), but strictly better than the dead loading
    // shell.
    if (blueprint && opts.defaultAppIdFallback) {
      const html = await buildShellFromBlueprint({
        renderId,
        appId: opts.defaultAppIdFallback,
        blueprint,
        runtimeUrl: opts.runtimeUrl,
        ...(opts.themeId !== undefined ? { themeId: opts.themeId } : {}),
        ...(opts.themeMode !== undefined ? { themeMode: opts.themeMode } : {}),
        ...(opts.codeStore !== undefined ? { codeStore: opts.codeStore } : {}),
        ...(opts.codeBaseUrl !== undefined ? { codeBaseUrl: opts.codeBaseUrl } : {}),
      });
      if (html !== undefined) {
        return shellContents(uri, html);
      }
      // Fallthrough to loading shell when codeStore isn't wired.
    }

    return loadingShell(uri, renderId);
  }

  server.registerResource(
    "ggui-render-self-contained",
    legacyTemplate,
    {
      title: "ggui render (self-contained, legacy URI)",
      description:
        "Per-render self-contained shell — single-segment URI shape predating the resume contract. Falls back to loading shell when the render is gone (no blueprintKey to do registry-only render).",
      mimeType: GGUI_RENDER_RESOURCE_MIME,
    },
    handle
  );

  server.registerResource(
    "ggui-session-self-contained-resume",
    resumeTemplate,
    {
      title: "ggui render (self-contained, resume URI)",
      description:
        "Per-render self-contained shell — two-segment URI shape carrying both renderId AND blueprintKey. Resource handler runs Promise.all over render + registry; falls back to registry-only static render when the render has been evicted but the blueprint is still cached.",
      mimeType: GGUI_RENDER_RESOURCE_MIME,
    },
    handle
  );
}

/**
 * Synthesize a shell from a registry-only blueprint (no live render).
 * Used when chat-history rehydrate finds the render evicted but the
 * blueprint registry still holds the entry. Renders the same
 * componentCode the original commit generated, seeded with the
 * contract's declared `propsSpec` defaults + `contextSpec` defaults.
 * Live state (the user's interactive edits, last-known context
 * values) is lost in this path; that's the cost of render eviction.
 *
 * Internal — exported nowhere because the only safe trigger path is
 * inside the resource handler with the resume URI shape (URI carries
 * the blueprintKey that bounds which blueprint we render).
 */
async function buildShellFromBlueprint(args: {
  renderId: string;
  appId: string;
  blueprint: Blueprint;
  runtimeUrl: string;
  themeId?: string;
  themeMode?: "light" | "dark";
  codeStore?: import("@ggui-ai/mcp-server-core").CodeStore;
  codeBaseUrl?: string;
}): Promise<string | undefined> {
  const { blueprint } = args;
  if (!args.codeStore || !args.codeBaseUrl) {
    return undefined;
  }
  const contract = blueprint.contract ?? {};
  const propsSpec =
    "props" in contract && contract.props !== undefined
      ? (contract.props as {
          properties: Record<string, { schema: { default?: unknown }; default?: unknown }>;
        })
      : undefined;
  const propsJson = propsSpec ? JSON.stringify(deriveDefaultPropsValues(propsSpec)) : undefined;
  const contextSlots = deriveDefaultContextSlots(contract.contextSpec);
  const actionNextSteps =
    "actionSpec" in contract && contract.actionSpec !== undefined
      ? deriveWiredActionToolsFromSpec(contract.actionSpec)
      : undefined;
  let codeUrl: string;
  let codeHash: string;
  try {
    codeHash = args.codeStore.hashOf(blueprint.componentCode);
    await args.codeStore.put(codeHash, blueprint.componentCode);
    const base = args.codeBaseUrl.replace(/\/$/, "");
    codeUrl = `${base}/code/${codeHash}.js`;
  } catch {
    return undefined;
  }
  return buildSelfContainedShell({
    renderId: args.renderId,
    appId: args.appId,
    codeUrl,
    codeHash,
    runtimeUrl: args.runtimeUrl,
    ...(args.themeId !== undefined ? { themeId: args.themeId } : {}),
    ...(args.themeMode !== undefined ? { themeMode: args.themeMode } : {}),
    ...(propsJson !== undefined ? { propsJson } : {}),
    ...(contextSlots !== undefined ? { contextSlots } : {}),
    ...(actionNextSteps !== undefined ? { actionNextSteps } : {}),
  });
}

function deriveDefaultPropsValues(spec: {
  properties: Record<string, { schema?: { default?: unknown }; default?: unknown }>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(spec.properties)) {
    if (entry.default !== undefined) {
      out[name] = entry.default;
    } else if (entry.schema && entry.schema.default !== undefined) {
      out[name] = entry.schema.default;
    }
  }
  return out;
}

function deriveDefaultContextSlots(
  spec: ContextSpec | undefined
): McpAppAiGguiRenderMeta["contextSlots"] {
  if (!spec) return undefined;
  const collected: NonNullable<McpAppAiGguiRenderMeta["contextSlots"]>[number][] = [];
  for (const [name, entry] of Object.entries(spec)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.schema === undefined || entry.schema === null) continue;
    if (typeof entry.schema !== "object") continue;
    const fallback = deriveContextDefault(entry);
    collected.push({
      name,
      contextName: deriveContextName(name),
      schema: entry.schema,
      default: fallback === undefined ? null : fallback,
      ...(entry.debounceMs !== undefined ? { debounceMs: entry.debounceMs } : {}),
    });
  }
  return collected.length > 0 ? collected : undefined;
}

function deriveWiredActionToolsFromSpec(
  spec: import("@ggui-ai/protocol").ActionSpec
): Record<string, string> | undefined {
  const collected: Record<string, string> = {};
  for (const [name, entry] of Object.entries(spec)) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.nextStep === "string" &&
      entry.nextStep.length > 0
    ) {
      collected[name] = entry.nextStep;
    }
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}

/**
 * Apply the full MCP Apps outbound wiring to a fresh `McpServer` - both
 * the capability advertisement and the `ui://ggui/render` resource. The
 * single entry-point `build-mcp.ts` calls so request-path wiring stays
 * one line.
 *
 * When `selfContained` is supplied, ALSO registers the per-render
 * `ui://ggui/render/{renderId}` resource template that serves the
 * self-contained shell (the path third-party MCP Apps hosts use). The
 * legacy static URI registration is unconditional — first-party hosts
 * (Studio, Portal, console) still rely on the postMessage path.
 */
export function installMcpAppsOutbound(
  server: McpServer,
  opts: {
    readonly shellHtml?: string;
    /**
     * Per-render self-contained shell registration. When supplied,
     * `ui://ggui/render/{renderId}` becomes a readable resource
     * template whose body inlines the compiled componentCode from the
     * render. Absent → only the legacy postMessage shell is registered.
     */
    readonly selfContained?: GguiRenderResourceTemplateOptions;
    /**
     * Public origin the server is reachable at — forwarded to
     * `registerGguiRenderResource` so the static `ui://ggui/render`
     * resource carries `_meta.ui.csp.{connectDomains,resourceDomains}`
     * authorising the iframe to fetch the runtime bundle and open a
     * WebSocket. Omit when running same-origin behind a first-party
     * host (Studio/Portal/console) — the parent SPA owns the CSP
     * there via `<McpAppIframe>`.
     */
    readonly publicBaseUrl?: string;
  } = {}
): void {
  advertiseMcpAppsUiCapability(server);
  registerGguiRenderResource(server, opts.shellHtml, opts.publicBaseUrl);
  if (opts.selfContained) {
    registerGguiRenderResourceTemplate(server, opts.selfContained);
  }
}
