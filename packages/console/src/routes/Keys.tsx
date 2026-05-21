/**
 * Keys route — `/admin/connector-keys` (admin-gated).
 *
 * Operator-facing list of paired bearer tokens minted by the server's
 * pairing service. Admin-token gated — `GET /ggui/console/keys` 401s
 * without an admin cookie or `Authorization: Bearer <admin-token>`,
 * and on a 401 we redirect the operator to
 * `/admin-login?next=/admin/connector-keys` so they can paste the
 * admin token printed on the boot banner.
 *
 * Plaintext-token exposure is INTENTIONAL (see PairingWithToken
 * JSDoc). Threat model is single-operator local-host: the persistence
 * file (`~/.ggui/keys.json` typically) already stores the same
 * plaintext, so rendering it in a same-origin admin page is a UX,
 * not a posture, change. Treat this page like `~/.ssh/`.
 *
 * Wire shape:
 *
 *   GET /ggui/console/keys
 *     → 200 { keys: [{pairingId, deviceName, createdAt, lastUsedAt?, token}] }
 *     → 401 { error: 'admin_auth_required' }
 *
 *   POST /ggui/console/keys { deviceName: string }
 *     → 200 { pairingId, token, serverName, deviceName }
 *
 *   DELETE /ggui/console/keys/:pairingId
 *     → 204 (idempotent — unknown id is not an error)
 *
 * Test contract (data-attrs):
 *   - `data-ggui-keys-list` on the column container.
 *   - `data-ggui-key-id={pairingId}` on every row.
 *   - `data-ggui-key-revoke` on the revoke button.
 *   - `data-ggui-key-mint` on the mint form's submit button.
 *   - `data-ggui-key-mint-result` on the one-time-reveal callout.
 */
