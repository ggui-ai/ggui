/**
 * AdminOAuthProviders route — `/admin/oauth-providers` (admin-gated).
 *
 * Operator-facing config plane for OAuth login providers (Google,
 * GitHub) so end-users can sign in via their existing identity. Each
 * card is one provider slot. Slots can be:
 *
 *   - `source: 'env'`   — set via `GGUI_OAUTH_<PROVIDERID>_CLIENT_ID`
 *                         + `_CLIENT_SECRET`. Read-only via API.
 *   - `source: 'file'`  — set via this UI; persisted to
 *                         `~/.ggui/oauth-providers.json` (mode 0600).
 *   - absent            — no slot exists yet; the card renders an
 *                         empty form.
 *
 * Wire shape (Agent C):
 *
 *   GET /ggui/admin/oauth-providers
 *     → 200 { providers: [{providerId, clientId, clientSecret, source, enabled}] }
 *     → 401 { error: 'admin_auth_required' }
 *
 *   PUT /ggui/admin/oauth-providers/:providerId  (X-Ggui-CSRF)
 *     body { clientId, clientSecret, enabled } → 200 { provider }
 *
 *   DELETE /ggui/admin/oauth-providers/:providerId  (X-Ggui-CSRF)
 *     → 204 (idempotent). 409 if `source: 'env'` (not file-deletable).
 *
 *   GET /ggui/csrf-token
 *     → 200 { token: string }
 *
 * Test contract (data-attrs):
 *   - `data-ggui-oauth-providers-list`  on the cards container.
 *   - `data-ggui-oauth-provider-card={providerId}` on every card.
 *   - `data-ggui-oauth-provider-save`  on the save button.
 *   - `data-ggui-oauth-provider-delete` on the delete button.
 */
