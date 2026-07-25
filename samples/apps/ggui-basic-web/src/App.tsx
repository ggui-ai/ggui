import { useEffect, useState } from 'react';
import { ThemeProvider, getRawTheme } from '@ggui-ai/design/themes';
import { Chat } from './Chat';

/**
 * Public agent backend URL. Resolution order:
 *
 *   1. `?agent=<url>` URL query param. Lets one built bundle drive any
 *      agent backend at runtime — the parallel e2e harness uses this
 *      so all workers share a single Vite build but each navigates to
 *      its own worker-local agent URL.
 *   2. `VITE_AGENT_ENDPOINT_URL` env var (baked in at build time).
 *      Right for single-tenant deployments where the backend URL is
 *      known at build.
 *   3. The e2e harness default (claude-agent-sdk on 6790) so a developer
 *      running `pnpm dev` without `.env.local` still gets a working
 *      shell against a stock harness.
 *
 * Resolved synchronously at module load. The query param is read once
 * and never re-read — switching backends requires a new page load
 * (deliberate; the conversation state is keyed by `chatId`, which is
 * also URL-resident).
 */
function resolveAgentEndpoint(): string {
  if (typeof window !== 'undefined') {
    const fromUrl = new URL(window.location.href).searchParams.get('agent');
    if (fromUrl !== null && fromUrl.length > 0) return fromUrl;
  }
  return import.meta.env.VITE_AGENT_ENDPOINT_URL ?? 'http://localhost:6790';
}

const AGENT_ENDPOINT = resolveAgentEndpoint();

/**
 * Pair the chat shell with the SAME theme the iframe content uses
 * (canvas-demo's `ggui.json` sets `theme: indigo / dark`). `<ThemeProvider>`
 * expects the raw `DtcgTheme` token tree.
 */
const INDIGO_DARK = getRawTheme('indigo', 'dark');

export function App() {
  // Sandbox-proxy URL read once from the agent backend's `GET /`
  // manifest on mount. `<AppRenderer>` mandates a second-origin sandbox
  // host per MCP Apps spec; the sample backends auto-bind a
  // `sandbox.html` server on `agent_port + 1000` and surface the URL as
  // the manifest's `sandboxProxyUrl` field.
  //
  // We read instead of hardcoding so a backend running on a different
  // port (or a future backend without the bundled proxy) still drives
  // this frontend.
  const [sandboxUrl, setSandboxUrl] = useState<string | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);

  // The dev servers start in parallel and the agent backend can bind
  // noticeably later than the web server (a large SDK module graph — e.g.
  // @google/adk — takes seconds to load under tsx). A one-shot fetch here
  // turns that boot race into a PERMANENT error page that only a manual
  // reload clears. So: retry network-level failures (backend not up yet)
  // with a deadline, keeping the "Connecting…" state alive while it boots.
  // A response that arrives but is wrong (non-OK status, non-manifest body)
  // is terminal — the backend IS up, it just isn't an MCP-Apps agent.
  useEffect(() => {
    const RETRY_MS = 1_500;
    const DEADLINE_MS = 90_000;
    let cancelled = false;
    void (async () => {
      const deadline = Date.now() + DEADLINE_MS;
      for (;;) {
        let res: Response;
        try {
          res = await fetch(`${AGENT_ENDPOINT}/`, {
            headers: { Accept: 'application/json' },
          });
        } catch (err) {
          if (cancelled) return;
          if (Date.now() >= deadline) {
            setSandboxError(err instanceof Error ? err.message : String(err));
            return;
          }
          await new Promise((r) => setTimeout(r, RETRY_MS));
          if (cancelled) return;
          continue;
        }
        if (cancelled) return;
        if (!res.ok) {
          setSandboxError(`backend returned ${res.status}`);
          return;
        }
        let body: { readonly sandboxProxyUrl?: unknown };
        try {
          body = (await res.json()) as { readonly sandboxProxyUrl?: unknown };
        } catch {
          if (!cancelled) setSandboxError('backend manifest is not JSON');
          return;
        }
        if (cancelled) return;
        if (
          typeof body.sandboxProxyUrl !== 'string' ||
          body.sandboxProxyUrl.length === 0
        ) {
          setSandboxError('backend manifest missing sandboxProxyUrl');
          return;
        }
        setSandboxUrl(body.sandboxProxyUrl);
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ThemeProvider theme={INDIGO_DARK} mode="dark">
      {sandboxUrl !== null ? (
        <Chat agentEndpoint={AGENT_ENDPOINT} sandboxUrl={sandboxUrl} />
      ) : sandboxError !== null ? (
        <div style={{ padding: 24, color: '#c00', fontFamily: 'system-ui' }}>
          Failed to reach agent backend at <code>{AGENT_ENDPOINT}</code>:{' '}
          <strong>{sandboxError}</strong>
          <p style={{ marginTop: 12, fontSize: 13, color: '#666' }}>
            Confirm <code>VITE_AGENT_ENDPOINT_URL</code> points at a running
            MCP-Apps-spec backend (see <code>.env.example</code>).
          </p>
        </div>
      ) : (
        <div style={{ padding: 24, color: '#888', fontFamily: 'system-ui' }}>
          Connecting to agent at <code>{AGENT_ENDPOINT}</code>…
        </div>
      )}
    </ThemeProvider>
  );
}