import {
  useEffect,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { navigateTo } from '../router.js';

interface KeySummary {
  readonly pairingId: string;
  readonly deviceName: string;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  /** Plaintext bearer; `null` for hashed-store impls (console default
   * impl always returns the plaintext). */
  readonly token: string | null;
}

interface KeysResponse {
  readonly keys: readonly KeySummary[];
}

interface MintResult {
  readonly pairingId: string;
  readonly token: string;
  readonly deviceName: string;
  readonly serverName: string;
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: KeysResponse }
  | { readonly kind: 'error'; readonly message: string };

export function Keys(): ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  // `revokingId` identifies the row currently mid-DELETE so we can dim
  // it + disable its button until the request resolves. Same UX
  // contract as `Clients.tsx`.
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  // Mint flow — local input + result. Result is shown until the
  // operator dismisses it manually (the spec is explicit: do NOT
  // auto-hide the plaintext bearer).
  const [deviceName, setDeviceName] = useState('');
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mintResult, setMintResult] = useState<MintResult | null>(null);

  const refresh = async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/ggui/console/keys', {
        headers: { accept: 'application/json' },
      });
      if (res.status === 401) {
        // Bounce to admin-login with `?next=/keys` so the operator
        // lands back here after the cookie is set.
        navigateTo(`/admin-login?next=${encodeURIComponent('/admin/connector-keys')}`);
        return;
      }
      if (!res.ok) {
        if (res.status === 404) {
          setState({
            kind: 'error',
            message:
              'Pairing not enabled on this server — re-run `ggui serve` (pairing is on by default for the OSS bundle).',
          });
          return;
        }
        setState({
          kind: 'error',
          message: `server returned ${res.status}`,
        });
        return;
      }
      const body = (await res.json()) as KeysResponse;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({ kind: 'error', message: String(err) });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const revoke = async (pairingId: string): Promise<void> => {
    setRevokingId(pairingId);
    try {
      const res = await fetch(
        `/ggui/console/keys/${encodeURIComponent(pairingId)}`,
        { method: 'DELETE' },
      );
      if (res.status === 401) {
        navigateTo(`/admin-login?next=${encodeURIComponent('/admin/connector-keys')}`);
        return;
      }
      if (res.status !== 204) {
        setState({
          kind: 'error',
          message: `revoke failed — server returned ${res.status}`,
        });
        return;
      }
      setPendingConfirm(null);
      await refresh();
    } catch (err) {
      setState({ kind: 'error', message: `revoke failed — ${String(err)}` });
    } finally {
      setRevokingId(null);
    }
  };

  const mint = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setMintError(null);
    const name = deviceName.trim();
    if (name.length === 0) {
      setMintError('Device name is required.');
      return;
    }
    setMinting(true);
    try {
      const res = await fetch('/ggui/console/keys', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ deviceName: name }),
      });
      if (res.status === 401) {
        navigateTo(`/admin-login?next=${encodeURIComponent('/admin/connector-keys')}`);
        return;
      }
      if (!res.ok) {
        setMintError(`mint failed — server returned ${res.status}`);
        return;
      }
      const body = (await res.json()) as MintResult;
      setMintResult(body);
      setDeviceName('');
      await refresh();
    } catch (err) {
      setMintError(`mint failed — ${String(err)}`);
    } finally {
      setMinting(false);
    }
  };

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / keys"
        title="Paired bearer tokens."
        mute="Personal-mode bearers minted by /pair."
        intro={
          <>
            Each row is a paired bearer minted by the pairing service —
            paste these into MCP clients (Claude Desktop, claude.ai)
            as the <code className="ggui-code">Authorization: Bearer</code>{' '}
            header. Tokens are stored in plaintext on disk
            (<code className="ggui-code">~/.ggui/keys.json</code> by
            default); treat this page like{' '}
            <code className="ggui-code">~/.ssh/</code> — anyone with
            view access can copy a bearer.
          </>
        }
      />

      <MintForm
        deviceName={deviceName}
        onDeviceName={setDeviceName}
        minting={minting}
        error={mintError}
        result={mintResult}
        onSubmit={(e) => {
          void mint(e);
        }}
        onDismissResult={() => setMintResult(null)}
      />

      {state.kind === 'loading' ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          Loading keys…
        </p>
      ) : state.kind === 'error' ? (
        <p
          className="ggui-muted"
          style={{ margin: 0, padding: 12 }}
          data-ggui-keys-error
        >
          Couldn&apos;t load keys — {state.message}
        </p>
      ) : (
        <KeyList
          keys={state.data.keys}
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

function MintForm({
  deviceName,
  onDeviceName,
  minting,
  error,
  result,
  onSubmit,
  onDismissResult,
}: {
  readonly deviceName: string;
  readonly onDeviceName: (next: string) => void;
  readonly minting: boolean;
  readonly error: string | null;
  readonly result: MintResult | null;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onDismissResult: () => void;
}): ReactElement {
  return (
    <div className="ggui-card" style={{ marginBottom: 20 }}>
      <div className="ggui-card__head">
        <span className="ggui-card__title">mint a new key</span>
        <span className="ggui-card__num">KEY / NEW</span>
      </div>
      <div className="ggui-card__body">
        <form className="ggui-form" onSubmit={onSubmit}>
          <div className="ggui-form__row">
            <label
              className="ggui-field"
              aria-label="device name for the new key"
            >
              <input
                type="text"
                placeholder="device name (e.g. Claude Desktop, iPhone)"
                value={deviceName}
                onChange={(e) => onDeviceName(e.target.value)}
                disabled={minting}
                maxLength={256}
              />
            </label>
            <button
              type="submit"
              className="ggui-btn"
              data-ggui-key-mint
              disabled={minting || deviceName.trim().length === 0}
            >
              <span className="ggui-btn__dot" aria-hidden />
              {minting ? 'minting…' : 'mint'}
            </button>
          </div>
        </form>
        {error ? (
          <p className="ggui-muted" style={{ marginTop: 10 }}>
            {error}
          </p>
        ) : null}
        {result ? (
          <MintResultCard result={result} onDismiss={onDismissResult} />
        ) : null}
      </div>
    </div>
  );
}

function MintResultCard({
  result,
  onDismiss,
}: {
  readonly result: MintResult;
  readonly onDismiss: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail in non-secure contexts (HTTP without
      // localhost exception). Fall through silently — the operator
      // can still select + copy by hand from the visible code block.
    }
  };
  return (
    <div
      className="ggui-card"
      style={{ marginTop: 16 }}
      data-ggui-key-mint-result
    >
      <div className="ggui-card__head">
        <span className="ggui-card__title">
          new bearer minted — copy it now
        </span>
        <span className="ggui-card__num">KEY / FRESH</span>
      </div>
      <div className="ggui-card__body">
        <p className="ggui-muted" style={{ marginTop: 0 }}>
          Paste this into your MCP client&apos;s{' '}
          <code className="ggui-code">Authorization: Bearer</code>{' '}
          header. The plaintext stays visible until you dismiss this
          card — there&apos;s no second-fetch path; close the page and
          you&apos;ll need to copy it from the table below or mint a
          fresh one.
        </p>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 12,
          }}
        >
          <code
            className="ggui-code"
            style={{
              flex: 1,
              padding: 10,
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {result.token}
          </code>
          <button
            type="button"
            className="ggui-btn ggui-btn--ghost"
            onClick={() => {
              void onCopy();
            }}
          >
            <span className="ggui-btn__dot" aria-hidden />
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
        <div className="ggui-stack__entry-meta" style={{ marginTop: 12 }}>
          <span>
            device <code className="ggui-code">{result.deviceName}</code>
          </span>
          <span style={{ marginLeft: 12 }}>
            id <code className="ggui-code">{result.pairingId}</code>
          </span>
        </div>
        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            className="ggui-btn ggui-btn--ghost"
            onClick={onDismiss}
          >
            dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyList({
  keys,
  revokingId,
  pendingConfirm,
  onRevokeRequest,
  onRevokeCancel,
  onRevokeConfirm,
  onRefresh,
}: {
  readonly keys: readonly KeySummary[];
  readonly revokingId: string | null;
  readonly pendingConfirm: string | null;
  readonly onRevokeRequest: (pairingId: string) => void;
  readonly onRevokeCancel: () => void;
  readonly onRevokeConfirm: (pairingId: string) => void;
  readonly onRefresh: () => void;
}): ReactElement {
  if (keys.length === 0) {
    return (
      <div
        className="ggui-stack"
        data-ggui-keys-list
        aria-label="paired keys (empty)"
      >
        <div className="ggui-stack__head">
          <span className="ggui-stack__num">KEY</span>
          <span className="ggui-stack__label">paired keys</span>
          <span className="ggui-stack__count">0</span>
        </div>
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          No keys minted yet. Use the form above to mint one, or
          complete a <code className="ggui-code">POST /pair</code> from
          a viewer client to land a row here.
        </p>
      </div>
    );
  }
  return (
    <div
      data-ggui-keys-list
      className="ggui-stack"
      aria-label="paired keys"
    >
      <div className="ggui-stack__head">
        <span className="ggui-stack__num">KEY</span>
        <span className="ggui-stack__label">paired keys</span>
        <span className="ggui-stack__count">{keys.length}</span>
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
        {keys.map((key, index) => (
          <KeyRow
            key={key.pairingId}
            entry={key}
            index={index + 1}
            isRevoking={revokingId === key.pairingId}
            isPendingConfirm={pendingConfirm === key.pairingId}
            onRevokeRequest={onRevokeRequest}
            onRevokeCancel={onRevokeCancel}
            onRevokeConfirm={onRevokeConfirm}
          />
        ))}
      </ul>
    </div>
  );
}

function KeyRow({
  entry,
  index,
  isRevoking,
  isPendingConfirm,
  onRevokeRequest,
  onRevokeCancel,
  onRevokeConfirm,
}: {
  readonly entry: KeySummary;
  readonly index: number;
  readonly isRevoking: boolean;
  readonly isPendingConfirm: boolean;
  readonly onRevokeRequest: (pairingId: string) => void;
  readonly onRevokeCancel: () => void;
  readonly onRevokeConfirm: (pairingId: string) => void;
}): ReactElement {
  return (
    <li
      data-ggui-key-id={entry.pairingId}
      className="ggui-stack__entry"
      style={{ opacity: isRevoking ? 0.5 : 1 }}
    >
      <div className="ggui-stack__entry-head">
        <span className="ggui-stack__entry-num">
          {`KEY / ${String(index).padStart(2, '0')}`}
        </span>
        <span className="ggui-stack__entry-title">{entry.deviceName}</span>
      </div>
      <div className="ggui-stack__entry-meta">
        <span>
          id <code className="ggui-code">{entry.pairingId}</code>
        </span>
        <span style={{ marginLeft: 12 }}>
          minted{' '}
          <code className="ggui-code">{formatRelative(entry.createdAt)}</code>
        </span>
        {entry.lastUsedAt !== undefined ? (
          <span style={{ marginLeft: 12 }}>
            used{' '}
            <code className="ggui-code">
              {formatRelative(entry.lastUsedAt)}
            </code>
          </span>
        ) : null}
      </div>
      <div className="ggui-stack__entry-meta" style={{ marginTop: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          token{' '}
          {entry.token === null ? (
            <code className="ggui-code">— rotated, re-pair to recover</code>
          ) : (
            <code
              className="ggui-code"
              style={{ wordBreak: 'break-all', userSelect: 'all' }}
            >
              {entry.token}
            </code>
          )}
        </span>
      </div>
      <div
        style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}
      >
        {isPendingConfirm ? (
          <>
            <button
              type="button"
              className="ggui-btn"
              data-ggui-key-revoke
              disabled={isRevoking}
              onClick={() => onRevokeConfirm(entry.pairingId)}
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
            data-ggui-key-revoke
            disabled={isRevoking}
            onClick={() => onRevokeRequest(entry.pairingId)}
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
