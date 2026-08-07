/// <reference types="vite/client" />

/**
 * Typed Vite env vars for the with-guuey-web sample. Anything declared
 * here is exposed to the browser bundle at build time. Keep this list in
 * sync with the README's environment table so the typecheck refuses to
 * compile if a new env var is referenced but undeclared.
 */
interface ImportMetaEnv {
  /**
   * guuey dev router base URL (`guuey dev --serve` in the agent half,
   * `../../agents/with-guuey`). Optional — defaults to the dev router's
   * own default bind, `http://localhost:6790`.
   */
  readonly VITE_GUUEY_ENDPOINT?: string;
  /**
   * The guuey app id (matches `appId` in the agent half's `guuey.json`).
   * Namespaces the persisted thread key. Optional — defaults to
   * `ggui-golden-path`.
   */
  readonly VITE_GUUEY_APP_ID?: string;
  /**
   * Second-origin MCP-Apps sandbox host page URL. Always present: injected
   * by `vite.config.ts` via `define` (self-booted proxy on
   * `SANDBOX_PROXY_PORT`, default 7890), or passed through verbatim when
   * the `VITE_SANDBOX_URL` env var points at an external sandbox host.
   */
  readonly VITE_SANDBOX_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
