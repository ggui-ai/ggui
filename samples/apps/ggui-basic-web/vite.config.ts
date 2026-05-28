import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the ggui-basic-web reference SPA.
 *
 * Posture:
 *
 *   - Pure SPA (no SSR, no file-system routing) — this app is presentation
 *     only and talks to a separate MCP-Apps-spec agent backend over HTTP.
 *     That backend (oss/samples/agents/*) is the only server in the loop;
 *     this frontend never proxies, never owns secrets, never runs server
 *     code. Vite is the right tool for that posture; Next.js's file-system
 *     routing + server components + middleware would falsely signal
 *     "colocate server logic here".
 *
 *   - `server.port` pinned at 6890 to match the e2e harness's
 *     `HARNESS_PORTS.nextjs` (kept the same number so harness changes
 *     stay minimal; consider renaming the harness constant later).
 *
 *   - `server.strictPort` so a port collision FAILS LOUD instead of
 *     silently moving to the next free port — the harness pre-flight
 *     check assumes the bind is on 6890.
 *
 *   - No `transpilePackages` equivalent needed: Vite walks workspace
 *     symlinks natively and the @ggui-ai/* packages ship usable ESM.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 6890,
    strictPort: true,
    host: '127.0.0.1',
  },
  preview: {
    port: 6890,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
