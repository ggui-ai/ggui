/**
 * Iframe-runtime bundle static mount (C8 — plan §C8 Deliverable 2).
 *
 * Serves the `@ggui-ai/iframe-runtime` iframe runtime bundle from
 * `runtimePath` (default `/_ggui/iframe-runtime.js`). The thin-shell
 * HTML served from `ui://ggui/render` dynamic-script-loads this
 * URL on boot — the rendering runtime is OUT of the shell and IN
 * this separately-served file (C8 pivot, shrinking the shell from
 * ~175 LOC inline JS to ~30 LOC wrapper).
 *
 * Routing discipline: registered BEFORE the console block because
 * console's default `path` is `/` and its `express.static`
 * + SPA-fallback would otherwise match `/_ggui/iframe-runtime.js` first
 * (Express route table is order-sensitive). Registering early keeps
 * the runtime path from leaking into the console's `index.html`
 * fallback on a missing-bundle day.
 *
 * Missing-bundle posture mirrors the console mount: 503 with a
 * `pnpm --filter @ggui-ai/iframe-runtime build` remediation hint. Silent
 * 404 would be mistaken for "renderer is broken" instead of
 * "renderer bundle wasn't built" — same debugging trap console
 * avoids.
 */

import type { Express } from "express";
import { existsSync } from "node:fs";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** HTTP route under which the bundle is mounted. */
  readonly runtimePath: string;
  /** Absolute path of the built bundle file on disk. */
  readonly runtimeBundleFile: string;
  /** Structured logger for the missing-bundle boot warning. */
  readonly logger: Logger;
}

/**
 * Mount `GET <runtimePath>` onto the express app. Returns nothing —
 * the route self-registers. When the bundle file is missing on disk
 * the mount degrades to a 503 with a build hint.
 */
export function mountRuntimeBundleRoute(opts: MountOptions): void {
  const { app, runtimePath, runtimeBundleFile, logger } = opts;
  if (existsSync(runtimeBundleFile)) {
    app.get(runtimePath, (_req, res) => {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      // Short cache — operators iterating on the renderer want
      // fresh copies after rebuild. Production hardening (etag,
      // long-term caching with hashed filenames) is a follow-on
      // concern; same posture console takes.
      res.setHeader("Cache-Control", "no-cache");
      // CORS: the bundle MUST be loadable from `<script type="module"
      // src=...>` inside a sandboxed `srcdoc` iframe (the
      // `<McpAppIframe>` mount path — see `packages/ggui-react/src/
      // McpAppIframe/dispatch.ts::deriveResourceMountSource`). Such an
      // iframe has the `null` origin and module-script fetches always
      // run in CORS mode; without a permissive header browsers reject
      // the response and the renderer never executes (Lane 1 specs
      // pinning `data-ggui-mcp-app-iframe-lifecycle="code-ready"`
      // hang to timeout). The bundle is public — it ships unmodified
      // to anyone who fetched the page, so `*` is the right shape;
      // there's no auth state on the renderer route to protect via a
      // narrower origin allowlist. This pairs with the production
      // `/ui://ggui/render` shell HTML setting `s.type='module'`
      // (`mcp-apps-outbound.ts::GGUI_RENDER_SHELL_SCRIPT_BODY`).
      res.setHeader("Access-Control-Allow-Origin", "*");
      // `dotfiles: 'allow'` — express@5's `res.sendFile` (send@1.x)
      // splits the FULL absolute path into segments and applies its
      // default `dotfiles: 'ignore'` policy, which 404s any file whose
      // path crosses a dot-prefixed directory segment (e.g. a checkout
      // under `~/.local/...` or a git worktree under `.../.git/...`).
      // `runtimeBundleFile` is a fixed, server-controlled absolute path
      // — never derived from the request — so there is no traversal
      // surface to protect; allow the bundle to serve regardless of
      // where the package install tree happens to live. express@4's
      // `sendFile` did not subject the parent directories to this check.
      res.sendFile(runtimeBundleFile, { dotfiles: "allow" });
    });
  } else {
    logger.warn("renderer_bundle_missing", {
      bundleFile: runtimeBundleFile,
      hint: "Run `pnpm --filter @ggui-ai/iframe-runtime build` to produce the bundle. Serving 503 from the mount point until it exists.",
    });
    app.get(runtimePath, (_req, res) => {
      res
        .status(503)
        .type("text/plain")
        .send("renderer bundle not built. Run:\n  pnpm --filter @ggui-ai/iframe-runtime build\n");
    });
  }
}
