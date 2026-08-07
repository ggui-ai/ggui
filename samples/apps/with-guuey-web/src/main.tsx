import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import { App } from './App';

/**
 * Vite SPA entry point — same shape as `../../ggui-basic-web/src/main.tsx`.
 * `index.html` references this module via `<script type="module">`.
 */
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('with-guuey-web: #root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
