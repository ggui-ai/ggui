/**
 * Hub preview client — the React app that mounts inside the hub's
 * preview iframe and renders a local UI via
 * `<DynamicComponent code={...} />` from `@ggui-ai/react`.
 *
 * Why a bundled React app (not the vanilla hub JS):
 *
 *   - The existing renderer (DynamicComponent → rewriteImports →
 *     loadModule) is a React component. Putting it in the vanilla
 *     hub shell would require hoisting React / ReactDOM / the whole
 *     design system into the observability dashboard. Instead, the
 *     hub embeds an `<iframe src="/hub/preview?ui=<id>">` and this
 *     file is the code the iframe runs.
 *   - Reusing `DynamicComponent` keeps the preview behavior identical
 *     to Studio's local-preview flow. No second renderer, no drift.
 *   - The bundle is built once by `scripts/build-hub-preview.mjs` and
 *     served as `/hub/preview.js`. Everything external to the ggui
 *     stack (React, the design system) is bundled in; the user's
 *     compiled UI (served by `/uis/:id/bundle`) provides its own
 *     `react` / `@ggui-ai/design` import specifiers which
 *     `DynamicComponent` rewrites to data-URL shims pointing at the
 *     React + design modules this bundle already holds.
 *
 * Failure model — mirrors Studio's BlueprintPreview:
 *
 *   - `loading`   → bundle fetch in flight.
 *   - `ready`     → bundle returned, hand it to `<DynamicComponent>`.
 *   - `missing`   → 404 with `error: 'missing-entry'` — the UI is
 *                   registered but has no TSX to compile. Shows the
 *                   `tried` paths the server searched.
 *   - `not-found` → 404 plain — the id isn't in the registry at all.
 *   - `compile`   → 422 with `errors[]` — esbuild rejected the TSX.
 *                   Shows the first error with file:line:col + the
 *                   `+N more` suffix.
 *   - `http`      → any other non-2xx (401 from a stale token, 5xx,
 *                   etc.). The iframe is loaded without the token on
 *                   its URL — the server embeds the bearer into the
 *                   shell's `window.__GGUI_DEV_PREVIEW__` bootstrap,
 *                   and this client reads it for its own data XHRs.
 *   - `unreachable` → fetch itself threw. Likely "ggui dev was killed."
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DynamicComponent } from '@ggui-ai/react';

/**
 * Registry event payload emitted by the dev-stack SSE endpoint.
 * Shape mirrors `@ggui-ai/ui-registry`'s `UiRegistryEvent`; re-
 * typed narrowly here to avoid pulling the registry package into
 * the browser bundle.
 */
interface UiRegistryEventLite {
  readonly type: 'added' | 'changed' | 'removed';
  readonly id: string;
  readonly contentHash?: string;
}

declare global {
  interface Window {
    __GGUI_DEV_PREVIEW__?: {
      token: string | null;
      selectedId: string;
    };
  }
}

interface BundleLocation {
  file?: string;
  line?: number;
  column?: number;
  lineText?: string;
}

interface BundleMessage {
  text: string;
  location?: BundleLocation | null;
}

interface CompileFailureBody {
  error: 'compile-failed';
  id: string;
  entry: string;
  errors: BundleMessage[];
  warnings: BundleMessage[];
}

interface MissingEntryBody {
  error: 'missing-entry';
  id: string;
  message?: string;
  tried: string[];
}

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; code: string }
  | { kind: 'missing'; tried: readonly string[] }
  | { kind: 'not-found' }
  | { kind: 'compile'; detail: CompileFailureBody }
  | { kind: 'http'; status: number; message: string }
  | { kind: 'unreachable'; message: string };

function bootstrap(): { token: string | null; selectedId: string } {
  const boot = window.__GGUI_DEV_PREVIEW__;
  return {
    token: boot?.token ?? null,
    selectedId: boot?.selectedId ?? '',
  };
}

async function fetchBundle(
  id: string,
  token: string | null,
  signal: AbortSignal,
): Promise<PreviewState> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`/uis/${encodeURIComponent(id)}/bundle`, {
      headers,
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (signal.aborted) return { kind: 'loading' };
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'unreachable', message };
  }

  if (response.ok) {
    const code = await response.text();
    return { kind: 'ready', code };
  }

  if (response.status === 404) {
    try {
      const body = (await response.json()) as MissingEntryBody | { error: string };
      if (body && 'error' in body && body.error === 'missing-entry') {
        return {
          kind: 'missing',
          tried: Array.isArray((body as MissingEntryBody).tried)
            ? (body as MissingEntryBody).tried
            : [],
        };
      }
    } catch {
      /* fall through */
    }
    return { kind: 'not-found' };
  }

  if (response.status === 422) {
    try {
      const body = (await response.json()) as CompileFailureBody;
      if (body && body.error === 'compile-failed' && Array.isArray(body.errors)) {
        return { kind: 'compile', detail: body };
      }
    } catch {
      /* fall through */
    }
    return {
      kind: 'http',
      status: 422,
      message: 'Local compile failed but the server sent an unreadable error body.',
    };
  }

  return {
    kind: 'http',
    status: response.status,
    message: response.statusText || 'Request failed.',
  };
}

