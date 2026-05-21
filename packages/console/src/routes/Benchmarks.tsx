/**
 * `Benchmarks` — `/devtools/benchmarks` surface.
 *
 * Embeds a benchmark dashboard URL in an iframe. Operator points it at:
 *   - the public benchmarks.ggui.ai dashboard
 *   - their own bench dashboard if they've deployed one
 *   - a local `npx serve ./bench-results/` for offline dev
 *
 * The URL is persisted in localStorage so it survives reloads. Empty
 * state explains how to get a URL — keeps the surface useful even
 * before the operator has configured one.
 *
 * Iframe-embedded rather than inlining @ggui-ai/benchmark-viewer because
 * the viewer's brand-kit Tailwind classes don't compose with console's
 * own CSS class system. Iframe gives the dashboard its full styling
 * environment without bleeding into console's chrome.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { SectionHead } from '../brand/SectionHead.js';

const STORAGE_KEY = 'ggui-console:benchmark-dashboard-url';
const DEFAULT_URL = 'https://benchmarks.ggui.ai';

export function Benchmarks(): ReactElement {
  const [url, setUrl] = useState<string>('');
  const [draftUrl, setDraftUrl] = useState<string>('');

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setUrl(saved);
      setDraftUrl(saved);
    }
  }, []);

  const persistUrl = (next: string) => {
    const trimmed = next.trim();
    setUrl(trimmed);
    if (trimmed) {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  return (
    <section className="ggui-section">
      <SectionHead
        num="DEVTOOLS / 06"
        title="Benchmarks dashboard."
        mute="GGUI_MODE=dev"
        intro={
          <>
            Embed a <code className="ggui-code">@ggui-ai/benchmark</code>{' '}
            dashboard. Default points at{' '}
            <code className="ggui-code">benchmarks.ggui.ai</code> (the public
            ggui-protocol leaderboard); paste any URL serving the same shape to
            view your own runs.
          </>
        }
      />

      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">dashboard URL</span>
          <span className="ggui-card__num">DEV / 06</span>
        </div>
        <div className="ggui-card__body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              persistUrl(draftUrl);
            }}
            style={{ display: 'flex', gap: 8 }}
          >
            <input
              type="url"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder={DEFAULT_URL}
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1,
                padding: '8px 10px',
                fontFamily:
                  'var(--ggui-font-mono, ui-monospace, monospace)',
                fontSize: 13,
                border: '1px solid var(--ggui-rule)',
                background: 'var(--ggui-paper)',
                color: 'var(--ggui-ink)',
              }}
            />
            <button
              type="submit"
              className="ggui-btn"
              disabled={draftUrl.trim() === url.trim()}
            >
              load
            </button>
            {url && (
              <button
                type="button"
                className="ggui-btn ggui-btn--muted"
                onClick={() => {
                  setDraftUrl('');
                  persistUrl('');
                }}
              >
                clear
              </button>
            )}
          </form>
          <p
            className="ggui-muted"
            style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5 }}
          >
            URL persists across reloads. Local dev:{' '}
            <code className="ggui-code">npx serve ./bench-results</code> then
            paste <code className="ggui-code">http://localhost:3000</code>.
          </p>
        </div>
      </div>

      {url && (
        <div className="ggui-card" style={{ marginTop: 16 }}>
          <div className="ggui-card__head">
            <span className="ggui-card__title">{url}</span>
            <span className="ggui-card__num">DEV / 06.1</span>
          </div>
          <div className="ggui-card__body" style={{ padding: 0 }}>
            <iframe
              src={url}
              title="Benchmarks dashboard"
              style={{
                width: '100%',
                height: '78vh',
                border: 'none',
                background: 'var(--ggui-paper)',
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
