/**
 * Next.js config for the ggui-basic Next.js sample app.
 *
 * Two notable bits:
 *
 *   1. `transpilePackages` — the workspace's @ggui-ai/* packages ship
 *      as ESM but Next.js's transformer historically needed an opt-in
 *      to walk the workspace symlinks. Keeping the list explicit makes
 *      a missing package's import error point at the right line instead
 *      of falling through to "module not found".
 *   2. No `output: 'standalone'` — the sample is dev-only (Playwright
 *      e2e + manual `pnpm dev`). Production deployment of this kind of
 *      MCP-Apps frontend is an end-user concern, not a sample concern.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@ggui-ai/design',
    '@ggui-ai/iframe-runtime',
    '@ggui-ai/preview-a2ui',
    '@ggui-ai/protocol',
    '@ggui-ai/react',
    '@ggui-ai/shared',
    '@ggui-ai/wire',
  ],
};

module.exports = nextConfig;
