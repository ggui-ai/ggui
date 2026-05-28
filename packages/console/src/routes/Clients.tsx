/**
 * Clients route — `/admin/clients` (a.k.a. "Connected Apps").
 *
 * Operator-facing list of OAuth clients that have registered against
 * this server (via Dynamic Client Registration on `/oauth/register`,
 * typically driven by an MCP custom-connector host like claude.ai).
 * Supports listing and revoking clients.
 *
 * Reads `GET /ggui/console/oauth-clients` on mount, paints one row per
 * client. Revoke action POSTs `DELETE /ggui/console/oauth-clients/:id`.
 *
 * **Revoke caveat surfaced in the UI** (matches the storage-layer
 * JSDoc): revoke deletes the client REGISTRATION but does NOT
 * invalidate already-issued bearers. This is documented inline so
 * operators don't expect "kill claude.ai immediately" semantics.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-clients-list` on the column container.
 *   - `data-ggui-client-id={clientId}` on every row.
 *   - `data-ggui-client-revoke` on the revoke button.
 */
import {
  useEffect,
  useState,
  type ReactElement,
} from 'react';
import { SectionHead } from '../brand/SectionHead.js';

interface OAuthClientSummary {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly redirectUris: readonly string[];
  readonly createdAt: number;
}

interface OAuthClientsResponse {
  readonly clients: readonly OAuthClientSummary[];
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: OAuthClientsResponse }
  | { readonly kind: 'error'; readonly message: string };

export function Clients(): ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  // `revokingId` identifies the row currently mid-DELETE so we can
  // dim it + disable its button until the request resolves. Single-
  // operation at a time keeps the UI honest about server load on a
  // single-replica server.
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // `pendingConfirm` holds the clientId of a row the operator has
  // started to revoke but not yet confirmed. Two-click flow — first
  // click swaps the button to "confirm?", second click commits. No
  // modal because the action is reversible (just re-pair) and the
  // confirm-text-on-button pattern is enough friction.
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/ggui/console/oauth-clients', {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        // 404 means the route isn't mounted — server was started
        // without `oauth: true`. Surface a specific message so the
        // operator knows what to fix (re-run with `--oauth`).
        if (res.status === 404) {
          setState({
            kind: 'error',
            message:
              'OAuth not enabled on this server — re-run `ggui serve --oauth` to mount the management routes.',
          });
          return;
        }
        setState({
          kind: 'error',
          message: `server returned ${res.status}`,
        });
        return;
      }
      const body = (await res.json()) as OAuthClientsResponse;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({ kind: 'error', message: String(err) });
    }
  };

  useEffect(() => {
    // Single fetch on mount — operators reload the page when they
    // want the latest state. Same posture as Renders / Blueprints.
    // `refresh` reads the closure's `setState` only; safe to omit
    // from deps without `react-hooks/exhaustive-deps` complaining
    // (the rule isn't loaded in this package's eslint config).
    void refresh();
  }, []);

  const revoke = async (clientId: string): Promise<void> => {
    setRevokingId(clientId);
    try {
      const res = await fetch(
        `/ggui/console/oauth-clients/${encodeURIComponent(clientId)}`,
        { method: 'DELETE' },
      );
      // Server returns 204 on success or unknown id (idempotent).
      // Anything else is a real failure.
      if (res.status !== 204) {
        setState({
          kind: 'error',
          message: `revoke failed — server returned ${res.status}`,
        });
        return;
      }
      // Optimistic prune locally; refresh anyway in case other
      // clients changed concurrently (unlikely on single-operator
      // dev box, but cheap insurance).
      setPendingConfirm(null);
      await refresh();
    } catch (err) {
      setState({ kind: 'error', message: `revoke failed — ${String(err)}` });
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / clients"
        title="Connected apps."
        mute="OAuth clients that have registered against this server."
        intro={
          <>
            Each row is an OAuth client (typically an MCP custom-connector
            host like claude.ai) that completed{' '}
            <code className="ggui-code">/oauth/register</code> against
            this server. Revoke removes the registration so future
            re-discovery fails — Phase 1 caveat:{' '}
            <strong>existing bearers keep working</strong> until they
            expire or you re-pair.
          </>
        }
      />

      {state.kind === 'loading' ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          Loading clients…
        </p>
      ) : state.kind === 'error' ? (
        <p
          className="ggui-muted"
          style={{ margin: 0, padding: 12 }}
          data-ggui-clients-error
        >
          Couldn&apos;t load clients — {state.message}
        </p>
      ) : (
        <ClientList
          clients={state.data.clients}
          revokingId={revokingId}
          pendingConfirm={pendingConfirm}
          onRevokeRequest={(id) => setPendingConfirm(id)}
          onRevokeCancel={() => setPendingConfirm(null)}
          onRevokeConfirm={(id) => {
            void revoke(id);
          }}
          onRefresh={() => {
            void refresh();
          }}
        />
      )}
    </section>
  );
}

