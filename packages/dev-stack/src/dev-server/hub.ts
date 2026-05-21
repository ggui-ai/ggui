/**
 * Local dev hub — the HTML surface served from the same
 * dev-stack HTTP host as the registry / runtime endpoints.
 *
 * Charter — what this surface is and is not:
 *
 *   IS:     runtime status, registry state, discovered UIs,
 *           compile/runtime errors, recent runtime events/logs,
 *           code-first local observability
 *
 *   IS NOT: Studio-lite, starter gallery, no-code authoring,
 *           billing/workspace UI, NL playground, deploy flow,
 *           tunnel flow
 *
 * Delivery choices:
 *
 *   - Single self-contained HTML document — no bundler, no
 *     framework, no build step. Matches the "code-first dev tool"
 *     charter and keeps `@ggui-ai/dev-stack`'s dep weight at zero
 *     for this feature.
 *   - `/hub` is **public** (bearer-exempt) so a browser that opens
 *     the page gets the shell without a pre-flight token dance. The
 *     existing origin allowlist in `auth.ts` still prevents
 *     cross-origin reads; the server injects the bearer token
 *     directly into the HTML so the hub's same-origin XHRs carry
 *     it automatically.
 *   - No parallel backend shape — every panel queries the existing
 *     `/health`, `/uis`, `/runtime/status`, `/runtime/events`
 *     endpoints. Live SSE wiring lands in a follow-up commit.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GguiJsonV1 } from '@ggui-ai/project-config';

/**
 * Context the hub shell needs to render. The `token` is the bearer
 * the hub's own JS should send on XHRs; `null` when the server was
 * started without a security policy (tests).
 */
export interface HubShellContext {
  /** Bearer token the hub JS uses for XHRs. `null` = server open. */
  readonly token: string | null;
  /** Loaded `ggui.json` — hub shows `app.name` / `app.slug`. */
  readonly manifest: GguiJsonV1;
}

/**
 * Build the self-contained HTML document for the hub. Pure function
 * so tests can exercise the rendered shape without binding a port.
 *
 * HTML escaping is applied to every string that bubbles up from
 * user-controlled data (manifest fields, token). The token itself
 * is hex in practice, but the escape is defensive — a future
 * pairing-protocol token might be arbitrary.
 */
