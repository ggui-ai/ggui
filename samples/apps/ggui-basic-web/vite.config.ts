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
 *   - `server.port` defaults to 6890 — matches the e2e harness's
 *     `HARNESS_PORTS.web`. Overridable via `VITE_SERVER_PORT` env var so
 *     the parallel e2e harness can run one preview server per worker on
 *     distinct ports (worker 0 → 6890, worker 1 → 6990, worker 2 → 7090).
 *     Vite intentionally does NOT read `PORT` from env, so we use a
 *     prefixed name to make the harness contract explicit.
 *
 *   - `server.strictPort` so a port collision FAILS LOUD instead of
 *     silently moving to the next free port — the harness pre-flight
 *     check assumes the bind is on the requested port.
 *
 *   - No `transpilePackages` equivalent needed: Vite walks workspace
 *     symlinks natively and the @ggui-ai/* packages ship usable ESM.
 */
const SERVER_PORT = process.env.VITE_SERVER_PORT
  ? Number(process.env.VITE_SERVER_PORT)
  : 6890;

export default defineConfig({
  plugins: [react()],
  server: {
    port: SERVER_PORT,
    strictPort: true,
    host: '127.0.0.1',
  },
  preview: {
    port: SERVER_PORT,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
