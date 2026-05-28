import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import { App } from './App';

/**
 * Vite SPA entry point.
 *
 * Mirrors Next.js's `app/layout.tsx` + auto-injection of `app/page.tsx`,
 * but explicit — Vite has no file-system routing. The `index.html` at
 * the repo root references this module via `<script type="module">`.
 *
 * `<StrictMode>` matches the `reactStrictMode: true` we used to set in
 * `next.config.mjs` — keeps double-render dev-only behaviour identical.
 */
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('ggui-basic-web: #root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
