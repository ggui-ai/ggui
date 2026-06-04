/**
 * AdminLlmKeys route — `/admin/llm-keys` (admin-cookie-gated).
 *
 * Operator-side LLM provider keys plane — "manage server-default
 * keys", living in the admin sub-shell. Bounces 401s to
 * `/admin-login`.
 *
 * Mirrors the `Keys.tsx` (connector-keys) shape: focused list +
 * paste form + clear button.
 *
 * Wire shape:
 *
 *   GET /ggui/console/llm-keys
 *     → 200 { providers: [...], scope }
 *     → 401 (cookie missing/invalid) → bounce to /admin-login
 *
 *   POST /ggui/console/llm-keys { provider, key }
 *     → 200 { provider, source: 'file', envOverridden, envName? }
 *
 *   DELETE /ggui/console/llm-keys/:provider
 *     → 204 (idempotent)
 *
 * Test contract (data-attrs):
 *   - `data-ggui-admin-llm-list`           on the rows container
 *   - `data-ggui-admin-llm-row={provider}` on every row
 *   - `data-ggui-admin-llm-set`            on the paste form's submit
 *   - `data-ggui-admin-llm-clear`          on the clear button
 */
import {
  useEffect,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { navigateTo } from '../router.js';

type Provider = 'anthropic' | 'openai' | 'google' | 'openrouter';

interface ProviderRow {
  readonly name: Provider;
  readonly configured: boolean;
  readonly source: 'env' | 'file' | null;
  readonly envName?: string;
  readonly envNames: readonly string[];
  readonly inFile: boolean;
  readonly keyPreview?: string;
}

interface ListResponse {
  readonly providers: readonly ProviderRow[];
  readonly scope: string;
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: ListResponse }
  | { readonly kind: 'error'; readonly message: string };

interface ProviderDisplay {
  readonly label: string;
  readonly help: string;
  readonly apiKeyUrl: string;
}

const PROVIDER_DISPLAY: Record<Provider, ProviderDisplay> = {
  anthropic: {
    label: 'Anthropic',
    help: 'Used by Claude models.',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI',
    help: 'Used by GPT models.',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  google: {
    label: 'Google',
    help: 'Used by Gemini models.',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  openrouter: {
    label: 'OpenRouter',
    help: 'Routes to any provider via one key.',
    apiKeyUrl: 'https://openrouter.ai/keys',
  },
};

function bounceToAdminLogin(): void {
  if (typeof window === 'undefined') return;
  const next = window.location.pathname + window.location.search;
  navigateTo(`/admin-login?next=${encodeURIComponent(next)}`);
}

function sanitizeKey(value: string): string {
  // Strip ANSI escapes + all whitespace (no supported provider key
  // contains internal whitespace; copy-paste from terminals routinely
  // re-flows long lines with newlines/tabs/bracketed-paste markers).
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[\d;]*[a-zA-Z]/g, '').replace(/\s+/g, '');
}

export function AdminLlmKeys(): ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  const refresh = async (): Promise<void> => {
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const res = await fetch('/ggui/console/llm-keys', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (res.status === 401) {
        bounceToAdminLogin();
        return;
      }
      if (!res.ok) {
        setState({
          kind: 'error',
          message:
            res.status === 404
              ? 'BYOK store not enabled — `ggui serve` should wire one by default.'
              : `server returned ${res.status}`,
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
    void refresh();
  }, []);

  const setKey = async (provider: Provider, key: string): Promise<void> => {
    const res = await fetch('/ggui/console/llm-keys', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ provider, key }),
    });
    if (res.status === 401) {
      bounceToAdminLogin();
      return;
    }
    if (!res.ok) {
      throw new Error(`server returned ${res.status}`);
    }
    await refresh();
  };

  const clearKey = async (provider: Provider): Promise<void> => {
    const res = await fetch(
      `/ggui/console/llm-keys/${encodeURIComponent(provider)}`,
      { method: 'DELETE', credentials: 'include' },
    );
    if (res.status === 401) {
      bounceToAdminLogin();
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
        num="01 / admin / llm-keys"
        title="Operator-side LLM keys."
        mute="Server-default keys for unpaired and operator generation."
        intro={
          <>
            Each provider is checked against env vars first, then{' '}
            <code className="ggui-code">~/.ggui/credentials.json</code> —
            env wins on collision. These are the keys{' '}
            <code className="ggui-code">ggui serve</code> uses for any
            generation that doesn&apos;t carry a paired-user scope. The
            same plane is exposed to paired users at{' '}
            <code className="ggui-code">/settings</code>; the difference
            is which scope the writes land in.
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
          data-ggui-admin-llm-error
        >
          Couldn&apos;t load providers — {state.message}
        </p>
      ) : (
        <ProviderList
          rows={state.data.providers}
          scope={state.data.scope}
          onSet={setKey}
          onClear={clearKey}
        />
      )}
    </section>
  );
}

function ProviderList({
  rows,
  scope,
  onSet,
  onClear,
}: {
  readonly rows: readonly ProviderRow[];
  readonly scope: string;
  readonly onSet: (provider: Provider, key: string) => Promise<void>;
  readonly onClear: (provider: Provider) => Promise<void>;
}): ReactElement {
  return (
    <div data-ggui-admin-llm-list>
      <p
        className="ggui-muted"
        style={{ marginTop: 0, marginBottom: 16, fontSize: 12 }}
      >
        scope: <code className="ggui-code">{scope}</code>
      </p>
      <div style={{ display: 'grid', gap: 14 }}>
        {rows.map((row) => (
          <ProviderRow
            key={row.name}
            row={row}
            onSet={onSet}
            onClear={onClear}
          />
        ))}
      </div>
    </div>
  );
}

function ProviderRow({
  row,
  onSet,
  onClear,
}: {
  readonly row: ProviderRow;
  readonly onSet: (provider: Provider, key: string) => Promise<void>;
  readonly onClear: (provider: Provider) => Promise<void>;
}): ReactElement {
  const display = PROVIDER_DISPLAY[row.name];
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const sanitized = sanitizeKey(draft);
    if (!sanitized) return;
    setBusy(true);
    setError(null);
    try {
      await onSet(row.name, sanitized);
      setDraft('');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onClear(row.name);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ggui-card" data-ggui-admin-llm-row={row.name}>
      <div className="ggui-card__head">
        <span className="ggui-card__title">{display.label}</span>
        <span className="ggui-card__num">
          {row.configured ? row.source ?? '—' : 'not set'}
        </span>
      </div>
      <div className="ggui-card__body">
        <p className="ggui-muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
          {display.help}
          {row.envNames.length > 0 ? (
            <>
              {' '}
              Env:{' '}
              {row.envNames.map((name, i) => (
                <span key={name}>
                  <code className="ggui-code">{name}</code>
                  {i < row.envNames.length - 1 ? ', ' : ''}
                </span>
              ))}
              .
            </>
          ) : null}
        </p>
        {row.configured && row.keyPreview ? (
          <p className="ggui-muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
            current: <code className="ggui-code">{row.keyPreview}…</code>
            {row.source === 'env' && row.envName ? (
              <> (from <code className="ggui-code">{row.envName}</code>)</>
            ) : null}
          </p>
        ) : null}
        <form
          onSubmit={submit}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <input
            type="password"
            placeholder={`Paste ${display.label} key`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 240,
              padding: '8px 10px',
              fontFamily: 'var(--ggui-mono)',
              fontSize: 12,
              border: '1px solid var(--ggui-line-2)',
              background: 'var(--ggui-paper)',
              color: 'var(--ggui-ink)',
              borderRadius: 2,
            }}
          />
          <button
            type="submit"
            data-ggui-admin-llm-set
            className="ggui-btn"
            disabled={busy || !draft.trim()}
          >
            {busy ? 'saving…' : 'save'}
          </button>
          {row.inFile ? (
            <button
              type="button"
              data-ggui-admin-llm-clear
              className="ggui-btn ggui-btn--ghost"
              onClick={() => void clear()}
              disabled={busy}
            >
              clear
            </button>
          ) : null}
          <a
            href={display.apiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ggui-muted"
            style={{ fontSize: 12 }}
          >
            issue a key →
          </a>
        </form>
        {row.source === 'env' && row.inFile ? (
          <p
            className="ggui-muted"
            style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}
          >
            File value present but env var{' '}
            <code className="ggui-code">{row.envName}</code> overrides.
          </p>
        ) : null}
        {error ? (
          <p
            className="ggui-muted"
            style={{
              marginTop: 8,
              marginBottom: 0,
              fontSize: 12,
              color: 'var(--ggui-color-error, #c5374b)',
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
