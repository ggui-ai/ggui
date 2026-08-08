import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import {
  startSandboxProxyServer,
  type SandboxProxyServerHandle,
} from '@ggui-ai/agent-server';

/**
 * Vite config for the with-guuey-web composed-golden-path SPA.
 *
 * Mirrors `../ggui-basic-web/vite.config.ts` (same pure-SPA posture, same
 * port-resolution contract) with ONE addition: this app's agent backend is
 * guuey's published dev router (`guuey dev --serve`), which serves ONLY
 * `POST /agent/invoke` + `GET /healthz` — unlike the framework-native
 * sample backends it exposes no manifest and boots no MCP-Apps sandbox
 * proxy. `<AppRenderer>` still mandates a second-origin sandbox host page,
 * so this config boots one itself via `@ggui-ai/agent-server`'s
 * `startSandboxProxyServer` (the repo's canonical spec-compliant proxy,
 * exported for exactly this standalone-host case).
 *
 *   - Web app port: `VITE_SERVER_PORT` → `PORT` → 6890 (template contract).
 *   - Sandbox proxy port: `SANDBOX_PROXY_PORT` → 7890. A different PORT is a
 *     different ORIGIN, which is all the MCP Apps double-iframe rule needs.
 *     7890 keeps the framework samples' `agent_port + 1000` idiom relative
 *     to this app (6890 + 1000) while staying clear of their 7790.
 *   - `VITE_SANDBOX_URL` (env) opts OUT of the self-boot and points the app
 *     at an externally-hosted sandbox page instead.
 *
 * The resolved sandbox URL is injected into the client bundle via `define`
 * as `import.meta.env.VITE_SANDBOX_URL`, so vite.config.ts stays the single
 * source of truth for the port.
 */
const SERVER_PORT = Number(process.env.VITE_SERVER_PORT ?? process.env.PORT ?? 6890);
const SANDBOX_PROXY_PORT = Number(process.env.SANDBOX_PROXY_PORT ?? 7890);
/**
 * ggui serve's MCP endpoint — the upstream of the `/ggui-mcp` dev proxy
 * below. The HOST half of this shell relays guest `tools/call` there
 * (App.tsx `relayCallTool`); the proxy makes that call same-origin from
 * the browser's perspective. Default matches the `ggui` mcpServer URL
 * `guuey dev` injects.
 */
const GGUI_MCP_TARGET = process.env.VITE_GGUI_MCP_TARGET ?? 'http://localhost:6781';
const EXTERNAL_SANDBOX_URL = process.env.VITE_SANDBOX_URL;
const SANDBOX_URL =
  EXTERNAL_SANDBOX_URL ?? `http://127.0.0.1:${SANDBOX_PROXY_PORT}/sandbox.html`;

/**
 * Boot the second-origin sandbox proxy alongside Vite's dev AND preview
 * servers, and tear it down when they close. `startSandboxProxyServer`
 * binds 127.0.0.1 (loopback-only) and serves the spec-canonical
 * `sandbox.html` double-iframe relay page.
 */
function sandboxProxyPlugin(): Plugin {
  let handle: SandboxProxyServerHandle | undefined;
  const attach = async (server: ViteDevServer | PreviewServer): Promise<void> => {
    // A config reload re-runs the hook; the previous proxy dies with the
    // previous server's 'close' below, so a live handle here means this
    // hook ran twice for one server generation — reuse, don't re-bind.
    if (handle === undefined) {
      handle = await startSandboxProxyServer({ port: SANDBOX_PROXY_PORT });
    }
    server.httpServer?.once('close', () => {
      void handle?.close();
      handle = undefined;
    });
  };
  return {
    name: 'with-guuey-web:sandbox-proxy',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig({
  plugins: [react(), ...(EXTERNAL_SANDBOX_URL !== undefined ? [] : [sandboxProxyPlugin()])],
  define: {
    'import.meta.env.VITE_SANDBOX_URL': JSON.stringify(SANDBOX_URL),
  },
  server: {
    port: SERVER_PORT,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/ggui-mcp': {
        target: GGUI_MCP_TARGET,
        rewrite: (path) => path.replace(/^\/ggui-mcp/, '/mcp'),
      },
    },
  },
  preview: {
    port: SERVER_PORT,
    strictPort: true,
    host: true,
    allowedHosts: true,
    proxy: {
      '/ggui-mcp': {
        target: GGUI_MCP_TARGET,
        rewrite: (path) => path.replace(/^\/ggui-mcp/, '/mcp'),
      },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
