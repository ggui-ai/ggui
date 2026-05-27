/**
 * Blueprint viewer route — `/preview/<blueprintId>`.
 *
 * One-shot mount surface for a manifest-registered blueprint. The SPA
 * fetches the blueprint's compiled bundle from
 * `GET /ggui/console/blueprint/:id`, then hands the code to
 * `RenderRenderer` — the same primitive shells use to mount a single
 * `ComponentRender`. No WebSocket, no session cookie; a blueprint is
 * an authored UI rendering in isolation.
 *
 * Route scope:
 *
 *   - READ-ONLY mount. No live-channel subscription, no actionSpec
 *     dispatch, no session stack mutation. A blueprint is the static
 *     artifact; the operator or agent wraps it in richer context
 *     elsewhere (the dev chat, a pushed session) when interactivity
 *     is needed.
 *   - Error shapes mirror the SessionViewer's: 404 (id unknown),
 *     4xx/5xx (server error), network fail (raw message).
 *
 * Visual shell follows the brand kit (same as `SessionViewer`): one
 * section head, a pane-style header for blueprint identity + content
 * type, and the mount card stamping `data-ggui-stack-entry="component"`
 * + `data-ggui-code-ready="true"` + `data-ggui-blueprint-id` — a
 * stable anchor contract browser specs target across console surfaces.
 */
import {
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { RenderRenderer } from '@ggui-ai/react';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';
import { navigateTo } from '../router.js';

/**
 * Response shape of `GET /ggui/console/blueprint/:id`. Must match
 * `packages/mcp-server/src/server.ts`'s blueprint endpoint. Shape
 * mirrors `GguiRenderBlueprintOutput` in `@ggui-ai/protocol`.
 */
interface BlueprintResponse {
  readonly blueprintId: string;
  readonly blueprintName: string;
  readonly code: string;
  readonly contentType: string;
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly blueprint: BlueprintResponse }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'error'; readonly message: string };