function PreviewApp({
  token,
  selectedId,
}: {
  token: string | null;
  selectedId: string;
}) {
  const [state, setState] = useState<PreviewState>(
    selectedId ? { kind: 'loading' } : { kind: 'idle' },
  );
  // Bumped by the SSE subscription on every event that matches
  // `selectedId`. Included in the fetch effect's dep list so the
  // bundle re-fetches + the `DynamicComponent` key changes →
  // remount with fresh code. Mirrors the HMR pattern Studio's
  // BlueprintPreview uses.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!selectedId) {
      setState({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ kind: 'loading' });
    fetchBundle(selectedId, token, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setState(next);
    });
    return () => controller.abort();
  }, [selectedId, token, version]);

  // SSE subscription — lives as long as the selected id doesn't
  // change. We don't rebuild it per-version bump; the version is a
  // re-fetch trigger, not a transport reset.
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    subscribeToRegistry(token, controller.signal, (event) => {
      if (event.id !== selectedId) return;
      // On any matching event (added / changed / removed), bump
      // the version so the fetch effect re-runs. `removed` will
      // surface as 404/missing on the next fetch — the preview
      // paints the honest "not found" state rather than keeping
      // the stale render.
      setVersion((v) => v + 1);
    });
    return () => controller.abort();
  }, [selectedId, token]);

  if (state.kind === 'idle') {
    return (
      <Pane>
        <Meta>No UI selected</Meta>
        <Status>Pick a UI from the Discovered UIs panel to preview it here.</Status>
      </Pane>
    );
  }

  if (state.kind === 'loading') {
    return (
      <Pane>
        <Meta>
          Preview of <code>{selectedId}</code>
        </Meta>
        <Status>Loading bundle…</Status>
      </Pane>
    );
  }

  if (state.kind === 'ready') {
    return (
      <div className="surface">
        <DynamicComponent code={state.code} />
      </div>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <Pane>
        <Meta>
          Preview of <code>{selectedId}</code>
        </Meta>
        <Status>
          The server doesn't know this id. It may have been removed from the registry.
        </Status>
      </Pane>
    );
  }

  if (state.kind === 'missing') {
    return (
      <Pane>
        <Meta>No renderable entry</Meta>
        <Status>
          Declare <code>entryPoint</code> in <code>ggui.ui.json</code>, or colocate
          a <code>ggui.ui.tsx</code> beside the manifest.
        </Status>
        {state.tried.length > 0 && (
          <pre className="tried">{state.tried.join('\n')}</pre>
        )}
      </Pane>
    );
  }

  if (state.kind === 'compile') {
    return (
      <Pane>
        <Meta>Local compile failed</Meta>
        <ul className="errors">
          {state.detail.errors.map((err, i) => {
            const loc = err.location;
            const locLine = loc
              ? `${loc.file ?? state.detail.entry}:${loc.line ?? '?'}:${loc.column ?? '?'}`
              : state.detail.entry;
            return (
              <li key={i}>
                <pre className="location">{locLine}</pre>
                <pre className="error">{err.text}</pre>
                {loc?.lineText && <pre className="line-text">{loc.lineText}</pre>}
              </li>
            );
          })}
        </ul>
      </Pane>
    );
  }

  if (state.kind === 'http') {
    return (
      <Pane>
        <Meta>Bundle fetch failed (HTTP {state.status})</Meta>
        <Status>{state.message}</Status>
      </Pane>
    );
  }

  return (
    <Pane>
      <Meta>Local ggui dev server is unreachable</Meta>
      <Status>
        Studio could not reach the server — is <code>ggui dev</code> still running?
        <br />
        <span className="dim">{state.message}</span>
      </Status>
    </Pane>
  );
}

function Pane({ children }: { children: React.ReactNode }) {
  return (
    <div className="frame">
      <div className="pane">{children}</div>
    </div>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return <div className="meta">{children}</div>;
}

function Status({ children }: { children: React.ReactNode }) {
  return <div className="status">{children}</div>;
}

/**
 * Open an SSE subscription to the dev server's `/events` stream.
 * Calls `onEvent` for every `event: ui` frame with a parseable
 * JSON body. Reconnects with exponential backoff on drop / failure
 * (capped at 5 s) so an intermittent server restart doesn't leave
 * the preview stuck on stale data.
 *
 * EventSource can't carry an `Authorization` header, so we use
 * `fetch` with a streaming body. This matches the transport Studio
 * uses for the same reason.
 */
async function subscribeToRegistry(
  token: string | null,
  signal: AbortSignal,
  onEvent: (event: UiRegistryEventLite) => void,
): Promise<void> {
  let backoff = 500;
  while (!signal.aborted) {
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/events', {
        headers,
        cache: 'no-store',
        signal,
      });
      if (!res.ok || !res.body) {
        // Any non-2xx (401/403/5xx) — wait + try again. We don't
        // surface the error into the React tree because the
        // bundle is already painted; a missed reconnect means
        // the user manually reloads.
        await wait(backoff, signal);
        backoff = Math.min(backoff * 2, 5000);
        continue;
      }
      backoff = 500;
      await readSseStream(res.body.getReader(), onEvent, signal);
      // Stream ended cleanly (server close / shutdown). Try again
      // on the next tick.
    } catch {
      if (signal.aborted) return;
      await wait(backoff, signal);
      backoff = Math.min(backoff * 2, 5000);
    }
  }
}

async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: UiRegistryEventLite) => void,
  signal: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const chunk = await reader.read();
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (frame.length === 0 || frame.startsWith(':')) continue;
      let evt = '';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) evt = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (evt !== 'ui' || data.length === 0) continue;
      try {
        const payload = JSON.parse(data) as UiRegistryEventLite;
        if (payload && typeof payload.id === 'string') onEvent(payload);
      } catch {
        // Skip malformed frames; the next one will probably parse.
      }
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

function mount(): void {
  const root = document.getElementById('preview-root');
  if (!root) throw new Error('preview-root element not found in shell');
  const { token, selectedId } = bootstrap();
  createRoot(root).render(
    <StrictMode>
      <PreviewApp token={token} selectedId={selectedId} />
    </StrictMode>,
  );
}

mount();
