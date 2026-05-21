/**
 * Vite SPA entry. Mounts the operator surface into `#root`.
 *
 * Keep this file trivially small — every import here contributes to the
 * gzipped bundle budget gate in `scripts/check-bundle-size.ts`
 * (500 KB hard cap per the MVP plan §6.3). The global stylesheet is a
 * single side-effect import; Vite bundles it into one `dist/assets/*.css`
 * file the static handler serves under the CSP's `style-src 'self'`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('console: #root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
