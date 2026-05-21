/**
 * AdminLogin route — `/admin-login`.
 *
 * Bare paste-the-bearer page that exchanges the admin token (printed
 * on the `ggui serve` boot banner) for the
 * `ggui_console_admin` HttpOnly cookie. On success, navigates to
 * `?next=<path>` (defaults to `/admin`). On a 401 we surface "invalid
 * token" and let the operator paste again.
 *
 * Intentionally barebones — single field + button. The threat model
 * + UX are aligned: this is a same-origin local-host gate. No
 * password-strength meters, no remember-me, no MFA. The token has 72
 * bits of entropy and the operator already has it on stdout.
 *
 * Test contract (data-attrs):
 *   - `data-ggui-admin-login-form` on the form.
 *   - `data-ggui-admin-login-submit` on the submit button.
 *   - `data-ggui-admin-login-error` on the error region.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { navigateTo } from '../router.js';

export function AdminLogin(): ReactElement {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve `?next=` from the URL — the route variant doesn't carry
  // it (keeps `getStableRoute` memoization trivial), so we read it on
  // mount. Falls back to `/admin` (the canonical admin index).
  // Disallow off-origin / scheme-bearing values to avoid
  // open-redirect via crafted URLs.
  const next = (() => {
    if (typeof window === 'undefined') return '/admin';
    const raw = new URLSearchParams(window.location.search).get('next');
    if (raw === null || raw === '') return '/admin';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/admin';
    return raw;
  })();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    const candidate = token.trim();
    if (candidate.length === 0) {
      setError('Paste an admin token.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/ggui/console/admin-login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ token: candidate }),
      });
      if (res.status === 204) {
        navigateTo(next);
        return;
      }
      if (res.status === 401) {
        setError(
          'Invalid token. Re-check the value printed on your `ggui serve` boot banner.',
        );
        return;
      }
      setError(`Login failed — server returned ${res.status}`);
    } catch (err) {
      setError(`Login failed — ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / admin"
        title="Sign in to the admin zone."
        mute="Admin token gates /admin and /devtools."
        intro={
          <>
            Paste the admin token printed on your{' '}
            <code className="ggui-code">ggui serve</code> boot banner.
            On success we set a same-origin{' '}
            <code className="ggui-code">ggui_console_admin</code>{' '}
            HttpOnly cookie and bounce you to{' '}
            <code className="ggui-code">{next}</code>.
          </>
        }
      />
      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">admin token</span>
          <span className="ggui-card__num">ADM / IN</span>
        </div>
        <div className="ggui-card__body">
          <form
            className="ggui-form"
            onSubmit={submit}
            data-ggui-admin-login-form
          >
            <div className="ggui-form__row">
              <label className="ggui-field" aria-label="admin token">
                <input
                  type="password"
                  placeholder="ggui_admin_..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={submitting}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              </label>
              <button
                type="submit"
                className="ggui-btn"
                data-ggui-admin-login-submit
                disabled={submitting || token.trim().length === 0}
              >
                <span className="ggui-btn__dot" aria-hidden />
                {submitting ? 'signing in…' : 'sign in'}
              </button>
            </div>
          </form>
          {error ? (
            <p
              className="ggui-muted"
              style={{ marginTop: 12 }}
              data-ggui-admin-login-error
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