function ClientList({
  clients,
  revokingId,
  pendingConfirm,
  onRevokeRequest,
  onRevokeCancel,
  onRevokeConfirm,
  onRefresh,
}: {
  readonly clients: readonly OAuthClientSummary[];
  readonly revokingId: string | null;
  readonly pendingConfirm: string | null;
  readonly onRevokeRequest: (clientId: string) => void;
  readonly onRevokeCancel: () => void;
  readonly onRevokeConfirm: (clientId: string) => void;
  readonly onRefresh: () => void;
}): ReactElement {
  if (clients.length === 0) {
    return (
      <div className="ggui-stack" data-ggui-clients-list aria-label="connected apps (empty)">
        <div className="ggui-stack__head">
          <span className="ggui-stack__num">CON</span>
          <span className="ggui-stack__label">connected apps</span>
          <span className="ggui-stack__count">0</span>
        </div>
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          No clients have registered yet. Add this server as a custom
          connector in claude.ai (or another MCP host) — its OAuth
          flow will register a client here.
        </p>
      </div>
    );
  }
  return (
    <div
      data-ggui-clients-list
      className="ggui-stack"
      aria-label="connected apps"
    >
      <div className="ggui-stack__head">
        <span className="ggui-stack__num">CON</span>
        <span className="ggui-stack__label">connected apps</span>
        <span className="ggui-stack__count">{clients.length}</span>
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          onClick={onRefresh}
          style={{ marginLeft: 'auto' }}
        >
          refresh
        </button>
      </div>
      <ul className="ggui-stack__list">
        {clients.map((client, index) => (
          <ClientRow
            key={client.clientId}
            client={client}
            index={index + 1}
            isRevoking={revokingId === client.clientId}
            isPendingConfirm={pendingConfirm === client.clientId}
            onRevokeRequest={onRevokeRequest}
            onRevokeCancel={onRevokeCancel}
            onRevokeConfirm={onRevokeConfirm}
          />
        ))}
      </ul>
    </div>
  );
}

function ClientRow({
  client,
  index,
  isRevoking,
  isPendingConfirm,
  onRevokeRequest,
  onRevokeCancel,
  onRevokeConfirm,
}: {
  readonly client: OAuthClientSummary;
  readonly index: number;
  readonly isRevoking: boolean;
  readonly isPendingConfirm: boolean;
  readonly onRevokeRequest: (clientId: string) => void;
  readonly onRevokeCancel: () => void;
  readonly onRevokeConfirm: (clientId: string) => void;
}): ReactElement {
  const shortId = client.clientId.slice(0, 12);
  const displayName = client.clientName ?? shortId;
  return (
    <li
      data-ggui-client-id={client.clientId}
      className="ggui-stack__entry"
      style={{ opacity: isRevoking ? 0.5 : 1 }}
    >
      <div className="ggui-stack__entry-head">
        <span className="ggui-stack__entry-num">
          {`CON / ${String(index).padStart(2, '0')}`}
        </span>
        <span className="ggui-stack__entry-title">{displayName}</span>
      </div>
      <div className="ggui-stack__entry-meta">
        <span>
          id <code className="ggui-code">{shortId}…</code>
        </span>
        <span style={{ marginLeft: 12 }}>
          registered{' '}
          <code className="ggui-code">{formatRelative(client.createdAt)}</code>
        </span>
      </div>
      {client.redirectUris.length > 0 ? (
        <div className="ggui-stack__entry-meta" style={{ marginTop: 4 }}>
          <span>
            redirect{' '}
            <code className="ggui-code">{client.redirectUris[0]}</code>
            {client.redirectUris.length > 1
              ? ` (+${client.redirectUris.length - 1} more)`
              : ''}
          </span>
        </div>
      ) : null}
      <div
        style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}
      >
        {isPendingConfirm ? (
          <>
            <button
              type="button"
              className="ggui-btn"
              data-ggui-client-revoke
              disabled={isRevoking}
              onClick={() => onRevokeConfirm(client.clientId)}
            >
              {isRevoking ? 'revoking…' : 'confirm revoke'}
            </button>
            <button
              type="button"
              className="ggui-btn ggui-btn--ghost"
              disabled={isRevoking}
              onClick={onRevokeCancel}
            >
              cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ggui-btn ggui-btn--ghost"
            data-ggui-client-revoke
            disabled={isRevoking}
            onClick={() => onRevokeRequest(client.clientId)}
          >
            revoke
          </button>
        )}
      </div>
    </li>
  );
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