export function renderHubHtml(ctx: HubShellContext): string {
  const appName = escapeHtml(ctx.manifest.app.name);
  const appSlug = escapeHtml(ctx.manifest.app.slug);
  const protocol = escapeHtml(ctx.manifest.protocol);
  const bootstrap = JSON.stringify({
    token: ctx.token,
    app: { name: ctx.manifest.app.name, slug: ctx.manifest.app.slug },
    protocol: ctx.manifest.protocol,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>ggui dev — ${appName}</title>
<style>${HUB_CSS}</style>
</head>
<body>
<main id="app">
  <header class="header">
    <h1>ggui dev — ${appName}</h1>
    <div class="subtitle">slug: ${appSlug} &middot; protocol: ${protocol} &middot; <span id="live" class="live">connecting…</span> &middot; <span id="tick" class="tick">loading…</span></div>
  </header>
  <div class="grid">
    <section class="panel" data-panel="runtime">
      <h2>Runtime</h2>
      <div id="runtime-body" class="panel-body"><div class="placeholder">Loading…</div></div>
    </section>
    <section class="panel" data-panel="registry">
      <h2>Registry</h2>
      <div id="registry-body" class="panel-body"><div class="placeholder">Loading…</div></div>
    </section>
    <section class="panel wide" data-panel="uis">
      <h2>Discovered UIs <span id="uis-count" class="count"></span></h2>
      <div id="uis-body" class="panel-body"><div class="placeholder">Loading…</div></div>
    </section>
    <section class="panel wide" data-panel="preview">
      <div class="panel-head">
        <h2>Preview <span id="preview-label" class="count"></span></h2>
        <button id="preview-clear" class="preview-clear" type="button" hidden>clear</button>
      </div>
      <div id="preview-body" class="panel-body preview-body">
        <div class="placeholder">Click a UI above to preview it here.</div>
      </div>
    </section>
    <section class="panel wide" data-panel="events">
      <h2>Runtime events <span id="events-count" class="count"></span></h2>
      <div id="events-body" class="panel-body events"><div class="placeholder">Loading…</div></div>
    </section>
    <section class="panel wide" data-panel="diagnostics">
      <h2>Diagnostics <span class="count">(click row to copy)</span></h2>
      <div id="diagnostics-body" class="panel-body"></div>
      <div class="hint">Keyboard: press <kbd>r</kbd> to refresh now.</div>
    </section>
  </div>
</main>
<script>window.__GGUI_DEV__ = ${bootstrap};</script>
<script>${HUB_JS}</script>
</body>
</html>
`;
}

/**
 * Write the hub shell to `res` with no-cache headers. Response is
 * always 200 — there's no per-request failure mode for the shell.
 */
export function serveHubShell(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: HubShellContext,
): void {
  const html = renderHubHtml(ctx);
  const body = Buffer.from(html, 'utf-8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.byteLength.toString(),
    // Dev hub should never be cached — state changes every
    // second and a stale shell masks real regressions.
    'cache-control': 'no-store',
    // Hub is a loopback UI; don't let it be embedded in a
    // hostile iframe even hypothetically.
    'x-frame-options': 'DENY',
  });
  res.end(body);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Hub CSS. Dark terminal-ish palette, monospace throughout,
 * clearly code-first. No icons, no gradients, no animations beyond
 * a single heartbeat pulse on the tick indicator.
 */
const HUB_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #0a0a0a; color: #e7e7e7;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
main { max-width: 1080px; margin: 0 auto; padding: 24px; }
h1 { font-size: 15px; margin: 0 0 4px; color: #fff; font-weight: 600; }
h2 { font-size: 11px; margin: 0 0 12px; color: #8a8a8a; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em; }
.subtitle { color: #8a8a8a; font-size: 12px; margin-bottom: 20px; }
.tick { color: #666; }
.tick.ok::before { content: "● "; color: #3db37a; }
.tick.stale::before { content: "● "; color: #c99; }
.tick.err::before { content: "● "; color: #e57373; }
.live { color: #666; }
.live.live::before { content: "● "; color: #3db37a; animation: pulse 2s ease-in-out infinite; }
.live.reconnecting::before { content: "● "; color: #e0b870; animation: pulse 1s ease-in-out infinite; }
.live.offline::before { content: "● "; color: #666; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.panel { border: 1px solid #1f1f1f; background: #0f0f0f; padding: 16px 18px; border-radius: 6px; }
.panel.wide { grid-column: 1 / -1; }
.panel-body { min-height: 48px; }
.placeholder { color: #555; font-style: italic; }
.row { display: grid; grid-template-columns: 140px 1fr; gap: 12px; padding: 2px 0; }
.label { color: #8a8a8a; font-size: 12px; }
.value { color: #e7e7e7; word-break: break-all; }
.value.dim { color: #666; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 3px; font-size: 11px;
  font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.badge.absent { background: #1a1a1a; color: #666; border: 1px solid #262626; }
.badge.starting { background: #2a220d; color: #e0b870; border: 1px solid #3d3117; }
.badge.ready { background: #0f2a1a; color: #3db37a; border: 1px solid #1c4430; }
.badge.stopped { background: #1a1a1a; color: #888; border: 1px solid #262626; }
.badge.crashed { background: #2a0f0f; color: #e57373; border: 1px solid #441c1c; }
.badge.warn { background: #2a220d; color: #e0b870; border: 1px solid #3d3117; }
ul.uis { list-style: none; margin: 0; padding: 0; }
ul.uis li { padding: 0; border-top: 1px solid #181818; }
ul.uis li:first-child { border-top: none; }
ul.uis button.ui-row { display: flex; width: 100%; text-align: left;
  gap: 12px; align-items: baseline; padding: 6px 4px; background: none;
  border: 0; cursor: pointer; color: inherit; font: inherit;
  border-radius: 3px; }
ul.uis button.ui-row:hover { background: #141414; }
ul.uis button.ui-row:focus-visible { outline: 2px solid #7cb2e8; outline-offset: -2px; }
ul.uis button.ui-row[aria-pressed="true"] { background: #0f2a1a; }
ul.uis .ui-id { color: #7cb2e8; font-family: inherit; }
ul.uis .ui-name { color: #8a8a8a; font-size: 12px; }
ul.uis .ui-hint { color: #555; font-size: 11px; margin-left: auto; }
.panel-head { display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; margin: 0 0 12px; }
.panel-head h2 { margin: 0; }
button.preview-clear { background: none; border: 1px solid #262626;
  color: #8a8a8a; font: inherit; font-size: 11px; padding: 2px 8px;
  border-radius: 3px; cursor: pointer; }
button.preview-clear:hover { color: #e7e7e7; border-color: #3a3a3a; }
.preview-body { padding: 0; }
.preview-empty { padding: 32px; color: #666; text-align: center; font-style: italic; }
.preview-frame { width: 100%; min-height: 320px; border: 0; background: #0a0a0a;
  display: block; }
.count { color: #555; font-weight: 400; }
.events { max-height: 320px; overflow-y: auto; font-size: 12px; }
.events .ev { display: grid; grid-template-columns: 88px 80px 1fr; gap: 8px;
  padding: 2px 0; border-top: 1px solid #141414; }
.events .ev:first-child { border-top: none; }
.events .t { color: #555; }
.events .k-status { color: #3db37a; }
.events .k-log-stdout { color: #8a8a8a; }
.events .k-log-stderr { color: #d8a660; }
.events .k-error { color: #e57373; }
.events .msg { color: #ccc; white-space: pre-wrap; word-break: break-word; }
.diag-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border-radius: 4px; cursor: pointer; color: #b8b8b8; }
.diag-row:hover { background: #161616; color: #e7e7e7; }
.diag-row.copied { background: #0f2a1a; color: #3db37a; }
.diag-label { width: 120px; color: #888; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.06em; flex-shrink: 0; }
.diag-cmd { flex: 1; font-size: 12px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.hint { color: #555; font-size: 11px; margin-top: 12px; padding-top: 12px;
  border-top: 1px solid #181818; }
.hint kbd { background: #1a1a1a; border: 1px solid #262626; border-radius: 3px;
  padding: 1px 6px; font-family: inherit; font-size: 11px; color: #ccc; }
@media (max-width: 640px) {
  .grid { grid-template-columns: 1fr; }
  .diag-row { flex-direction: column; align-items: flex-start; }
  .diag-label { width: auto; }
}
`;

/**
 * Hub dashboard JS. Vanilla DOM, no framework.
 *
 *   - Polls `/health`, `/uis`, `/runtime/status`, `/runtime/events`
 *     every 2 seconds as the baseline data loop.
 *   - Subscribes to `/events` via fetch-stream (EventSource can't
 *     send `Authorization`). On every `event: ui` frame, refreshes
 *     the registry-panel fetches immediately — so the `Discovered
 *     UIs` list + registry counts flip on save before the next
 *     poll tick fires. Same HMR mechanism Studio uses.
 *   - Live indicator (`#live`) paints connecting / live /
 *     reconnecting / offline; independent from the data-freshness
 *     tick.
 *   - Reconnects SSE with a small backoff; existing poll keeps
 *     data alive during the reconnect window.
 *
 * Runtime events stay on the poll loop for now — `/runtime/events`
 * is a snapshot endpoint (SSE streaming is future hub scope).
 */
const HUB_JS = `
(function () {
  'use strict';
  var bootstrap = (window.__GGUI_DEV__ || {});
  var token = bootstrap.token;
  var headers = token ? { Authorization: 'Bearer ' + token } : {};
  var POLL_MS = 2000;
  var MAX_EVENTS = 80;

  var el = {
    tick: document.getElementById('tick'),
    live: document.getElementById('live'),
    runtime: document.getElementById('runtime-body'),
    registry: document.getElementById('registry-body'),
    uis: document.getElementById('uis-body'),
    uisCount: document.getElementById('uis-count'),
    events: document.getElementById('events-body'),
    eventsCount: document.getElementById('events-count'),
    diagnostics: document.getElementById('diagnostics-body'),
    preview: document.getElementById('preview-body'),
    previewLabel: document.getElementById('preview-label'),
    previewClear: document.getElementById('preview-clear'),
  };

  /** Selected UI id, read from the URL on boot and kept in sync with
   * history.replaceState. Kept as a module-level variable so
   * renderUis + renderPreview stay coordinated. */
  var selectedUi = readSelectedFromUrl();
  // Remember the discovered list so selection changes don't have to
  // re-fetch /uis before re-painting the row highlighting.
  var lastUis = [];

  function fmtTime(ts) {
    if (ts === null || ts === undefined) return '—';
    var d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false });
  }

  function fmtAge(ts) {
    if (ts === null || ts === undefined) return '—';
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 1) return 'now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  function text(s) { return (s === null || s === undefined) ? '' : String(s); }

  function escape(s) {
    return text(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function row(label, value, cls) {
    return '<div class="row"><div class="label">' + escape(label) + '</div>' +
      '<div class="value' + (cls ? ' ' + cls : '') + '">' + value + '</div></div>';
  }

  function badge(status) {
    return '<span class="badge ' + escape(status) + '">' + escape(status) + '</span>';
  }

  function fetchJson(path) {
    return fetch(path, { headers: headers, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) {
          var err = new Error('HTTP ' + r.status + ' on ' + path);
          err.status = r.status;
          throw err;
        }
        return r.json();
      });
  }

  function renderRuntime(data) {
    if (!data || data.present === false) {
      el.runtime.innerHTML = '<div class="row"><div class="label">agent</div>' +
        '<div class="value">' + badge('absent') + '</div></div>' +
        '<div class="row"><div class="label">note</div>' +
        '<div class="value dim">Start with <code>ggui dev --agent &lt;entry&gt;</code> to supervise a local agent.</div></div>';
      return;
    }
    var capsParts = [];
    if (data.capabilities) {
      if (data.capabilities.observable) capsParts.push('observable');
      if (data.capabilities.restartable) capsParts.push('restartable');
    }
    el.runtime.innerHTML =
      row('status', badge(data.status || 'absent')) +
      row('adapter', escape(data.name || '—')) +
      row('run id', '<code>' + escape(data.runId || '—') + '</code>') +
      row('capabilities', escape(capsParts.join(', ') || '—'), 'dim') +
      row('started', escape(fmtTime(data.startedAt) + '  (' + fmtAge(data.startedAt) + ')'), 'dim') +
      row('last event', escape(fmtTime(data.lastEventAt) + '  (' + fmtAge(data.lastEventAt) + ')'), 'dim');
  }

  function renderRegistry(data) {
    if (!data) {
      el.registry.innerHTML = '<div class="placeholder">—</div>';
      return;
    }
    var issueBadge = data.issueCount > 0 ? ' ' + badge('warn') : '';
    el.registry.innerHTML =
      row('project', escape((data.app && data.app.name) || '—')) +
      row('slug', escape((data.app && data.app.slug) || '—'), 'dim') +
      row('protocol', escape(data.protocol || '—'), 'dim') +
      row('UIs', escape(String(data.uiCount !== undefined ? data.uiCount : '—'))) +
      row('issues', escape(String(data.issueCount !== undefined ? data.issueCount : '—')) + issueBadge);
  }

  function renderUis(list) {
    lastUis = Array.isArray(list) ? list : [];
    if (lastUis.length === 0) {
      el.uis.innerHTML = '<div class="placeholder">No UIs discovered. Add <code>ggui.ui.json</code> files under <code>blueprints.include</code>.</div>';
      if (el.uisCount) el.uisCount.textContent = '(0)';
      // A removed selection should paint as a dangling state below.
      renderPreview();
      return;
    }
    if (el.uisCount) el.uisCount.textContent = '(' + lastUis.length + ')';
    var html = '<ul class="uis">';
    for (var i = 0; i < lastUis.length; i++) {
      var entry = lastUis[i];
      var id = (entry && entry.id) || '—';
      var name = (entry && entry.manifest && entry.manifest.name) || '';
      var pressed = id === selectedUi ? 'true' : 'false';
      html += '<li><button type="button" class="ui-row" data-ui-id="' + escape(id) +
        '" aria-pressed="' + pressed + '">' +
        '<span class="ui-id">' + escape(id) + '</span>';
      if (name) html += '<span class="ui-name">' + escape(name) + '</span>';
      html += '<span class="ui-hint">' + (pressed === 'true' ? 'previewing' : 'preview →') + '</span>';
      html += '</button></li>';
    }
    html += '</ul>';
    el.uis.innerHTML = html;
    var rows = el.uis.querySelectorAll('button.ui-row');
    rows.forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-ui-id') || '';
        setSelectedUi(id === selectedUi ? '' : id);
      });
    });
    renderPreview();
  }

  // Render the Preview panel based on the current selectedUi.
  // When nothing is selected we show a hint; otherwise we mount
  // an iframe at /hub/preview?ui=ID — the shell over there is
  // responsible for fetching + rendering the bundle. The iframe
  // is replaced (not reused) across selections so the bundle
  // inside gets a fresh boot every time.
  function renderPreview() {
    if (!el.preview) return;
    if (!selectedUi) {
      el.preview.innerHTML = '<div class="placeholder">Click a UI above to preview it here.</div>';
      if (el.previewLabel) el.previewLabel.textContent = '';
      if (el.previewClear) el.previewClear.hidden = true;
      return;
    }
    if (el.previewLabel) el.previewLabel.textContent = selectedUi;
    if (el.previewClear) el.previewClear.hidden = false;
    var src = '/hub/preview?ui=' + encodeURIComponent(selectedUi);
    // Replace the iframe wholesale rather than updating src —
    // otherwise a stale renderer (e.g. mid-fetch) could paint over
    // the fresh selection after we've moved on.
    el.preview.innerHTML = '';
    var frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.setAttribute('title', 'Preview of ' + selectedUi);
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('src', src);
    el.preview.appendChild(frame);
  }

  /** Persist selection in the URL + refresh affected panels. */
  function setSelectedUi(id) {
    if (id === selectedUi) return;
    selectedUi = id;
    writeSelectedToUrl(id);
    // Re-render the UIs list to flip the pressed-state + hints,
    // then bring the preview into (or out of) view.
    if (lastUis.length > 0) renderUis(lastUis);
    else renderPreview();
  }

  /** Narrow accepted characters so a malformed URL can't smuggle
   * weird values into the preview iframe src. The iframe page
   * applies the same filter server-side; this one is purely a
   * first-pass sanity check. */
  function isValidId(value) {
    if (typeof value !== 'string') return false;
    if (value.length === 0 || value.length > 200) return false;
    return /^[a-zA-Z0-9._\\-:@/]+$/.test(value);
  }

  function readSelectedFromUrl() {
    try {
      var url = new URL(window.location.href);
      var raw = (url.searchParams.get('ui') || '').trim();
      return isValidId(raw) ? raw : '';
    } catch (e) {
      return '';
    }
  }

  function writeSelectedToUrl(id) {
    try {
      var url = new URL(window.location.href);
      if (id) url.searchParams.set('ui', id);
      else url.searchParams.delete('ui');
      window.history.replaceState(null, '', url.toString());
    } catch (e) {
      // Swallow — persistence across reloads is a nice-to-have,
      // not load-bearing for the current-session selection.
    }
  }

  function renderEvents(data) {
    if (!data || data.present === false) {
      el.events.innerHTML = '<div class="placeholder">No runtime attached.</div>';
      if (el.eventsCount) el.eventsCount.textContent = '';
      return;
    }
    var events = Array.isArray(data.events) ? data.events : [];
    if (events.length === 0) {
      el.events.innerHTML = '<div class="placeholder">No events yet.</div>';
      if (el.eventsCount) el.eventsCount.textContent = '(0)';
      return;
    }
    if (el.eventsCount) el.eventsCount.textContent = '(' + events.length + ')';
    // Render newest-first — operators scan top-down.
    var html = '';
    for (var i = events.length - 1; i >= Math.max(0, events.length - MAX_EVENTS); i--) {
      var e = events[i];
      var kindClass = 'k-' + e.type + (e.type === 'log' ? ('-' + (e.stream || '')) : '');
      var kindLabel = e.type === 'log'
        ? ((e.stream || 'log'))
        : (e.type === 'status' ? ('status:' + (e.status || '')) : 'error');
      var body = e.type === 'log'
        ? (e.line || '')
        : e.type === 'status' ? (e.status || '')
        : (e.message || '');
      html += '<div class="ev">'
        + '<div class="t">' + escape(fmtTime(e.timestamp)) + '</div>'
        + '<div class="' + kindClass + '">' + escape(kindLabel) + '</div>'
        + '<div class="msg">' + escape(body) + '</div>'
        + '</div>';
    }
    el.events.innerHTML = html;
  }

  function setTick(state, message) {
    if (!el.tick) return;
    el.tick.className = 'tick ' + state;
    el.tick.textContent = message;
  }

  function setLive(state, message) {
    if (!el.live) return;
    el.live.className = 'live ' + state;
    el.live.textContent = message;
  }

  async function tick() {
    try {
      var results = await Promise.all([
        fetchJson('/health').catch(function (e) { return { __err: e }; }),
        fetchJson('/uis').catch(function (e) { return { __err: e }; }),
        fetchJson('/runtime/status').catch(function (e) { return { __err: e }; }),
        fetchJson('/runtime/events').catch(function (e) { return { __err: e }; }),
      ]);

      var anyErr = results.find(function (r) { return r && r.__err; });
      if (anyErr) {
        var err = anyErr.__err;
        if (err && err.status === 401) {
          setTick('err', 'auth failed — token may be stale');
        } else if (err && err.status === 403) {
          setTick('err', 'origin rejected');
        } else {
          setTick('err', 'offline — retry in ' + Math.round(POLL_MS / 1000) + 's');
        }
        return;
      }

      renderRegistry(results[0]);
      renderUis(results[1]);
      renderRuntime(results[2]);
      renderEvents(results[3]);
      setTick('ok', 'updated ' + fmtTime(Date.now()));
    } catch (e) {
      setTick('err', 'unexpected error — see console');
      // eslint-disable-next-line no-console
      console.error('[ggui-dev-hub]', e);
    }
  }

  /**
   * Refresh only the registry-side panels. Called after every
   * 'event: ui' SSE frame so UI edits feel instant — the
   * runtime poll is separate and keeps ticking at POLL_MS.
   */
  async function refreshRegistry() {
    try {
      var results = await Promise.all([
        fetchJson('/health').catch(function (e) { return { __err: e }; }),
        fetchJson('/uis').catch(function (e) { return { __err: e }; }),
      ]);
      if (results[0] && !results[0].__err) renderRegistry(results[0]);
      if (results[1] && !results[1].__err) renderUis(results[1]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[ggui-dev-hub] refreshRegistry', e);
    }
  }

  /**
   * Minimal SSE parser — same shape the dev server emits and the
   * Studio local source consumes. Normalises CRLF, splits on the
   * blank-line delimiter, ignores ':keep-alive' comment frames,
   * and only dispatches 'event: ui' with a valid JSON body.
   */
  async function readSse(reader, onUiEvent, onLive) {
    var decoder = new TextDecoder();
    var buffer = '';
    var sawFirstFrame = false;
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\\r\\n/g, '\\n');
      var sep;
      while ((sep = buffer.indexOf('\\n\\n')) !== -1) {
        var frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!sawFirstFrame) { sawFirstFrame = true; onLive(); }
        if (frame.length === 0 || frame.startsWith(':')) continue;
        var evt = '';
        var data = '';
        var lines = frame.split('\\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('event:') === 0) evt = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
        }
        if (evt !== 'ui' || !data) continue;
        try {
          var payload = JSON.parse(data);
          onUiEvent(payload);
        } catch (e) {
          // malformed frame — skip
        }
      }
    }
  }

  /**
   * Keep an SSE stream to '/events' open for the life of the hub.
   * Reconnects with a short backoff on drop / failure.
   */
  async function subscribeRegistry() {
    var backoff = 500;
    setLive('reconnecting', 'connecting');
    while (true) {
      try {
        var res = await fetch('/events', {
          headers: headers,
          cache: 'no-store',
        });
        if (!res.ok) {
          setLive('offline', res.status === 401 ? 'auth failed' : 'offline');
          await sleep(Math.min(backoff, 5000));
          backoff = Math.min(backoff * 2, 5000);
          continue;
        }
        backoff = 500;
        var reader = res.body.getReader();
        await readSse(
          reader,
          function (evt) {
            // Any UI registry event — added / changed / removed —
            // means registry-side panels need to refresh. Debouncing
            // is unnecessary: edits coalesce on chokidar's
            // awaitWriteFinish already.
            void refreshRegistry();
          },
          function () { setLive('live', 'live'); },
        );
        // Stream ended cleanly — reconnect.
        setLive('reconnecting', 'reconnecting');
      } catch (e) {
        setLive('reconnecting', 'reconnecting');
        await sleep(Math.min(backoff, 5000));
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * Render the Diagnostics panel — one row per endpoint with a
   * click-to-copy curl command. Done once on load (host/port/token
   * don't change for the life of the tab).
   */
  function renderDiagnostics() {
    if (!el.diagnostics) return;
    var origin = window.location.origin;
    var bearer = token ? (' -H "Authorization: Bearer ' + token + '"') : '';
    var endpoints = [
      ['health',         'GET ' + origin + '/health'],
      ['hub',            'GET ' + origin + '/hub'],
      ['preview',        'GET ' + origin + '/hub/preview?ui=<id>'],
      ['uis',            'curl -s' + bearer + ' ' + origin + '/uis'],
      ['bundle',         'curl -s' + bearer + ' ' + origin + '/uis/<id>/bundle'],
      ['events (sse)',   'curl -sN' + bearer + ' ' + origin + '/events'],
      ['runtime status', 'curl -s' + bearer + ' ' + origin + '/runtime/status'],
      ['runtime events', 'curl -s' + bearer + ' ' + origin + '/runtime/events'],
    ];
    if (token) {
      endpoints.push(['token', token]);
    }
    var html = '';
    for (var i = 0; i < endpoints.length; i++) {
      var label = endpoints[i][0];
      var cmd = endpoints[i][1];
      html += '<div class="diag-row" data-cmd="' + escape(cmd) + '">' +
        '<div class="diag-label">' + escape(label) + '</div>' +
        '<div class="diag-cmd">' + escape(cmd) + '</div>' +
        '</div>';
    }
    el.diagnostics.innerHTML = html;
    var rows = el.diagnostics.querySelectorAll('.diag-row');
    rows.forEach(function (row) {
      row.addEventListener('click', function () {
        var text = row.getAttribute('data-cmd') || '';
        copyToClipboard(text, row);
      });
    });
  }

  function copyToClipboard(text, row) {
    var done = function () {
      row.classList.add('copied');
      setTimeout(function () { row.classList.remove('copied'); }, 900);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallbackCopy(text); done();
      });
    } else {
      fallbackCopy(text); done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  /**
   * Keyboard refresh: press 'r' anywhere not inside an input
   * to force an immediate tick + registry refresh. Cheap but
   * meaningfully faster than waiting for the 2s poll.
   */
  function installKeyboardShortcuts() {
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'r' || e.key === 'R') {
        void tick();
        void refreshRegistry();
      }
    });
  }

  /** Attach the Clear button's handler once the elements exist. */
  function installPreviewControls() {
    if (!el.previewClear) return;
    el.previewClear.addEventListener('click', function () {
      setSelectedUi('');
    });
  }

  tick();
  setInterval(tick, POLL_MS);
  renderDiagnostics();
  installKeyboardShortcuts();
  installPreviewControls();
  // Paint an initial preview based on the URL param so a reload /
  // linked URL lands in the same state it came from. The real UI
  // list renders shortly after tick() resolves; until then the
  // preview is already showing the right frame.
  renderPreview();
  void subscribeRegistry();
})();
`;
