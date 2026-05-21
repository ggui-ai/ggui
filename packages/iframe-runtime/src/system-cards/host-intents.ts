/**
 * Host-intents — request actions from the embedding host (parent
 * window) that the sandboxed iframe cannot perform itself.
 *
 * The MCP Apps spec (SEP-1865) defines `ui/notifications/*` and
 * `ui/request/*` namespaces for iframe→host communication. This
 * module sends well-formed requests for the actions the no-
 * credentials card and other system cards need (open external URL,
 * etc.), and falls back gracefully when the host doesn't implement
 * the request.
 *
 * Design posture:
 *
 *   - **All-strategies-fire-in-parallel.** Most MCP hosts ignore
 *     methods they don't implement. Sending three speculative
 *     requests costs three postMessages — all of which are no-ops
 *     to a host that doesn't recognize them. Whichever the host
 *     honors first wins.
 *
 *   - **Always include a clipboard fallback.** Clipboard write is
 *     the only mechanism that works in every sandbox without any
 *     host cooperation. Strategies are layered: try popup, try
 *     anchor, try postMessage; clipboard is the floor.
 *
 *   - **Observable outcome.** Caller gets a discriminated result
 *     `{outcome, mechanism}` so the UI can show "opened" vs
 *     "copied" vs "user-select-only" with confident copy.
 */

/**
 * Request the host open a URL in the user's real browser tab.
 *
 * In claudemcpcontent.com (claude.ai's MCP Apps sandbox), the iframe
 * is sandboxed without `allow-popups` AND `connect-src 'self'` blocks
 * fetches to other origins, so neither `window.open(url)` nor
 * `<a target="_blank">` succeed. This helper:
 *
 *   1. Tries `window.open(url, '_blank', 'noopener,noreferrer')` —
 *      works on hosts without sandbox restrictions (console, web
 *      embed, desktop with permissive iframe, etc.).
 *   2. Programmatic anchor click — some hosts trap this differently
 *      from `window.open`; cheap to try.
 *   3. postMessage `ui/request/open-url` to parent — speculative but
 *      canonical. If/when MCP hosts implement an open-url request
 *      method (likely a v2 of the spec), this is the form they'll
 *      use.
 *   4. postMessage `tools/call` requesting an `open_url` tool — if
 *      the host exposes `open_url` as a registered tool, the iframe
 *      can request its invocation. Stretch path; cheap to attempt.
 *   5. `navigator.clipboard.writeText(url)` — guaranteed-to-work
 *      fallback. Even if every other mechanism is blocked, the
 *      clipboard write executes synchronously in the user-gesture
 *      context and is permitted in every sandbox we've tested.
 *
 * The return value reflects what we *think* happened — strategy 1
 * is observable (returns null when blocked); strategies 2–4 we
 * fire and forget (no host has documented a reply contract). The
 * clipboard outcome is the most reliable signal because it
 * resolves a Promise we can `await`.
 *
 * @public
 */
export async function requestOpenUrl(
  url: string,
): Promise<RequestOpenUrlResult> {
  if (typeof window === 'undefined') {
    return { outcome: 'unsupported', mechanism: null };
  }

  // 1. window.open — observable. `null` return == popup-blocked /
  //    sandbox-blocked. A non-null window object means the browser
  //    initiated a tab/window (we can't actually verify the user
  //    sees it, but absence of null is a strong positive signal).
  let openedWindow: Window | null = null;
  try {
    openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    openedWindow = null;
  }

  // 2. Programmatic anchor click. Same iframe-sandbox limits apply,
  //    but some mobile WebViews (notably iOS Safari embedded as
  //    SFSafariViewController) trap anchor.click() differently from
  //    window.open. Cheap to try; no observable signal.
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } catch {
    // Anchor strategy failed — fall through.
  }

  // 3. postMessage `ui/request/open-url`. Speculative — no MCP host
  //    has shipped this yet, but it's the canonical request shape
  //    a future host should implement. Sending it is harmless: a
  //    host that doesn't recognize the method ignores the message.
  //    We don't await a reply because there's no documented
  //    response contract; if a host ships one, future versions of
  //    this helper can listen for `ui/responses/open-url`.
  try {
    window.parent.postMessage(
      {
        jsonrpc: '2.0',
        method: 'ui/request/open-url',
        params: { url },
      },
      '*',
    );
  } catch {
    /* parent detached / sandboxed */
  }

  // 4. postMessage `tools/call` → `open_url`. Some hosts model
  //    "request the user's browser to open a URL" as a registered
  //    tool the iframe can invoke. Cheap probe; harmless when the
  //    tool isn't registered.
  try {
    window.parent.postMessage(
      {
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1e9),
        method: 'tools/call',
        params: { name: 'open_url', arguments: { url } },
      },
      '*',
    );
  } catch {
    /* parent detached / sandboxed */
  }

  // 5. Clipboard fallback — guaranteed to work in every host that
  //    grants `clipboard-write` (which the MCP Apps default
  //    permissions-policy includes). The user-gesture context the
  //    click came in on is exactly what `writeText` requires.
  //
  //    Timeout via Promise.race: in some sandbox environments
  //    (headless browsers without a real clipboard, MCP hosts that
  //    don't grant clipboard-write but never reject — they just
  //    hang the Promise), `writeText` returns a Promise that
  //    NEVER resolves or rejects. Without a timeout the whole
  //    helper hangs forever and the CTA gets stuck on "Opening…".
  //    1.5s is generous enough for a real clipboard write
  //    (microsecond-fast in normal browsers) yet short enough
  //    that the user doesn't perceive a hang.
  let clipboardCopied = false;
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    const CLIPBOARD_TIMEOUT_MS = 1500;
    try {
      await Promise.race([
        navigator.clipboard.writeText(url).then(
          () => {
            clipboardCopied = true;
          },
          () => {
            clipboardCopied = false;
          },
        ),
        new Promise<void>((resolve) =>
          setTimeout(resolve, CLIPBOARD_TIMEOUT_MS),
        ),
      ]);
    } catch {
      clipboardCopied = false;
    }
  }

  // Decide the outcome. Priority:
  //   - If window.open returned a non-null window, claim 'opened'
  //     (highest-confidence observable signal).
  //   - Else if clipboard succeeded, 'copied' (the fallback worked).
  //   - Else 'unsupported' (user must long-press / triple-click the
  //     URL block manually).
  if (openedWindow !== null) {
    return { outcome: 'opened', mechanism: 'window.open' };
  }
  if (clipboardCopied) {
    return { outcome: 'copied', mechanism: 'clipboard' };
  }
  return { outcome: 'unsupported', mechanism: null };
}

/**
 * Outcome of {@link requestOpenUrl}.
 *
 *   - `opened` — `window.open` returned a non-null window. Best-
 *     effort signal that a tab/popup was created. UI should say
 *     "Opened in browser ✓" or similar.
 *   - `copied` — popup was blocked, but clipboard write succeeded.
 *     UI should say "URL copied — paste in your browser address bar"
 *     and keep the URL block visible for confirmation.
 *   - `unsupported` — every mechanism failed. UI must surface the
 *     URL prominently with `user-select: all` so the user can
 *     long-press / triple-click + copy manually.
 */
export type RequestOpenUrlResult =
  | { readonly outcome: 'opened'; readonly mechanism: 'window.open' }
  | { readonly outcome: 'copied'; readonly mechanism: 'clipboard' }
  | { readonly outcome: 'unsupported'; readonly mechanism: null };
