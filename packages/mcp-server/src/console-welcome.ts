import type { OperatorConfig } from '@ggui-ai/project-config';

export interface WelcomePageInputs {
  readonly operator?: OperatorConfig;
  readonly appName?: string;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (raw: string): string =>
  raw.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);

const operatorBlock = (op: OperatorConfig | undefined): string => {
  if (!op) return '';
  const { name, url, tagline, contact } = op;
  if (!name && !url && !tagline && !contact) return '';
  const heading = name
    ? url
      ? `<a class="op-link" href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(name)}</a>`
      : escapeHtml(name)
    : url
      ? `<a class="op-link" href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a>`
      : '';
  const taglineLine = tagline
    ? `<p class="op-tagline">${escapeHtml(tagline)}</p>`
    : '';
  const contactLine = contact
    ? `<p class="op-contact"><a class="cta" href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a></p>`
    : '';
  return `
      <section class="block">
        <p class="eyebrow">Operated by</p>
        ${heading ? `<p class="op-name">${heading}</p>` : ''}
        ${taglineLine}
        ${contactLine}
      </section>`;
};

// Inline ggui Wordmark — paper/ink primitives per brand-kit v1.0.
// Mirrors `apps/landing-ggui-ai/src/components/Wordmark.tsx`. Kept
// inline (not externally fetched) so the welcome page renders without
// any network round-trips.
const WORDMARK_SVG = `<svg viewBox="0 0 224 50" width="112" height="25" aria-label="ggui — generative graphical user interface">
        <path d="M 0 0 H 50 V 25 H 25 V 50 H 0 Z" class="chrome-fill" />
        <rect x="33" y="33" width="17" height="17" class="ink-fill" />
        <path d="M 58 0 H 108 V 25 H 83 V 50 H 58 Z" class="ink-fill" />
        <rect x="91" y="33" width="17" height="17" class="chrome-fill" />
        <path d="M 141 50 C 154.807 50 166 38.8071 166 25 V 0 H 116 V 25 C 116 38.8071 127.193 50 141 50 Z" class="ink-fill" />
        <rect x="174" y="0" width="50" height="50" class="chrome-fill" />
      </svg>`;

export const renderWelcomeHtml = (
  inputs: WelcomePageInputs,
  serverName: string,
): string => {
  const appName = inputs.appName ?? serverName;
  const title = appName ? `${appName} — ggui` : 'ggui';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Geist+Mono:wght@400;500;700&display=swap"
    />
    <style>
      :root {
        color-scheme: light dark;
        --paper: #f4f3ed;
        --paper-2: #ebe9e1;
        --chrome: #d9d9d9;
        --chrome-2: #e4e4e2;
        --ink: #292929;
        --ink-2: #3d3d3d;
        --ink-3: #5a5a5a;
        --ink-4: #8c8c93;
        --line: #d6d4cb;
        --font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --paper: #1a1a1a;
          --paper-2: #1f1f1f;
          --chrome: #5a5a5a;
          --chrome-2: #3d3d3d;
          --ink: #f4f3ed;
          --ink-2: #ebe9e1;
          --ink-3: #d9d9d9;
          --ink-4: #8c8c93;
          --line: #3d3d3d;
        }
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        background: var(--paper);
        color: var(--ink);
        font-family: var(--font-sans);
        font-size: 14px;
        line-height: 1.5;
        font-feature-settings: "ss01", "cv11";
        -webkit-font-smoothing: antialiased;
      }
      a { color: inherit; }
      .chrome-fill { fill: var(--chrome); }
      .ink-fill { fill: var(--ink); }
      main {
        max-width: 560px;
        margin: 0 auto;
        padding: 64px 24px 48px;
      }
      .mark { margin-bottom: 40px; }
      .mark svg { display: block; }
      .eyebrow {
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--ink-4);
        margin: 0 0 8px;
      }
      .title {
        font-size: 22px;
        font-weight: 600;
        letter-spacing: -0.01em;
        margin: 0 0 4px;
      }
      .subtitle {
        font-family: var(--font-mono);
        font-size: 13px;
        color: var(--ink-3);
        margin: 0;
      }
      .block {
        margin-top: 32px;
        padding-top: 24px;
        border-top: 1px solid var(--line);
      }
      .op-name { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
      .op-tagline { color: var(--ink-3); margin: 0; }
      .op-contact { margin: 12px 0 0; }
      .op-link {
        text-decoration: none;
        border-bottom: 1px solid var(--line);
        padding-bottom: 1px;
        transition: border-color 120ms ease;
      }
      .op-link:hover { border-color: var(--ink); }
      .surfaces { display: flex; flex-direction: column; gap: 12px; }
      .surface {
        padding: 14px 16px;
        background: var(--paper-2);
        border: 1px solid var(--line);
        font-family: var(--font-mono);
        font-size: 13px;
        line-height: 1.6;
      }
      .surface-label {
        display: block;
        font-family: var(--font-sans);
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--ink-4);
        margin-bottom: 4px;
      }
      .surface code {
        color: var(--ink);
        font-family: inherit;
      }
      .surface .desc {
        display: block;
        margin-top: 6px;
        font-family: var(--font-sans);
        color: var(--ink-3);
        font-size: 13px;
      }
      .login {
        margin-top: 40px;
        padding-top: 24px;
        border-top: 1px solid var(--line);
      }
      .cta {
        font-family: var(--font-mono);
        font-size: 13px;
        letter-spacing: 0.04em;
        color: var(--ink);
        text-decoration: none;
        border-bottom: 1px solid var(--line);
        padding-bottom: 2px;
        transition: border-color 120ms ease;
      }
      .cta:hover { border-color: var(--ink); }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">${WORDMARK_SVG}</div>
      <p class="eyebrow">App</p>
      <h1 class="title">${escapeHtml(appName || 'ggui')}</h1>
      <p class="subtitle">A ggui server.</p>
      ${operatorBlock(inputs.operator)}
      <section class="block">
        <p class="eyebrow">Public surfaces</p>
        <div class="surfaces">
          <div class="surface">
            <span class="surface-label">GguiSession viewer</span>
            <code>/s/&lt;short-code&gt;</code>
            <span class="desc">Open the live render your agent linked you to.</span>
          </div>
          <div class="surface">
            <span class="surface-label">Blueprint preview</span>
            <code>/preview/&lt;id&gt;</code>
            <span class="desc">View a published UI blueprint by id.</span>
          </div>
        </div>
      </section>
      <p class="login"><a class="cta" href="/admin-login">Operator login &rarr;</a></p>
    </main>
  </body>
</html>
`;
};
