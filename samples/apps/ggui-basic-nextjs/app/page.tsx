'use client';
import { useEffect, useState } from 'react';
import { ThemeProvider, getRawTheme } from '@ggui-ai/design/themes';
import { Chat } from './Chat';

/**
 * Public agent backend URL. Wired at build/dev time via the
 * `NEXT_PUBLIC_AGENT_ENDPOINT_URL` env var. Falls back to the e2e
 * harness default (claude-agent-sdk on 6790) so a developer running
 * `pnpm dev` without `.env.local` configured still gets a working
 * shell against a stock harness.
 */
const AGENT_ENDPOINT =
  process.env.NEXT_PUBLIC_AGENT_ENDPOINT_URL ?? 'http://localhost:6790';

/**
 * Pair the chat shell with the SAME theme the iframe content uses
 * (canvas-demo's `ggui.json` sets `theme: indigo / dark`). `<ThemeProvider>`
 * expects the raw `DtcgTheme` token tree.
 */
const INDIGO_DARK = getRawTheme('indigo', 'dark');

export default function HomePage() {
  // Sandbox-proxy URL fetched once from the agent backend on mount.
  // `<AppRenderer>` mandates a second-origin sandbox host per MCP Apps
  // spec; the sample backends auto-bind a `sandbox.html` server on
  // `agent_port + 1000` and expose the URL via `GET /sandbox-proxy-url`.
  //
  // We fetch instead of hardcoding so a backend running on a different
  // port (or a future backend without the bundled proxy) still drives
  // this frontend.
  const [sandboxUrl, setSandboxUrl] = useState<string | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${AGENT_ENDPOINT}/sandbox-proxy-url`, {
          headers: { Accept: 'application/json' },
        });
        if (cancelled) return;
        if (!res.ok) {
          setSandboxError(`backend returned ${res.status}`);
          return;
        }
        const body = (await res.json()) as { readonly url?: unknown };
        if (typeof body.url !== 'string' || body.url.length === 0) {
          setSandboxError('backend response missing url');
          return;
        }
        setSandboxUrl(body.url);
      } catch (err) {
        if (!cancelled) {
          setSandboxError(err instanceof Error ? err.message : String(err));
        }
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
            Confirm <code>NEXT_PUBLIC_AGENT_ENDPOINT_URL</code> points at a
            running MCP-Apps-spec backend (see <code>.env.example</code>).
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
