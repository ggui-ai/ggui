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
  GguiSessionStore,
  StoredGguiSession,
  VectorStore,
} from "@ggui-ai/mcp-server-core";
import {
  deriveBundleOrigins,
  deriveContractBundle,
  derivePublicEnvProjection,
  deriveRenderMeta,
  filterDescriptorsToContract,
  findBlueprintExact,
  type Blueprint,
  type BlueprintDurabilityDeps,
} from "@ggui-ai/mcp-server-handlers/renders";
import type {
  ComponentGguiSession,
  GguiSession,
  ResourceReadError,
  ResourceReadJsonRpcError,
} from "@ggui-ai/protocol";
import {
  RESOURCE_NOT_FOUND_MESSAGE,
  deriveContextDefault,
  isRecord,
  resolveAppGadgets,
  resourceReadErrorToJsonRpc,
  type ContextSpec,
} from "@ggui-ai/protocol";
import {
  GGUI_RENDER_RESOURCE_MIME,
  GGUI_RENDER_RESOURCE_URI,
  GGUI_RENDER_SHELL_SURFACE,
  MCP_APPS_UI_CAPABILITY,
  MCP_APP_BOOTSTRAP_FAILED_TYPE,
  asGguiRenderBootstrap,
  deriveContextName,
  gguiShellHtml,
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { createHash } from "node:crypto";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import { renderReadAllowed, type RenderReadRowView } from "./render-read-gate.js";
import { DEFAULT_BUILDER_APP_ID } from "./auth.js";
import type { Logger } from "./logger.js";

/**
 * Thin-shell body served from `ui://ggui/render` (C8 pivot).
 *
 * **Architectural role.** The shell is a ~30 LOC bootstrap wrapper -
 * it runs the `ui/initialize` + `ui/notifications/initialized`
 * handshake, then waits for the host's spec-canonical
 * `ui/notifications/tool-result` notification carrying the
 * `ai.ggui/render` slice in `_meta`, and dynamic-script-loads the
 * `@ggui-ai/iframe-runtime` bundle from the slice's `runtimeUrl`.
 * Every rendering concern - WS open, subscribe, render mount,
 * component code eval, adapter install - belongs to the renderer
 * bundle (shipped C7a-d), not here.
 *
 * **Why bootstrap-driven URL.** `srcdoc` iframes have `about:srcdoc`
 * as their URL, so relative paths can't resolve to the MCP server's
 * HTTP listener. The server-controlled `runtimeUrl` lands on the
 * `ai.ggui/render.runtimeUrl` slice field and the shell picks it up
 * from the tool-result `_meta` slice - origin-agnostic, works
 * under OSS same-origin AND hosted-cloud CDN deployments.
 *
 * **Why `<script type="module">`.** `@ggui-ai/iframe-runtime` is bundled as
 * ESM (its own runtime.ts:5 declares the contract: "the thin-shell
 * HTML loads it via `<script type="module" src=".../iframe-runtime.js">`").
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
 *   - `MALFORMED_BOOTSTRAP` - the tool-result `_meta` slice arrived
 *     without a valid `ai.ggui/render` envelope or `runtimeUrl`.
 *   - `BUNDLE_FETCH_FAILED` - `<script src>` errored (network failure,
 *     404, CSP reject with an observable `error` event).
 *
 * Post-renderer failures (WS handshake / auth / render-mismatch) are
 * the renderer bundle's responsibility - `runtime.ts::postBootFailure`
 * emits the same `ggui:bootstrap-failed` envelope.
 *
 * **Adapter boundary unchanged.** The preflight's `message` listener
 * routes ONLY responses to its own pending JSON-RPC ids. MCP Apps
 * lifecycle notifications from the host (`ui/notifications/message`,
 * `ui/update-model-context`) are dropped. This mirrors the pre-C8
 * posture - the shell still MUST NOT mutate render state from
 * arbitrary host messages. ADAPTER BOUNDARY enforced by the
 * `pending[m.id]` route-by-id check.
 *
 * **Double `ui/initialize` is intentional.** The shell runs a minimal
 * preflight to complete the MCP Apps handshake (hosts release the
 * tool-result notification only after `ui/notifications/initialized`);
 * the renderer bundle's autostart path runs its own `ui/initialize`
 * for the full bootstrap parse. MCP Apps hosts handle repeats
 * idempotently - the preflight's cost is a single postMessage
 * round-trip.
 *
 * Exported as a string constant for tests; not part of the public
 * package API. Vanilla JS, no build step, no external deps. The shell
 * must work in any browser that implements MCP Apps; no modern-ES
 * features.
 */
/**
 * Inline body of the thin shell's bootstrap `<script>` block.
 *
 * Split from {@link GGUI_RENDER_SHELL_HTML} so the exact bytes the
 * browser sees inside the `<script>...</script>` tag are addressable
 * for CSP-hash purposes — see {@link GGUI_RENDER_SHELL_SCRIPT_HASH}.
 *
 * The browser's CSP `'sha256-...'` source-expression is computed over
 * the literal text content of the `<script>` element (everything
 * between the opening and closing tags, including leading and trailing
 * whitespace inside). Concatenating this constant unchanged into the
 * shell HTML means the runtime hash and the constant-time hash agree.
 *
 * {@link GGUI_RENDER_SHELL_SCRIPT_HASH} is DERIVED from this constant
 * at module load, so edits here propagate to the CSP hash
 * automatically. The `mcp-apps-outbound.test.ts` drift test recomputes
 * the hash from the assembled shell HTML and fails loudly if the body
 * and the HTML assembly ever disagree.
 */
const GGUI_RENDER_SHELL_SCRIPT_BODY = `
(function(){'use strict';
// MCP Apps shell. Speaks the canonical postMessage protocol from
// @modelcontextprotocol/ext-apps:
//   1. iframe -> host: ui/initialize
//   2. iframe -> host: ui/notifications/initialized
//   3. host -> iframe: ui/notifications/tool-result (per CallToolResult)
// On tool-result, read the slice envelope from _meta (spec-canonical
// CallToolResult _meta at the top level), set window.__GGUI_META__ to
// the envelope, fetch runtime as blob, inject as script.
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
// render slice; sessionId is the canonical identity.
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
  try{window.parent.postMessage({type:'${MCP_APP_BOOTSTRAP_FAILED_TYPE}',reason:reason,message:message},'*');}catch(e){}
}
async function mountFromMeta(envelope){
  if(mounted)return;
  // Slice envelope shape (Phase B): { "ai.ggui/render": { sessionId,
  // appId, runtimeUrl, ... } }. runtimeUrl on the render slice is
  // the only load-bearing field at the shell layer — it tells us
  // which iframe-runtime bundle to fetch. Everything else is
  // optional; the runtime decides at boot time based on the meta
  // it reads from window.__GGUI_META__.
  var renderSlice=envelope&&envelope['ai.ggui/render'];
  var runtimeUrl=renderSlice&&renderSlice.runtimeUrl;
  if(!envelope||typeof runtimeUrl!=='string'){
    setOverlay('Bootstrap payload malformed.');
    postBootstrapFailed('MALFORMED_BOOTSTRAP','Bootstrap payload malformed.');
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
function readMetaFromCallToolResult(params){
  // MCP Apps spec (specification/2026-01-26/apps.mdx:1145-1155):
  //   ui/notifications/tool-result
  //   params: CallToolResult  // Standard MCP type
  // So params IS the CallToolResult and _meta lives at the top
  // level. Spec-compliant hosts (Claude Desktop, claude.ai
  // Connector, Claude Code) deliver slice-envelope material here.
  // Single slice-envelope key (Phase B: ai.ggui/render). Only the
  // render slice's runtimeUrl is load-bearing at the shell layer;
  // the runtime reads everything else off window.__GGUI_META__
  // after we set it.
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
    // at the top level.
    var specMeta=readMetaFromCallToolResult(m.params);
    if(specMeta){mountFromMeta(specMeta);return;}
    // R5 (2026-05-26) -- the /r/<shortCode> HTTP fallback was removed
    // along with the bearer-by-obscurity model. Hosts that strip
    // _meta on the tool-result wire have no fallback path here;
    // spec-canonical hosts deliver meta inline and land in the branch
    // above.
  }
});
setOverlay('Initializing…');
var initTimer=setTimeout(function(){
  setOverlay('Host did not respond to ui/initialize within 3s.');
},3000);
postRpc('ui/initialize',{
  appCapabilities:{},
  appInfo:{name:'ggui-render',version:'1.0.0'},
  protocolVersion:'2026-01-26'
}).then(function(){
  clearTimeout(initTimer);
  postNotification('ui/notifications/initialized',{});
  // Wait for the host to send ui/notifications/tool-result carrying
  // the slice envelope in _meta — the spec-canonical delivery channel.
  // The ui/initialize result itself carries no slice meta (the
  // McpUiInitializeResult schema defines no such field).
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
// Value-resolution only — no `--ggui-*` token added or renamed. The
// constant itself lives with the protocol host-helper (the shared
// self-contained-shell assembler paints the same surface); imported
// above and reused here for the thin postMessage shell.

// `#ggui-root` here is LOAD-BEARING for the shell script (NOT a React
// mount target): the inline script grabs it as `rootEl` for the
// pre-mount overlays ("Initializing…", "Waiting for tool result…",
// bootstrap-failure messages) and clears it before injecting the
// runtime bundle. The runtime itself mounts into its own
// `<ul data-ggui-session-root>` appended to `document.body`
// (iframe-runtime `status-dom.ts#ensureStatusDom`), so `#ggui-root`
// stays empty after a successful mount — that is expected, not a bug.
// The self-contained shell (`buildSelfContainedShell`) has no overlay
// script and therefore no anchor div at all.
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
 * `script-src` directive. Hosted closed-runtime render-resource
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
 * body. Per-render state lives on the live channel, not in the resource.
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
   * declaring it covers every fetch the sandboxed iframe makes.
   *
   * Without this fallback, local dev with cross-origin sandbox proxies
   * (sample-agent's `:7790/sandbox.html` writing the sandbox HTML that
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
// render id as a `globalThis.__GGUI_META__` global BEFORE the
// runtime bundle's `<script type="module">` runs. The runtime reads
// the global synchronously, mounts the React component, and never
// speaks postMessage / opens a WebSocket. The `ui://ggui/render/{
// sessionId}` resource template (registered below) is what binds a
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
  /** GguiSession id whose visible-bits surface is being inlined. */
  readonly sessionId: string;
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
   * renders without re-parsing.
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
   * Resolved per-app theme overlay (mode + `--ggui-*` CSS-variable map),
   * mirrored from {@link McpAppAiGguiRenderMeta.theme}. Symmetric forward
   * for the self-contained shell so `/r/<shortCode>` + `resources/read`
   * iframes apply the same operator overlay the MCP-Apps postMessage
   * path carries. Absent ⇒ the renderer's default theme.
   */
  readonly theme?: McpAppAiGguiRenderMeta["theme"];
  /**
   * Optional pre-serialized props (must be a JSON string) forwarded
   * to the renderer. Server inlines the string verbatim — the
   * renderer parses + narrows to `Record<string, unknown>` at boot.
   */
  readonly propsJson?: string;
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
   * `props_update` / `render` frames. When set alongside `token` +
   * `expiresAt`, the parser admits the bootstrap as live-mode; when
   * absent, the shell renders the static render but receives no
   * live updates after mount (the bug `/r/<shortCode>` exhibited before
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
   * Monotonic GguiSessionEvent ledger cursor at emit time, mirrored from
   * {@link McpAppAiGguiRenderMeta.lastSequence}. Polling clients
   * initialize the R7 `/events?sinceSequence=N` cursor from this.
   * Absent in pre-R7 envelopes (back-compat); post-R7 it MUST be
   * present.
   */
  readonly lastSequence?: McpAppAiGguiRenderMeta["lastSequence"];
  /**
   * Wire-stamped polling fallback URL — `${base}/api/sessions/<id>/events?wsToken=<...>`.
   * When the iframe-runtime's WS transport reaches `'failed'` (CSP
   * blocks `ws://`, corporate firewall, etc.), `@ggui-ai/live-channel`
   * fails over to cursor-based event polling against this URL using
   * `{@link lastSequence}` as the initial cursor.
   *
   * Absent ⇒ runtime stays in WS-only mode. Operators that want the
   * fallback path lit up MUST thread this through (the first-party
   * shell builders do; callers composing their own shells SHOULD).
   */
  readonly pollingUrl?: McpAppAiGguiRenderMeta["pollingUrl"];
}

/**
 * Build the self-contained shell HTML for a given render.
 *
 * The returned HTML is a complete, standalone document: it inlines the
 * compiled component (base64) + the render id in a `globalThis.__GGUI_META__`
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
 * This builder owns SLICE COMPOSITION (server-side inputs → the typed
 * `ai.ggui/render` slice); the envelope wrapping, script-safe escaping,
 * and HTML assembly are delegated to the protocol host-helper
 * (`gguiShellHtml` in `@ggui-ai/protocol/integrations/mcp-apps`) — the
 * same assembler MCP-Apps hosts use, so served and host-built shells
 * cannot drift.
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
    sessionId: opts.sessionId,
    appId: opts.appId,
    runtimeUrl: opts.runtimeUrl,
    ...(opts.themeId !== undefined ? { themeId: opts.themeId } : {}),
    ...(opts.themeMode !== undefined ? { themeMode: opts.themeMode } : {}),
    // Per-app theme overlay — same field the MCP-Apps `_meta` slice
    // carries, forwarded onto the inline bootstrap so the self-contained
    // shell applies the operator overlay too.
    ...(opts.theme !== undefined ? { theme: opts.theme } : {}),
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

  // Delegate envelope wrapping + HTML assembly to the protocol's
  // host-helper (`gguiShellHtml`) — the SAME assembler MCP-Apps hosts
  // consume — so the server-served shell and host-built shells cannot
  // drift. Routing through `asGguiRenderBootstrap` also proves at
  // build time that the composed slice passes the host-side
  // mountability gate.
  const bootstrap = asGguiRenderBootstrap(toMcpAppEnvelope(render));
  if (bootstrap === undefined) {
    throw new Error(
      "buildSelfContainedShell: composed render slice failed the host mountability gate (empty runtimeUrl?)"
    );
  }
  // 'surface' posture: this shell is ALWAYS the top-level document of a
  // standalone served iframe (claude.ai per-render resource shells,
  // `/r/<shortCode>`), never inlined into a host page — so it paints
  // its own theme-surface backdrop. See `GguiShellHtmlOptions` for the
  // Safari white-canvas rationale.
  return gguiShellHtml(bootstrap, { background: "surface" });
}

/**
 * A `resources/read` on a render locator that cannot return a mount.
 *
 * Thrown rather than returned: the MCP transport turns a thrown error
 * carrying a numeric `code` into a JSON-RPC error response, and a
 * JSON-RPC error is the only exit from the handler that is not a
 * successful result. That is what makes "any successful `contents`
 * result IS a mountable shell" checkable by a host instead of a claim
 * in a docstring.
 *
 * The wire body comes from {@link resourceReadErrorToJsonRpc} and
 * nowhere else. Routing every branch through the protocol's projection
 * is what keeps a refused read and a read of a locator that never
 * existed byte-identical: the projection substitutes a constant message
 * and drops `detail` on `NOT_FOUND`, so no call site can leak a
 * diagnostic by writing a more helpful message.
 */
class ResourceReadFailure extends Error {
  /** JSON-RPC error number — read off this instance by the transport. */
  readonly code: ResourceReadJsonRpcError["code"];
  /** JSON-RPC `error.data` — the closed classification plus optional detail. */
  readonly data: ResourceReadJsonRpcError["data"];

  constructor(failure: ResourceReadError) {
    const wire = resourceReadErrorToJsonRpc(failure);
    super(wire.message);
    this.name = "ResourceReadFailure";
    this.code = wire.code;
    this.data = wire.data;
  }
}

/**
 * The terminal failure for a read that resolved nothing, on a server
 * that DOES keep durable records. One constant, so the branches that
 * must stay indistinguishable — a locator that never existed, one whose
 * record is gone, and one the caller may not read — have no shape in
 * which to differ. The message is stated rather than left blank because
 * the projection substitutes it anyway; writing it makes the call sites
 * honest about what goes on the wire.
 */
const NOT_FOUND_FAILURE: ResourceReadError = {
  code: "NOT_FOUND",
  message: RESOURCE_NOT_FOUND_MESSAGE,
};

/**
 * The terminal failure for the same reads on a server that keeps no
 * durable record. It replaces {@link NOT_FOUND_FAILURE} for EVERY
 * locator on such a server, never for some of them: it describes the
 * server, so a read that answered it for a missing locator and
 * `NOT_FOUND` for an existing-but-refused one would tell a caller which
 * locators exist — the disclosure the access check exists to prevent.
 */
const NOT_SUPPORTED_FAILURE: ResourceReadError = {
  code: "NOT_SUPPORTED",
  message:
    "This server keeps no durable record of a render, so a locator whose render is gone cannot be restored.",
};

/**
 * The three ways a resolved locator still yields nothing to mount. One
 * caller-facing message per code, with `detail` carrying the
 * discrimination — a host's decision is the same for all three, while
 * an operator needs to know which link is missing.
 */
const notMountable = (detail: string): ResourceReadError => ({
  code: "NOT_MOUNTABLE",
  message: "This locator resolved, but nothing mountable can be produced for it.",
  detail,
});

/** Neither delivery channel is wired, so a component cannot reach an iframe. */
const NO_DELIVERY_CHANNEL_FAILURE = notMountable(
  "no static component URL and no live channel is wired"
);

/** The row exists and is the caller's, but its generation has not landed. */
const NOT_YET_COMMITTED_FAILURE = notMountable(
  "the render has not committed a component yet"
);

/** A blueprint matched the locator's key, but its code cannot be delivered. */
const BLUEPRINT_UNDELIVERABLE_FAILURE = notMountable(
  "the matched blueprint has no delivery channel"
);

/**
 * The four ways a durable record stops short of a component. Same
 * shape and the same reasoning as {@link notMountable} above. All four
 * are reachable only after the access check has passed, so naming the
 * step discloses nothing about a locator the caller cannot read.
 */
const blueprintUnresolvable = (detail: string): ResourceReadError => ({
  code: "BLUEPRINT_UNRESOLVABLE",
  message: "The record for this locator no longer resolves to a component.",
  detail,
});

/** What a re-mint attempt produced: the committed row, or why not. */
type RemintOutcome =
  | { readonly ok: true; readonly row: StoredGguiSession }
  | { readonly ok: false; readonly failure: ResourceReadError };

/**
 * The single value returned for BOTH "no record was ever written" and
 * "the caller is not entitled to this record". One shared constant
 * rather than two equal literals: the two branches cannot drift apart
 * later, because there is only one of them to change.
 */
const RECORD_UNAVAILABLE: RemintOutcome = { ok: false, failure: NOT_FOUND_FAILURE };

/**
 * Retention this read path assumes when the operator names none —
 * deliberately the same hour `ggui_render` falls back to, so a
 * deployment that has never set the knob gets one answer rather than
 * two. Every use of it is behind
 * {@link GguiRenderResourceTemplateOptions.renderTtlMs}, which is where
 * a real deployment's retention comes from.
 */
const FALLBACK_RENDER_TTL_MS = 60 * 60 * 1000;

/**
 * Options for {@link registerGguiRenderResourceTemplate}.
 *
 * @public
 */
export interface GguiRenderResourceTemplateOptions {
  /** GguiSessionStore the template handler reads to find the render's
   *  componentCode. */
  readonly renderStore: GguiSessionStore;
  /** Absolute URL of the iframe-runtime bundle inlined in the shell. */
  readonly runtimeUrl: string;
  /**
   * Content-addressable code-blob store. When wired alongside
   * {@link codeBaseUrl}, the resource template hashes the render's
   * componentCode, writes it to the store, and inlines the resulting
   * `codeUrl` into the shell bootstrap.
   *
   * This is one of the two delivery channels; {@link mintWsToken} is
   * the other, and a compiled component needs at least one of them. A
   * read that resolves a render this server can deliver by neither
   * fails with `NOT_MOUNTABLE` rather than returning a shell that would
   * never paint.
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
   * the render gate reads. Absent ⇒ publicEnv stays empty on the
   * resource-served bootstrap (wrappers calling `getPublicEnv` throw
   * at hook-mount with a clear "not provided" message).
   */
  readonly appMetadataStore?: import("@ggui-ai/mcp-server-core").AppMetadataStore;
  /**
   * Durable per-session identity records. When wired alongside
   * {@link durableBlueprints}, a read of a locator whose render row is
   * GONE resolves the record instead of giving up: the render is
   * re-created from it and mounts live, with the props it last
   * carried.
   *
   * Absent ⇒ neither store is consulted, and `NOT_SUPPORTED` takes
   * `NOT_FOUND`'s place wholesale — the honest answer for a server on
   * which an evicted locator can never come back. Wholesale is the
   * load-bearing word: it answers for a locator that never existed AND
   * for one whose row exists but the caller may not read, so the choice
   * of code says nothing about which locators exist. Reads that get far
   * enough to fail `NOT_MOUNTABLE` still do — that verdict is about the
   * caller's own render, not about this server's memory.
   *
   * Binding a store whose records do not outlive the render rows
   * themselves buys nothing — the record is read precisely when the
   * row is gone.
   */
  readonly renderIdentityStore?: import("@ggui-ai/mcp-server-core").RenderIdentityStore;
  /**
   * Durable blueprint pair — row metadata plus the compiled body
   * behind its content hash. The re-mint path needs BOTH halves: the
   * record names a blueprint, the blueprint names a body, and the body
   * is what a re-created render mounts. A pair carrying only
   * `blueprintStore` persists metadata for other consumers but cannot
   * complete a re-mint, so the path skips as if unwired.
   *
   * Same shape the registration path writes through, so a deployment
   * threads one pair to both ends.
   */
  readonly durableBlueprints?: BlueprintDurabilityDeps;
  /**
   * Render-row retention window in ms — the SAME operator knob
   * `ggui_render` stamps new renders with. The read path spends it in
   * two places, and both are lifecycle decisions about a row this
   * handler is putting back into service:
   *
   *   - a re-mint commits its reconstructed row with this lifetime;
   *   - a read of a row that is present but PAST its expiry gives the
   *     row this lifetime again, so the live-channel token minted in
   *     the same read cannot outlive the row it addresses.
   *
   * Absent ⇒ one hour, matching `ggui_render`'s own fallback. Setting
   * it on a deployment whose renders live far longer than an hour is
   * what stops a rehydrated render from being quietly demoted to a
   * fraction of its neighbours' lifetime.
   */
  readonly renderTtlMs?: number;
  /**
   * Vector store backing the blueprint registry. When wired alongside
   * `defaultAppIdFallback`, the resource handler runs a registry-only
   * rehydrate fallback for the two-segment URI shape
   * (`ui://ggui/render/{sessionId}/{blueprintKey}`): if the render is
   * gone but the blueprint registry still holds the entry, return the
   * static initial render (default props + default context) instead of
   * failing the read.
   *
   * The lookup is keyed by the caller-supplied `blueprintKey` under
   * `defaultAppIdFallback` alone — it never reads the render row — so
   * it answers the same for a caller who may not read the row as for
   * one probing a locator that never existed. That is what keeps it
   * safe to run on a refused read, which it must, or refusal would
   * become distinguishable from a miss.
   *
   * Leaving both options undefined does NOT return callers to a
   * placeholder shell — there is no longer one to return. It removes
   * the third resolution, so a read that neither the row nor a re-mint
   * can serve fails typed: `NOT_FOUND`, or `NOT_SUPPORTED` on a
   * deployment that also keeps no durable record, or `NOT_MOUNTABLE`
   * where the row is the caller's own and simply has no component yet.
   * Deployments serving
   * more than one tenant from one registry scope are the reason the
   * option exists at all: the fallback discloses whether a blueprint
   * key exists under that scope, so leave it unset if that is not
   * acceptable.
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
   * App-id used for blueprint-registry scoping when the render has
   * been evicted. The registry is per-`appId`, but a missing render
   * has no way to derive whose it was, so the fallback needs one scope
   * named up front. Set to `'builder'` (the universal-MCP default
   * identity) and rehydrate works across render expiry / process
   * restart.
   *
   * Leaving it undefined disables the fallback entirely — the reads it
   * would have served fail typed instead (`NOT_FOUND`, or
   * `NOT_SUPPORTED` where no durable record is kept). That is the
   * setting for a deployment that cannot accept the fallback answering
   * "a blueprint with this key exists under this scope" to whoever
   * asks; it is not a way to get a gentler response.
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
    sessionId: string,
    appId: string,
  ) => {
    readonly wsUrl: string;
    readonly token: string;
    readonly expiresAt: string;
  };
  /**
   * Per-request handler-context accessor — the SAME AsyncLocalStorage
   * read the tool path uses. The per-session resource handler gates
   * reads on it (render-read-gate.ts). Absent ⇒ the handler fails
   * closed for rows scoped to any app other than the single-tenant
   * default (compose paths that cannot thread a context keep working
   * for OSS single-tenant flows only).
   */
  readonly getContext?: () => HandlerContext | undefined;
  /**
   * Structured logger for warn-level denial audit lines
   * (`render_resource_read_denied`). Absent ⇒ denials are silent
   * server-side (still enforced — only the log line is skipped).
   */
  readonly logger?: Logger;
}

/**
 * Renderable picked from a {@link GguiSession} — discriminates between
 * compiled-component renders (carry `componentCode`) and
 * server-emitted system cards (carry `kind`). The shell builders
 * stamp one or the other into `__GGUI_META__`; the runtime
 * decodes by presence of `kind`.
 *
 * Phase B: a render IS the addressable unit — there is no enclosing
 * stack vessel — so this helper is a direct narrowing of a single
 * {@link GguiSession}, not a pick-from-stack scan.
 */
type RenderRenderable =
  | {
      kind?: undefined;
      id: string;
      componentCode: string;
      props?: Record<string, unknown>;
      /** Original source render — carried so the resource handler can
       *  thread it through `deriveRenderMeta` for projection of
       *  permissions / contextSlots. */
      source: GguiSession;
    }
  | {
      kind: string;
      id: string;
      componentCode?: undefined;
      props?: Record<string, unknown>;
      source: GguiSession;
    };

function pickComponentFromGguiSession(render: GguiSession | null | undefined): RenderRenderable | null {
  if (!render) return null;
  if (render.type === "mcpApps") return null;
  const propsRaw = "props" in render ? render.props : undefined;
  const props = isRecord(propsRaw) ? propsRaw : undefined;
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
 * Register a `ui://ggui/render/{sessionId}` resource template. Each
 * `resources/read` request is resolved by looking up the render in the
 * store and returning the self-contained shell with that
 * componentCode inlined.
 *
 * Per-call `_meta.ui.resourceUri` (stamped by `ggui_render.resultMeta`)
 * pins the URI to a specific sessionId; hosts fetch THAT URI rather
 * than the static `ui://ggui/render` one. Both registrations co-exist:
 * legacy postMessage shell at the static URI, self-contained shell at
 * the templated URI.
 *
 * # The obligation
 *
 * A read returns EITHER a shell carrying mount material — a static
 * component URL, a live channel, or a system card — OR exactly one
 * typed JSON-RPC error. There is no third outcome, and in particular no
 * successful result wrapping a shell that can never paint anything. A
 * host can check this without trusting the server: if it got
 * `contents`, it got something mountable.
 *
 * The obligation covers outcomes this server can DECIDE. A malfunction
 * still reaches the caller as an internal error (`-32603`) carrying
 * none of the four codes: a template wired with an empty `runtimeUrl`,
 * or a delivery channel that faults **and leaves the read with no other
 * channel to mount through**. A fault the read survives — the usual
 * case on a deployment wiring both channels — is not an outcome at all;
 * the render mounts through whatever is left. That split is deliberate:
 * `-32603` says "something is broken here", which the four codes must
 * never be diluted into claiming, and equally must not be raised over a
 * blip the server routed around.
 *
 * Three resolutions are tried, in this order, and any of them can
 * produce the mount:
 *
 *   1. The render row itself.
 *   2. A re-mint from the durable identity record, when the row is gone
 *      and this server keeps one ({@link GguiRenderResourceTemplateOptions.renderIdentityStore}
 *      + {@link GguiRenderResourceTemplateOptions.durableBlueprints}).
 *   3. The blueprint registry, keyed by the locator's own `blueprintKey`
 *      — the original component with its authoring-time defaults rather
 *      than the state the render last held.
 *
 * # Failure modes
 *
 * Which code a given read produces is fully predictable from two facts:
 * whether this server binds a durable substrate (both
 * {@link GguiRenderResourceTemplateOptions.renderIdentityStore} and
 * {@link GguiRenderResourceTemplateOptions.durableBlueprints} — either
 * one alone is as good as neither), and how far the read got.
 *
 *   - `NOT_FOUND` (`-32002`) — nothing resolved the locator, **and** the
 *     response for a caller who may not read a locator that DOES
 *     resolve. Those two are byte-identical by construction: both route
 *     through the protocol's projection, which substitutes a constant
 *     message and drops `detail`. A distinguishable refusal would turn
 *     this read into an oracle for the existence of other callers'
 *     renders, so the equality is a security property, not a courtesy.
 *   - `NOT_SUPPORTED` (`-32006`) — the same two cases, on a server with
 *     no durable substrate: an evicted locator can never be restored
 *     here, so saying "not found" would understate it. It takes
 *     `NOT_FOUND`'s place WHOLESALE on such a server rather than
 *     answering for some locators and not others — a server that said
 *     `NOT_FOUND` for a row it refused and `NOT_SUPPORTED` for one that
 *     never existed would have rebuilt the same oracle out of the two
 *     codes. Correspondingly, a server that DOES bind the substrate
 *     never emits it.
 *   - `BLUEPRINT_UNRESOLVABLE` (`-32006`) — a record named the render
 *     but its component is gone; `detail` names which link broke.
 *     Reachable only after the access check.
 *   - `NOT_MOUNTABLE` (`-32006`) — something resolved, but nothing
 *     mountable can be produced from it: no delivery channel is wired
 *     (neither {@link GguiRenderResourceTemplateOptions.codeStore} nor
 *     {@link GguiRenderResourceTemplateOptions.mintWsToken}), the row's
 *     generation has not committed a component yet, or a registry
 *     blueprint matched but cannot be delivered. Unlike the pair above,
 *     this one does NOT vary with the substrate: it is what the
 *     caller's OWN row gets on every server, because "this server
 *     cannot rehydrate" is not the useful truth for a row that is
 *     sitting right there. Reachable only after the access check, or —
 *     for the registry case — off the caller's own supplied key, so it
 *     discloses nothing either way.
 *
 * A URI matching neither template never reaches any of this: the
 * transport rejects it as invalid params, outside these four codes.
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
  //   1. Single-segment legacy URI — `ui://ggui/render/{sessionId}`.
  //      Pre-resume-contract chats in claude.ai's history persisted
  //      this shape; we keep the registration so historical messages
  //      still rehydrate.
  //
  //   2. Two-segment resume URI — `ui://ggui/render/{sessionId}/
  //      {blueprintKey}`. Stamped by every render since the resume
  //      contract landed. Carries enough state for the handler to
  //      fall back to a registry-only render when the render is gone
  //      but the blueprint is still cached (the original card with
  //      default props/context instead of a typed failure).
  //
  //      Both shapes ALSO re-mint from a durable identity record when
  //      the deployment keeps one — that path is keyed by sessionId
  //      alone and needs no blueprintKey, so it serves the legacy
  //      shape too. Every lookup either shape triggers happens after
  //      the access check, never in parallel with it.
  const legacyTemplate = new ResourceTemplate(`${GGUI_RENDER_RESOURCE_URI}/{sessionId}`, {
    // No list-callback — the resource set is unbounded per render
    // count, and `resources/list` would leak render ids across
    // tenants. Hosts discover specific URIs via per-call `_meta.ui.
    // resourceUri` instead.
    list: undefined,
  });
  const resumeTemplate = new ResourceTemplate(
    `${GGUI_RENDER_RESOURCE_URI}/{sessionId}/{blueprintKey}`,
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
   * the per-render augmentation, gadget bundle / style / API
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
  /**
   * The three stores a re-mint needs, or `null` when this server keeps
   * no durable record of a render.
   *
   * Read through ONE accessor because two callers depend on the same
   * answer: the re-mint itself, and the handler's choice of terminal
   * failure. Deriving that choice separately is how a server could end
   * up answering `NOT_SUPPORTED` for some locators and `NOT_FOUND` for
   * others, which is a disclosure rather than a cosmetic difference.
   */
  function durableSubstrate(): {
    readonly identityStore: NonNullable<
      GguiRenderResourceTemplateOptions["renderIdentityStore"]
    >;
    readonly blueprintStore: NonNullable<BlueprintDurabilityDeps["blueprintStore"]>;
    readonly bodyStore: NonNullable<BlueprintDurabilityDeps["codeStore"]>;
  } | null {
    const identityStore = opts.renderIdentityStore;
    const blueprintStore = opts.durableBlueprints?.blueprintStore;
    const bodyStore = opts.durableBlueprints?.codeStore;
    if (!identityStore || !blueprintStore || !bodyStore) return null;
    return { identityStore, blueprintStore, bodyStore };
  }

  /** Operator retention, or the shared fallback. Read in both places. */
  const renderTtlMs = opts.renderTtlMs ?? FALLBACK_RENDER_TTL_MS;

  /**
   * Give a row that has outlived its `expiresAt` a full lifetime again.
   *
   * A store may keep a row readable past its expiry — the reaper runs
   * on its own schedule, and some stamp the deletion deadline with a
   * grace window on top. A read landing in that window is a caller
   * entitled to the row proving they are actively using it, which is
   * the same signal every other touch-and-extend path acts on, so the
   * row gets its lifetime back.
   *
   * The live-channel token is the SHARPEST case, not the only one: a
   * read that mints one turns "the row dies soon" into "the thing I
   * was just handed outlives what it points at". But a deployment with
   * no minter wired reaches this too, and its row earns the same
   * extension — the read was just as real. Widening this to any active
   * use is why the call site sits ahead of the mint rather than inside
   * it.
   *
   * CONDITIONAL, and that is the load-bearing half: a resource read is
   * the hottest path this handler has, so extending a row that is
   * already live would put a store write on every read of every render
   * for nothing.
   *
   * A failure does not fail the read. The caller owns this render and
   * the handler can mount it; refusing over an extension would turn a
   * store's bad moment into a dead card, and the pre-extension
   * behavior — a token that may outlive its row — is what the read
   * would have done anyway. It is logged rather than swallowed,
   * because a row that could not be extended is now living on borrowed
   * time and nothing else will say so.
   *
   * One asymmetry worth knowing about: this moves the row's OWN
   * `expiresAt`, and the render payload stored inside it keeps the
   * value stamped at the last commit. Two spellings of one fact,
   * briefly disagreeing. Which one a reader sees is the store's
   * business — a store that re-projects lifecycle columns onto the
   * payload heals it on the very next read, one that stores the payload
   * verbatim carries the stale copy until the next commit. The
   * authoritative field is the row's, which is what the lifecycle
   * gates and the reaper both read; the payload's copy is a projection
   * for the wire. Extending both here would mean rewriting the payload
   * on a read, which is a much larger write for a field nothing gates
   * on.
   */
  async function extendExpiredRow(
    sessionId: string,
    stored: StoredGguiSession,
  ): Promise<void> {
    const now = Date.now();
    if (stored.expiresAt > now) return;
    try {
      await opts.renderStore.update(sessionId, { expiresAt: now + renderTtlMs });
    } catch (cause) {
      opts.logger?.warn("render_resource_ttl_extend_failed", {
        sessionId,
        expiredAt: stored.expiresAt,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /**
   * Rehydration access control (spec §3), applied to ONE read
   * candidate — a render row, or the durable identity record that
   * stands in for an evicted one. Both carry the same two gated
   * fields, so both go through here.
   *
   * The anonymous-context synthesis is why this is shared rather than
   * inlined twice: a compose path that cannot thread a request context
   * still reads renders owned by the default builder identity, because
   * a candidate owned by THAT identity is attributed to an anonymous
   * caller. Anything else fails closed — `renderReadAllowed` denies a
   * missing context outright. Losing the synthesis on the record path
   * would break exactly the deployments the re-mint exists to help.
   *
   * Refusal is never an early return at the call sites: it collapses
   * the candidate to "absent" so every downstream branch runs as it
   * would for a locator that never existed. The refusal is observable
   * only server-side, on the audit line below — whose `rowAppId` names
   * the render's owner whichever store answered for it.
   */
  function readAllowed(sessionId: string, candidate: RenderReadRowView): boolean {
    const callerCtx = opts.getContext?.();
    const fallbackCtx =
      callerCtx === undefined && candidate.appId === DEFAULT_BUILDER_APP_ID
        ? {
            appId: DEFAULT_BUILDER_APP_ID,
            authSource: "anonymous" as const,
            requestId: "resource-read",
          }
        : callerCtx;
    if (renderReadAllowed(candidate, fallbackCtx)) return true;
    opts.logger?.warn("render_resource_read_denied", {
      sessionId,
      rowAppId: candidate.appId,
      callerAppId: callerCtx?.appId,
    });
    return false;
  }

  /**
   * Re-mint an evicted locator from its durable identity record: the
   * record names the blueprint, the blueprint names the body, and the
   * body is committed back onto a FRESH row under the same sessionId.
   * Returns the committed row, or the failure that stopped it.
   *
   * The two branches that must stay indistinguishable — no record was
   * ever written, and the caller is not entitled to the one that was —
   * return the SAME constant, so there is no shape in which they could
   * differ. Every other failure is reachable only after the access
   * check has passed, and so may say what went wrong.
   *
   * Ordering is load-bearing. The record's own owner gates the read
   * before ANY blueprint or body lookup runs, and every lookup is
   * keyed by the record's `blueprintId` under the record's own owner —
   * never by a caller-supplied key. A resolution step reachable before
   * the check would let a caller distinguish a resolvable locator from
   * one that never existed, which is the same disclosure the gate
   * exists to prevent.
   *
   * The body is INLINED onto the committed row rather than delivered
   * by URL: a row carrying its own component code is self-sufficient,
   * so the existing mount path serves it with no extra wiring, and
   * deployments with no content-addressed delivery channel re-mint
   * just as well as those with one.
   *
   * Store faults are not caught. A rejecting store is a malfunction,
   * and swallowing it here would report a working render as
   * unresolvable — indistinguishable from one that was genuinely
   * purged, and it would stay that way on every retry.
   */
  async function remintFromRecord(sessionId: string): Promise<RemintOutcome> {
    const substrate = durableSubstrate();
    if (substrate === null) return { ok: false, failure: NOT_SUPPORTED_FAILURE };
    const { identityStore, blueprintStore, bodyStore } = substrate;

    const record = await identityStore.get(sessionId);
    if (record === null) return RECORD_UNAVAILABLE;

    if (
      !readAllowed(sessionId, {
        appId: record.appId,
        // The record's SUBJECT — the same field the row's gate binds
        // on, written by the same commit.
        ...(record.userId !== undefined ? { userId: record.userId } : {}),
      })
    ) {
      return RECORD_UNAVAILABLE;
    }

    // Everything below can only be reached by a caller entitled to
    // this locator. A null `blueprintId` is terminal (#460): the id is
    // resolved before the success commit, so null means registration
    // failed or was unavailable at commit — the record names nothing
    // to resolve, by design (#445).
    if (record.blueprintId === null) {
      return { ok: false, failure: blueprintUnresolvable("the record names no blueprint") };
    }
    const blueprint = await blueprintStore.get(record.blueprintId);
    if (blueprint === null) {
      return {
        ok: false,
        failure: blueprintUnresolvable("the blueprint the record names is gone"),
      };
    }
    const codeHash = blueprint.codeHash;
    if (codeHash === undefined) {
      return {
        ok: false,
        failure: blueprintUnresolvable("the blueprint stores no component reference"),
      };
    }
    const componentCode = await bodyStore.get(codeHash);
    if (componentCode === null || componentCode.length === 0) {
      return {
        ok: false,
        failure: blueprintUnresolvable("the component body behind the blueprint is gone"),
      };
    }

    // Sidecars are re-resolved from the live app record rather than
    // carried on the record: gadget descriptors and the theme overlay
    // are the operator's current configuration, and a re-minted render
    // should mount under it, not under a snapshot of what it was.
    //
    // Degrades rather than fails, matching the same lookup on the mount
    // path below: these are presentation sidecars, so a metadata store
    // having a bad moment costs the render its theme and its wrapper
    // catalog — it must not cost the render its rehydrate. The body and
    // the props, which a mount cannot do without, were already resolved
    // above and are NOT part of this tolerance.
    let gadgetDescriptors: ComponentGguiSession["gadgetDescriptors"];
    let theme: ComponentGguiSession["theme"];
    if (opts.appMetadataStore) {
      try {
        const appRecord = await opts.appMetadataStore.get(record.appId);
        const resolved = filterDescriptorsToContract(
          blueprint.contract,
          resolveAppGadgets(appRecord?.gadgets)
        );
        if (resolved.length > 0) gadgetDescriptors = resolved;
        theme = appRecord?.theme;
      } catch {
        // Silent — the render mounts with the renderer's default theme
        // and a STDLIB-only wrapper catalog.
      }
    }

    const now = Date.now();
    const contract = blueprint.contract;
    const render: ComponentGguiSession = {
      type: "component",
      id: sessionId,
      appId: record.appId,
      componentCode,
      contentType: "application/javascript+react",
      // The props the render last carried — the whole point of the
      // record — restored verbatim, including their ABSENCE. A record
      // with no props describes a render that had none, so the re-mint
      // gives it none: `props` is optional on the wire shape and the
      // record round-trips the distinction.
      //
      // The one thing this must never do is substitute authoring-time
      // defaults for missing props. Nothing repopulates a
      // defaults-booted card afterwards — props travel the session
      // channel, and no agent turn runs at rehydration — so it would
      // show plausible-looking wrong state indefinitely, which is
      // worse than showing none.
      ...(record.props !== undefined ? { props: record.props } : {}),
      ...(contract.propsSpec ? { propsSpec: contract.propsSpec } : {}),
      ...(contract.actionSpec ? { actionSpec: contract.actionSpec } : {}),
      ...(contract.streamSpec ? { streamSpec: contract.streamSpec } : {}),
      ...(contract.contextSpec ? { contextSpec: contract.contextSpec } : {}),
      ...(contract.clientCapabilities
        ? { clientCapabilities: contract.clientCapabilities }
        : {}),
      ...(gadgetDescriptors !== undefined ? { gadgetDescriptors } : {}),
      ...(theme !== undefined ? { theme } : {}),
      // Carried from the record so a re-minted render does not present
      // itself as newly created.
      createdAt: record.createdAt,
      lastActivityAt: now,
      expiresAt: now + renderTtlMs,
      // States the same fact as the `seqFloor` below, which is what
      // the store actually seeds the row's ledger from.
      eventSequence: record.seqAtLastCommit,
    };
    const row = await opts.renderStore.commit({
      render,
      appId: record.appId,
      ...(record.userId !== undefined ? { userId: record.userId } : {}),
      // The render resumes rather than restarts: its ledger continues
      // above where the record says it last was, so a reader still
      // holding a cursor from before the eviction sees the new events
      // instead of filtering them out as already-seen.
      //
      // "Where the record says it last was" is the honest bound. The
      // record samples the sequence at COMMIT, so events appended
      // between the last commit and the eviction are not reflected and
      // their numbers do get reissued. This narrows sequence reuse to
      // that window rather than eliminating it — which is the best any
      // record-based resume can do, and still strictly better than
      // restarting the ledger at zero.
      seqFloor: record.seqAtLastCommit,
    });
    return { ok: true, row };
  }

  /**
   * Serve the self-contained shell for a render row — the mount path,
   * shared by rows read from the store and rows a re-mint just
   * committed.
   *
   * Three exits, and the caller has to handle all three:
   *
   *   - a response, when the row resolved to something mountable;
   *   - `null`, when the row carries no renderable visible-bits surface
   *     (a placeholder whose generation has not committed yet), so the
   *     caller can go on looking;
   *   - a thrown {@link ResourceReadFailure}, when a render DID resolve
   *     but no channel can deliver it. That one is terminal by design —
   *     it is the deepest the read gets, so there is nothing left for
   *     the caller to try.
   */
  async function serveMount(
    uri: URL,
    sessionId: string,
    accessibleStored: StoredGguiSession
  ): Promise<{ contents: ShellContent[] } | null> {
    const picked = pickComponentFromGguiSession(accessibleStored.render);
    if (!picked) return null;
    // Put an expired-but-still-readable row back on a full lifetime.
    //
    // The reason is that a caller entitled to this row has just proved
    // they are using it, which is the same signal every other
    // touch-and-extend path acts on. The live-channel token is the
    // sharpest case rather than the only one — it turns "the row dies
    // soon" into "the thing I just handed you outlives what it points
    // at" — which is why this sits ahead of the mint below. But a
    // deployment with no minter wired reaches here too, and its row
    // deserves the same extension: the read was just as real.
    //
    // After the `picked` check, because a row with nothing to mount is
    // not a row anyone is using yet.
    await extendExpiredRow(sessionId, accessibleStored);
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

    // A fault on EITHER delivery channel, held rather than acted on.
    //
    // Two things have to stay true at once. A channel that faulted must
    // never be reported as a channel that was never wired — that is
    // NOT_MOUNTABLE, which rides -32006 and tells the host the outcome
    // is deterministic and a retry cannot succeed, when a store having
    // a bad moment is the one thing that is not. But most deployments
    // wire BOTH channels, and there a fault on one is survivable: the
    // other still carries the mount, and failing the read would throw
    // away a perfectly good delivery path.
    //
    // So the fault is remembered here and consulted at the mount-mode
    // gate, which is the only place that knows whether anything
    // survived. If a channel did, the render mounts through it and the
    // fault costs the read nothing. If none did, the fault is thrown in
    // place of NOT_MOUNTABLE and reaches the caller as an internal
    // error — the honest answer for a blip, and the same policy the
    // re-mint path applies to its own stores.
    //
    // Wrapped in an object so a thrown `undefined` is still recorded as
    // a fault, and `??=` keeps the FIRST one when both channels break.
    let channelFault: { readonly cause: unknown } | undefined;

    // Static-component delivery via codeUrl. The compiled-component
    // path mints a content-addressable URL the iframe-runtime fetches
    // at boot. When codeStore + codeBaseUrl aren't wired this channel
    // simply does not exist, and the live channel below has to carry
    // the mount.
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
      } catch (cause) {
        channelFault ??= { cause };
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
        // Silent, and unlike the two channel faults this one stays
        // that way: validators are an optional client-side courtesy,
        // the server-side gate is authoritative, and losing them costs
        // the read nothing it needs to mount. It cannot be mistaken for
        // an absent channel, which is what makes swallowing it safe
        // here and not above.
      }
    }
    // The codeUrl gate is applied AFTER the live-channel mint below, so
    // a render with no static codeUrl still mounts via live-mode
    // (wsUrl + wsToken) instead of failing as undeliverable —
    // parity with the `/r/<shortCode>` path. (See the gate after the
    // mint.) This matters for deployments that wire `mintWsToken` but no
    // `codeStore`/`codeBaseUrl` (e.g. the cloud pod): the agent-server
    // inlines THIS resource, so without live-mode every render on such a
    // deployment would resolve fine and then be reported as having no
    // way to be delivered.

    // Project the wrapper catalog AND the union-filtered
    // publicEnv onto the inline bootstrap so the resource-served
    // iframe matches the MCP-Apps postMessage path. Without this,
    // wrapper-using contracts rendered through `resources/read`
    // mount as STDLIB-only.
    let resourcePublicEnv: Readonly<Record<string, string>> | undefined;
    if (opts.appMetadataStore) {
      try {
        const appRecord = await opts.appMetadataStore.get(accessibleStored.appId);
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
    //
    // A mint FAULT is held the same way the code-store write above is,
    // for the same reason: `wsToken` left undefined is indistinguishable
    // from "no live channel is wired" by the time the gate reads it.
    let wsUrl: string | undefined;
    let wsToken: string | undefined;
    let wsExpiresAt: string | undefined;
    if (opts.mintWsToken) {
      try {
        const minted = opts.mintWsToken(sessionId, accessibleStored.appId);
        wsUrl = minted.wsUrl;
        wsToken = minted.token;
        // Forward the token TTL so the iframe-runtime can degrade to
        // static-only mode once it lapses (parity with the render-tool
        // slice projection, render.ts). Dropping it left the live-mode
        // resource shell unable to know when its WS token expired.
        wsExpiresAt = minted.expiresAt;
      } catch (cause) {
        channelFault ??= { cause };
      }
    }

    // Mount-mode gate (below the live-channel mint): a compiled
    // component needs ONE of the two channels. A deployment that wires
    // no codeStore (codeUrl === undefined) but DOES wire mintWsToken
    // mounts via live-mode; one that wires neither has resolved a
    // render it cannot deliver, and says so.
    //
    // Terminal, deliberately: this is the deepest the read gets, so
    // there is nothing left to try. It also has to stay AHEAD of
    // `buildSelfContainedShell`, which throws a plain Error on the same
    // condition — that would reach the caller as an untyped internal
    // error announcing a malfunction where the server is behaving
    // exactly as configured.
    //
    // Reaching here having FAULTED is the one case that is not the
    // server behaving as configured, and it is the only place with
    // enough information to tell: a fault matters exactly when nothing
    // else produced a channel. Anywhere above this line the same fault
    // may have been survivable, and on a deployment wiring both
    // channels it usually is.
    if (!isSystem && codeUrl === undefined && (wsUrl === undefined || wsToken === undefined)) {
      if (channelFault !== undefined) throw channelFault.cause;
      throw new ResourceReadFailure(NO_DELIVERY_CHANNEL_FAILURE);
    }

    const html = buildSelfContainedShell({
      sessionId,
      appId: accessibleStored.appId,
      ...(isSystem
        ? { systemKind: picked.kind }
        : codeUrl !== undefined
          ? {
              codeUrl,
              ...(codeHash !== undefined ? { codeHash } : {}),
            }
          : // No static codeUrl → live-mode (wsUrl + token spread below)
            // carries the render; buildSelfContainedShell accepts
            // live-mode without codeUrl.
            {}),
      runtimeUrl: opts.runtimeUrl,
      ...(wsUrl !== undefined && wsToken !== undefined
        ? {
            wsUrl,
            token: wsToken,
            ...(wsExpiresAt !== undefined ? { expiresAt: wsExpiresAt } : {}),
          }
        : {}),
      ...(opts.themeId !== undefined ? { themeId: opts.themeId } : {}),
      ...(opts.themeMode !== undefined ? { themeMode: opts.themeMode } : {}),
      // Per-app theme overlay projected by `deriveRenderMeta` from
      // the render's `theme` sidecar — forwarded so the
      // resource-served iframe matches the postMessage path.
      ...(view.theme !== undefined ? { theme: view.theme } : {}),
      ...(view.propsJson !== undefined ? { propsJson: view.propsJson } : {}),
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
      lastSequence: accessibleStored.eventSequence,
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

  // Single shared handler powers both templates. `blueprintKey` is
  // optional in the variables map — present for the resume URI shape,
  // absent for the legacy single-segment shape.
  async function handle(
    uri: URL,
    variables: Record<string, string | string[]>
  ): Promise<{ contents: ShellContent[] }> {
    const sessionIdRaw = variables["sessionId"];
    const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      // A URI with no session segment names no locator, which is the
      // same thing as naming one that does not exist.
      throw new ResourceReadFailure(NOT_FOUND_FAILURE);
    }
    const blueprintKeyRaw = variables["blueprintKey"];
    const blueprintKey = Array.isArray(blueprintKeyRaw) ? blueprintKeyRaw[0] : blueprintKeyRaw;
    const hasResumeKey = typeof blueprintKey === "string" && blueprintKey.length > 0;

    // The failure this read ends in if nothing mounts. Seeded from a
    // property of the SERVER, never of the locator, so a caller cannot
    // read the answer as a statement about which locators exist; the
    // branches below refine it only where the access check has already
    // passed.
    let failure: ResourceReadError =
      durableSubstrate() === null ? NOT_SUPPORTED_FAILURE : NOT_FOUND_FAILURE;

    const stored = await opts.renderStore.get(sessionId);

    // Rehydration access control (spec §3): gate BEFORE any shell
    // bytes, code hashing, or token mint. Refusal does NOT
    // early-return — it nulls out row access into `accessibleStored`
    // so every downstream branch (mount, re-mint, registry fallback,
    // terminal failure) runs exactly as if the row were absent. A
    // refusal on the resume URI must fall through to the SAME
    // registry-only fallback a genuine miss would hit (the fallback is
    // keyed off the caller-supplied blueprintKey + registry defaults,
    // never off the refused row) — otherwise refusal would
    // short-circuit to its own error while a miss of the same
    // blueprintKey resolves the registry shell, leaking row existence
    // to a same-probe attacker.
    const accessibleStored =
      stored !== null &&
      stored !== undefined &&
      readAllowed(sessionId, {
        appId: stored.appId,
        // #446 — the row's SUBJECT is `userId`, written at commit.
        // This used to project `endUserIdentity`, which nothing has
        // written since the repo split, so the subject rung never
        // bound.
        ...(stored.userId !== undefined ? { userId: stored.userId } : {}),
      })
        ? stored
        : null;

    // Live state first: render present and renderable mounts with the
    // current props + current contextSpec values.
    if (accessibleStored) {
      const served = await serveMount(uri, sessionId, accessibleStored);
      if (served !== null) return served;
      // The row is here and the caller may read it; it simply has no
      // component yet, because the generation that will fill it has not
      // committed. Safe to say so — this branch is past the check, so
      // it can only ever describe a locator the caller is entitled to.
      failure = NOT_YET_COMMITTED_FAILURE;
    }

    // Re-mint: the row is GONE and the deployment keeps a durable
    // record of what it was. Gated on the row being genuinely absent
    // rather than merely unreadable — a re-mint COMMITS, and a commit
    // fired while a row exists would overwrite live state (or another
    // party's) with a reconstruction. A refused read still reaches the
    // same fallback and the same terminal failure a miss reaches, so
    // nothing here tells the two apart.
    if (stored === null || stored === undefined) {
      const reminted = await remintFromRecord(sessionId);
      if (reminted.ok) {
        const served = await serveMount(uri, sessionId, reminted.row);
        if (served !== null) return served;
      } else {
        failure = reminted.failure;
      }
    }

    // Registry-only fallback: render is gone (TTL / restart) but the
    // blueprint is still in the registry. Synthesize the shell from
    // the blueprint's componentCode + propsSpec defaults — strictly
    // worse than the live mount (no current props, no preserved
    // context state), but a real mount rather than a failure.
    //
    // It runs on EVERY path that has not mounted, including a refused
    // one, and that is load-bearing: it is keyed by the caller-supplied
    // blueprintKey under the registry default and never by the row, so
    // a refusal and a miss of the same key resolve the same shell. A
    // refusal that skipped it would be distinguishable from a miss.
    //
    // The lookup runs HERE, not before the gate. It is keyed by a
    // caller-supplied blueprintKey under a registry default, so firing
    // it ahead of the access check spent a lookup on every read and
    // put blueprint-existence work in front of the one check that
    // decides whether the caller may learn anything at all.
    const blueprint =
      hasResumeKey && opts.vectorStore && opts.index && opts.defaultAppIdFallback
        ? await findBlueprintExact(
            { vectorStore: opts.vectorStore, index: opts.index },
            opts.defaultAppIdFallback,
            "template",
            // Resume URI carries only a contract hash — omit variantKey
            // so the lookup resolves the default variant.
            blueprintKey
          )
        : null;
    if (blueprint && opts.defaultAppIdFallback) {
      const html = await buildShellFromBlueprint({
        sessionId,
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
      // A blueprint matched, but `buildShellFromBlueprint` needs the
      // static-delivery pair to turn one into a shell. Its own failure,
      // not the one held above: what the read found is a component it
      // cannot deliver, and that answer depends only on the
      // caller-supplied key and this server's wiring — identical for a
      // refused read and a miss of the same key.
      throw new ResourceReadFailure(BLUEPRINT_UNDELIVERABLE_FAILURE);
    }

    throw new ResourceReadFailure(failure);
  }

  server.registerResource(
    "ggui-render-self-contained",
    legacyTemplate,
    {
      title: "ggui render (self-contained, legacy URI)",
      description:
        "Per-render self-contained shell — single-segment URI shape predating the resume contract. A read returns a mountable shell or exactly one typed JSON-RPC error, never a shell that cannot paint. Carrying no blueprintKey, this shape cannot reach the blueprint-registry fallback; a server that keeps durable identity records still re-mints it, since that path is keyed by sessionId alone. Failures: NOT_FOUND (-32002) when nothing resolves the locator, and identically when the caller may not read one that does; NOT_SUPPORTED (-32006) in place of NOT_FOUND on a server that keeps no durable record, for both of those cases alike; BLUEPRINT_UNRESOLVABLE (-32006) when a record names a component that is gone; NOT_MOUNTABLE (-32006) when the caller's own render resolved but nothing mountable can be produced from it, on any server.",
      mimeType: GGUI_RENDER_RESOURCE_MIME,
    },
    handle
  );

  server.registerResource(
    "ggui-render-self-contained-resume",
    resumeTemplate,
    {
      title: "ggui render (self-contained, resume URI)",
      description:
        "Per-render self-contained shell — two-segment URI shape carrying both sessionId AND blueprintKey. A read returns a mountable shell or exactly one typed JSON-RPC error, never a shell that cannot paint. When the render has been evicted the handler tries, in order and only after the access check: a re-mint from the durable identity record, then a registry-only static render from the blueprintKey. Failures: NOT_FOUND (-32002) when neither resolves the locator, and identically when the caller may not read one that does; NOT_SUPPORTED (-32006) in place of NOT_FOUND on a server that keeps no durable record, for both of those cases alike; BLUEPRINT_UNRESOLVABLE (-32006) when a record names a component that is gone; NOT_MOUNTABLE (-32006) when the caller's own render, or a blueprint matching the supplied key, resolved but nothing mountable can be produced from it, on any server.",
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
  sessionId: string;
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
    sessionId: args.sessionId,
    appId: args.appId,
    codeUrl,
    codeHash,
    runtimeUrl: args.runtimeUrl,
    ...(args.themeId !== undefined ? { themeId: args.themeId } : {}),
    ...(args.themeMode !== undefined ? { themeMode: args.themeMode } : {}),
    ...(propsJson !== undefined ? { propsJson } : {}),
    ...(contextSlots !== undefined ? { contextSlots } : {}),
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


/**
 * Apply the full MCP Apps outbound wiring to a fresh `McpServer` - both
 * the capability advertisement and the `ui://ggui/render` resource. The
 * single entry-point `build-mcp.ts` calls so request-path wiring stays
 * one line.
 *
 * When `selfContained` is supplied, ALSO registers the per-render
 * `ui://ggui/render/{sessionId}` resource template that serves the
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
     * `ui://ggui/render/{sessionId}` becomes a readable resource
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