import {
  useEffect,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { navigateTo } from '../router.js';

type ProviderId = 'google' | 'github';

interface ProviderRow {
  readonly providerId: ProviderId;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly source: 'file' | 'env';
  readonly enabled: boolean;
}

interface ListResponse {
  readonly providers: readonly ProviderRow[];
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: ListResponse }
  | { readonly kind: 'error'; readonly message: string };

const KNOWN_PROVIDERS: readonly { readonly id: ProviderId; readonly label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
];

const REDACTED_SECRET = '<redacted>';

/**
 * Tiny same-origin fetch wrapper that injects an admin-cookie request
 * (`credentials: 'include'`) plus the `X-Ggui-CSRF` header from the
 * cached token. On 403 the token is refreshed once and the request
 * retried — covers the case where the token was rotated server-side
 * between mount and first mutation.
 */
async function csrfFetch(
  input: string,
  init: RequestInit,
  token: string | null,
  refresh: () => Promise<string | null>,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (token !== null) headers.set('X-Ggui-CSRF', token);
  const res = await fetch(input, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (res.status !== 403) return res;
  const next = await refresh();
  if (next === null) return res;
  const retryHeaders = new Headers(init.headers ?? {});
  retryHeaders.set('X-Ggui-CSRF', next);
  return fetch(input, { ...init, headers: retryHeaders, credentials: 'include' });
}

export function AdminOAuthProviders(): ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const fetchCsrfToken = async (): Promise<string | null> => {
    try {
      const res = await fetch('/ggui/csrf-token', {
        headers: { accept: 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { readonly token: string };
      setCsrfToken(body.token);
      return body.token;
    } catch {
      return null;
    }
  };

  const refresh = async (): Promise<void> => {
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const res = await fetch('/ggui/admin/oauth-providers', {
        headers: { accept: 'application/json' },
        credentials: 'include',
      });
      if (res.status === 401) {
        navigateTo(
          `/admin-login?next=${encodeURIComponent('/admin/oauth-providers')}`,
        );
        return;
      }
      if (!res.ok) {
        setState({
          kind: 'error',
          message: `server returned ${res.status}`,
        });
        return;
      }
      const body = (await res.json()) as ListResponse;
      setState({ kind: 'ready', data: body });
    } catch (err) {
      setState({ kind: 'error', message: String(err) });
    }
  };

  useEffect(() => {
    void fetchCsrfToken();
    void refresh();
  }, []);

  const saveProvider = async (
    providerId: ProviderId,
    body: { readonly clientId: string; readonly clientSecret: string; readonly enabled: boolean },
  ): Promise<void> => {
    const res = await csrfFetch(
      `/ggui/admin/oauth-providers/${encodeURIComponent(providerId)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      csrfToken,
      fetchCsrfToken,
    );
    if (res.status === 401) {
      navigateTo(
        `/admin-login?next=${encodeURIComponent('/admin/oauth-providers')}`,
      );
      return;
    }
    if (!res.ok) {
      throw new Error(`server returned ${res.status}`);
    }
    await refresh();
  };

  const deleteProvider = async (providerId: ProviderId): Promise<void> => {
    const res = await csrfFetch(
      `/ggui/admin/oauth-providers/${encodeURIComponent(providerId)}`,
      { method: 'DELETE' },
      csrfToken,
      fetchCsrfToken,
    );
    if (res.status === 401) {
      navigateTo(
        `/admin-login?next=${encodeURIComponent('/admin/oauth-providers')}`,
      );
      return;
    }
    if (res.status !== 204) {
      throw new Error(`server returned ${res.status}`);
    }
    await refresh();
  };

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / oauth"
        title="OAuth login providers."
        mute="Operator-only — end-user sign-in identity."
        intro={
          <>
            Configure OAuth login providers so end-users can sign in
            with their existing identity. Operator-only — these
            credentials are stored at{' '}
            <code className="ggui-code">~/.ggui/oauth-providers.json</code>{' '}
            (mode 0600). Set the{' '}
            <code className="ggui-code">
              GGUI_OAUTH_&lt;PROVIDERID&gt;_CLIENT_ID
            </code>{' '}
            /{' '}
            <code className="ggui-code">_CLIENT_SECRET</code> env vars to
            override per-deployment.
          </>
        }
      />

      {state.kind === 'loading' ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          Loading providers…
        </p>
      ) : state.kind === 'error' ? (
        <p
          className="ggui-muted"
          style={{ margin: 0, padding: 12 }}
          data-ggui-oauth-providers-error
        >
          Couldn&apos;t load providers — {state.message}
        </p>
      ) : (
        <div
          data-ggui-oauth-providers-list
          className="ggui-stack"
          aria-label="oauth providers"
        >
          {KNOWN_PROVIDERS.map((spec) => {
            const row = state.data.providers.find(
              (r) => r.providerId === spec.id,
            );
            return (
              <ProviderCard
                key={spec.id}
                providerId={spec.id}
                label={spec.label}
                row={row}
                onSave={saveProvider}
                onDelete={deleteProvider}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProviderCard({
  providerId,
  label,
  row,
  onSave,
  onDelete,
}: {
  readonly providerId: ProviderId;
  readonly label: string;
  readonly row: ProviderRow | undefined;
  readonly onSave: (
    providerId: ProviderId,
    body: { readonly clientId: string; readonly clientSecret: string; readonly enabled: boolean },
  ) => Promise<void>;
  readonly onDelete: (providerId: ProviderId) => Promise<void>;
}): ReactElement {
  const isEnv = row?.source === 'env';
  const isFile = row?.source === 'file';
  const initialClientId = row?.clientId ?? '';
  const initialEnabled = row?.enabled ?? true;

  const [clientId, setClientId] = useState(initialClientId);
  // For 'file' rows the server returns the literal '<redacted>' marker
  // — we keep the field empty so that "save without typing a new
  // secret" is unambiguous (only re-PUT when the operator typed
  // something). For 'env' rows the marker is read-only.
  const [clientSecret, setClientSecret] = useState('');
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Keep local state in sync when the upstream row changes (refresh
  // after a save replaces `row`). Without this the form sticks on the
  // pre-save values and "save" stays disabled.
  useEffect(() => {
    setClientId(row?.clientId ?? '');
    setClientSecret('');
    setEnabled(row?.enabled ?? true);
  }, [row?.clientId, row?.enabled, row?.source]);

  const dirty =
    clientId !== initialClientId ||
    clientSecret.trim().length > 0 ||
    enabled !== initialEnabled;

  const handleSave = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setErr(null);
    if (clientId.trim().length === 0) {
      setErr('Client ID is required.');
      return;
    }
    // Brand-new slots need a secret; existing 'file' slots keep the
    // stored secret if the operator left the field blank.
    if (!isFile && clientSecret.trim().length === 0) {
      setErr('Client Secret is required.');
      return;
    }
    setBusy(true);
    try {
      await onSave(providerId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        enabled,
      });
    } catch (e) {
      setErr(`save failed — ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (
      !window.confirm(
        `Delete ${label} OAuth config? End-users will no longer be able to sign in with ${label}.`,
      )
    ) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await onDelete(providerId);
    } catch (e) {
      setErr(`delete failed — ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-ggui-oauth-provider-card={providerId}
      className="ggui-card"
      style={{ opacity: busy ? 0.6 : 1 }}
    >
      <div className="ggui-card__head">
        <span className="ggui-card__title">{label}</span>
        <span style={{ marginLeft: 'auto' }}>
          <ProvenanceBadge row={row} />
        </span>
      </div>
      <div className="ggui-card__body">
        <form className="ggui-form" onSubmit={(e) => { void handleSave(e); }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              aria-label={`${label} client ID`}
            >
              <span className="ggui-muted">Client ID</span>
              <span className="ggui-field">
                <input
                  type="text"
                  placeholder={
                    row === undefined
                      ? `paste ${label} OAuth client ID`
                      : ''
                  }
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  readOnly={isEnv}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  data-ggui-oauth-provider-client-id
                />
              </span>
            </label>
            <label
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              aria-label={`${label} client secret`}
            >
              <span className="ggui-muted">Client Secret</span>
              <span className="ggui-field">
                <input
                  type="password"
                  placeholder={
                    isEnv
                      ? REDACTED_SECRET
                      : isFile
                        ? `${REDACTED_SECRET} — leave blank to keep`
                        : `paste ${label} OAuth client secret`
                  }
                  value={isEnv ? REDACTED_SECRET : clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  readOnly={isEnv}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  data-ggui-oauth-provider-client-secret
                />
              </span>
            </label>
            <label
              style={{
                display: 'inline-flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
              aria-label={`${label} enabled`}
            >
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={isEnv || busy}
                style={{ flex: 'none', width: 'auto' }}
                data-ggui-oauth-provider-enabled
              />
              <span>Enabled</span>
              {isEnv ? (
                <span className="ggui-muted" style={{ marginLeft: 8 }}>
                  env-overrides are always-on
                </span>
              ) : null}
            </label>
          </div>
          <div
            className="ggui-form__row"
            style={{ marginTop: 12, gap: 8 }}
          >
            <button
              type="submit"
              className="ggui-btn"
              data-ggui-oauth-provider-save
              disabled={isEnv || busy || !dirty}
            >
              <span className="ggui-btn__dot" aria-hidden />
              {busy ? 'saving…' : 'save'}
            </button>
            {isFile ? (
              <button
                type="button"
                className="ggui-btn ggui-btn--ghost"
                data-ggui-oauth-provider-delete
                disabled={busy}
                onClick={() => {
                  void handleDelete();
                }}
                style={{ color: 'crimson', borderColor: 'crimson' }}
              >
                delete
              </button>
            ) : null}
          </div>
        </form>
        {err ? (
          <p
            className="ggui-muted"
            style={{ marginTop: 8 }}
            data-ggui-oauth-provider-error
          >
            {err}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function ProvenanceBadge({
  row,
}: {
  readonly row: ProviderRow | undefined;
}): ReactElement {
  if (row === undefined) {
    return (
      <span className="ggui-tag" style={{ opacity: 0.5 }}>
        not configured
      </span>
    );
  }
  if (row.source === 'env') {
    return (
      <span className="ggui-tag" title="set via GGUI_OAUTH_*_CLIENT_ID/_SECRET env vars">
        configured (env)
      </span>
    );
  }
  return (
    <span className="ggui-tag" title="set via this UI; persisted to ~/.ggui/oauth-providers.json">
      configured (file)
    </span>
  );
}