export function BlueprintViewer({
  blueprintId,
}: {
  readonly blueprintId: string;
}): ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/ggui/console/blueprint/${encodeURIComponent(blueprintId)}`,
          {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          },
        );
        if (res.status === 404) {
          setState({ kind: 'not-found' });
          return;
        }
        if (!res.ok) {
          setState({
            kind: 'error',
            message: `server returned ${res.status}`,
          });
          return;
        }
        const body = (await res.json()) as BlueprintResponse;
        setState({ kind: 'ready', blueprint: body });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: String(err) });
      }
    })();
    return () => controller.abort();
  }, [blueprintId]);

  return (
    <section className="ggui-section">
        <SectionHead
          num="01 / blueprint"
          title="Manifest-registered surface."
          mute={
            <>
              <code className="ggui-code">/preview/{blueprintId}</code>
            </>
          }
          intro={
            <>
              Reads the bundle via{' '}
              <code className="ggui-code">LocalUiRegistry</code>. Same
              bytes an agent would get from{' '}
              <code className="ggui-code">ggui_render_blueprint</code>.
            </>
          }
        />

        {state.kind === 'loading' ? (
          <StatusCard title="loading" num="BPR / 01" tone="draft">
            Loading blueprint…
          </StatusCard>
        ) : state.kind === 'not-found' ? (
          <NotFoundCard blueprintId={blueprintId} />
        ) : state.kind === 'error' ? (
          <StatusCard title="error" num="ERR / 01" tone="signal">
            Couldn&apos;t load blueprint — {state.message}.
          </StatusCard>
        ) : (
          <BlueprintMount blueprint={state.blueprint} />
        )}
      </section>
  );
}

/**
 * Mount card — wraps `RenderRenderer` in the canonical
 * `data-ggui-stack-entry="component"` shell. Reusing this data-attr
 * contract across console surfaces lets browser specs target one
 * selector against both in-process and blueprint mounts.
 *
 * `data-ggui-blueprint-id` additionally stamps the resolved id on the
 * slot so specs can match the mounted blueprint without parsing the
 * URL — load-bearing for multi-blueprint tests that may land later.
 *
 * The `<TryLiveAction>` CTA POSTs to
 * `/ggui/console/blueprint/:id/try` and navigates to the returned
 * `/s/<shortCode>` URL. Hidden on blueprints with no actionSpec /
 * streamSpec (nothing to exercise live) is NOT enforced here because
 * the blueprint response is metadata-only; the button always appears
 * and the try-live endpoint's 503 response surfaces any wiring gap.
 */
function BlueprintMount({
  blueprint,
}: {
  readonly blueprint: BlueprintResponse;
}): ReactElement {
  return (
    <section
      data-ggui-stack-entry="component"
      data-ggui-code-ready="true"
      data-ggui-blueprint-id={blueprint.blueprintId}
      className="ggui-pane"
    >
      <div className="ggui-pane__head">
        <div className="ggui-pane__traffic" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="ggui-pane__title">{blueprint.blueprintName}</span>
        <span className="ggui-pane__meta">{blueprint.contentType}</span>
        <TryLiveAction blueprintId={blueprint.blueprintId} />
      </div>
      <div className="ggui-pane__body">
        <RenderRenderer
          render={{
            id: blueprint.blueprintId,
            componentCode: blueprint.code,
          }}
          fallback={
            <div
              data-ggui-preview-state="waiting"
              className="ggui-muted"
              style={{ padding: '16px 0' }}
            >
              Loading component…
            </div>
          }
        />
      </div>
    </section>
  );
}

type TryLiveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * POSTs to `/ggui/console/blueprint/:id/try` and navigates to
 * `/s/<shortCode>` on success. Errors surface inline — a broken
 * try-live is an operator-facing signal (unwired server, bundle
 * failure) and the current blueprint mount stays intact.
 *
 * `data-ggui-try-live="pending"` on the button while the request is
 * in flight so browser specs can wait on the transition without
 * relying on text content.
 */
function TryLiveAction({
  blueprintId,
}: {
  readonly blueprintId: string;
}): ReactElement {
  const [state, setState] = useState<TryLiveState>({ kind: 'idle' });

  const onClick = async (): Promise<void> => {
    setState({ kind: 'pending' });
    try {
      const res = await fetch(
        `/ggui/console/blueprint/${encodeURIComponent(blueprintId)}/try`,
        {
          method: 'POST',
          headers: { accept: 'application/json' },
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          readonly message?: string;
        };
        setState({
          kind: 'error',
          message: body.message ?? `server returned ${res.status}`,
        });
        return;
      }
      const body = (await res.json()) as {
        readonly sessionId: string;
        readonly shortCode: string | null;
        readonly url: string | null;
        readonly warning?: string;
      };
      if (!body.url) {
        setState({
          kind: 'error',
          message: body.warning ?? 'try-live returned no viewer URL',
        });
        return;
      }
      navigateTo(body.url);
    } catch (err) {
      setState({ kind: 'error', message: String(err) });
    }
  };

  return (
    <span className="ggui-pane__actions" style={{ marginLeft: 'auto' }}>
      {state.kind === 'error' ? (
        <span
          className="ggui-muted"
          data-ggui-try-live="error"
          title={state.message}
          style={{ marginRight: '8px', fontSize: '0.75rem' }}
        >
          try-live failed
        </span>
      ) : null}
      <button
        type="button"
        className="ggui-btn ggui-btn--ghost"
        data-ggui-try-live={state.kind === 'pending' ? 'pending' : 'idle'}
        data-ggui-blueprint-id={blueprintId}
        disabled={state.kind === 'pending'}
        onClick={() => {
          void onClick();
        }}
      >
        {state.kind === 'pending' ? 'opening…' : 'Try live →'}
      </button>
    </span>
  );
}

function NotFoundCard({
  blueprintId,
}: {
  readonly blueprintId: string;
}): ReactElement {
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">not found</span>
        <span className="ggui-card__num">ERR / 01</span>
      </div>
      <div className="ggui-card__body">
        <h2 className="ggui-h2">Blueprint not found</h2>
        <p className="ggui-body">
          No blueprint registered with id{' '}
          <code className="ggui-code">{blueprintId}</code>. Check{' '}
          <code className="ggui-code">ggui.json#blueprints.include</code>{' '}
          and the blueprint&apos;s{' '}
          <code className="ggui-code">ggui.ui.json#id</code>.
        </p>
        <div>
          <button
            type="button"
            className="ggui-btn ggui-btn--ghost"
            onClick={() => navigateTo('/')}
          >
            back to landing
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusCard({
  title,
  num,
  tone,
  children,
}: {
  readonly title: string;
  readonly num: string;
  readonly tone: 'draft' | 'signal' | 'ink';
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">{title}</span>
        <span className="ggui-card__num">{num}</span>
      </div>
      <div className="ggui-card__body">
        <p className="ggui-body">
          <StatusBadge tone={tone}>{title}</StatusBadge>
        </p>
        <p className="ggui-muted">{children}</p>
      </div>
    </div>
  );
}
