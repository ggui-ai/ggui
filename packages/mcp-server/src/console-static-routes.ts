/**
 * Console static-bundle + SPA serving routes.
 *
 *   GET <consolePath>            — mode-meta-injected `index.html`,
 *                                  welcome page, or onboarding redirect.
 *   <consolePath>/* (static)     — `express.static` over the package's
 *                                  built `dist/` (HTML + JS + CSS).
 *   GET /admin/* + /devtools/*   — admin-HTML gate (302 to
 *                                  `/admin-login?next=…` on miss).
 *   GET <consolePath>/* (SPA)    — fallback to the rewritten
 *                                  `index.html` so the React router
 *                                  takes over for client-side routes.
 *
 * When the `distDir` doesn't exist on disk (e.g. operator forgot
 * to run `pnpm --filter @ggui-ai/console build`), the static
 * route is replaced with a 503 that points at the missing build —
 * silent 404 would be mistaken for "console is broken" rather
 * than "console wasn't built yet," which is a real debugging
 * trap for self-hosted operators.
 */

import type { Express, Response } from "express";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import { renderWelcomeHtml, type WelcomePageInputs } from "./console-welcome.js";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Mount path for the console (default `/`). */
  readonly consolePath: string;
  /** Built console bundle directory on disk. */
  readonly consoleDistDir: string;
  /** Operator mode stamped into `<meta name="ggui-mode">`. */
  readonly mode: "dev" | "prod";
  /** Server identity name (welcome-page fallback title). */
  readonly serverName: string;
  /** Welcome-page inputs — enables the server-rendered landing. */
  readonly welcomePage?: WelcomePageInputs;
  /** Onboarding redirect resolver (runs before welcome/SPA index). */
  readonly landingRedirect?: () => string | null;
  /**
   * Admin gate for the SPA's `/admin/*` + `/devtools/*` zones. `null`
   * = console disabled / no admin token resolved → gate unmounted.
   */
  readonly requestHasAdminAuth: ((req: express.Request) => boolean) | null;
  /** Structured logger for the missing-dist boot warning. */
  readonly logger: Logger;
}

/**
 * Mount the console static + SPA routes onto the express app.
 * Returns nothing — the routes self-register.
 */
export function mountConsoleStaticRoutes(opts: MountOptions): void {
  const {
    app,
    consolePath,
    consoleDistDir,
    mode,
    serverName,
    welcomePage,
    landingRedirect,
    requestHasAdminAuth,
    logger,
  } = opts;

  if (existsSync(consoleDistDir)) {
    // Read + stamp `<meta name="ggui-mode" content="dev|prod">` into
    // the SPA's `<head>` once at boot. The SPA's `mode.ts` reads the
    // meta synchronously on first paint so `TopNav` renders the
    // `/devtools` link without a `/info` round-trip flicker. Mode
    // changes require a server restart — same shape as every other
    // `CreateGguiServerOptions` field, no live-toggle ceremony.
    const indexPath = path.join(consoleDistDir, "index.html");
    const META_TAG = `<meta name="ggui-mode" content="${mode}">`;
    let indexHtml: string;
    try {
      const raw = readFileSync(indexPath, "utf-8");
      // Inject right after `<head>` so the meta is available before
      // any subsequent `<script>` tag executes. Idempotent: if a
      // previous build somehow already inlined the meta, the
      // injection still produces a valid (duplicate but harmless)
      // tag — `mode.ts` reads the first hit.
      indexHtml = raw.includes("<head>")
        ? raw.replace("<head>", `<head>${META_TAG}`)
        : raw.replace(/^/, `${META_TAG}\n`);
    } catch (err) {
      logger.warn("console_index_read_failed", {
        path: indexPath,
        error: String(err),
      });
      indexHtml = `<!doctype html><html><head>${META_TAG}</head><body></body></html>`;
    }
    const sendConsoleHtml = (res: Response): void => {
      applyDevtoolSecurityHeaders(res);
      res.type("text/html").send(indexHtml);
    };

    // Welcome HTML — server-rendered landing for `consolePath === '/'`
    // when the operator wires `welcomePage`. Identifies who runs
    // the server (operator block; entirely hidden when unset),
    // describes the public deep-link surfaces, and offers the
    // operator-login affordance. No JS, no SPA mount, same security
    // headers as `sendConsoleHtml`.
    const welcomeEnabled = welcomePage !== undefined && consolePath === "/";
    const sendWelcomeHtml =
      welcomeEnabled && welcomePage !== undefined
        ? (res: Response): void => {
            applyDevtoolSecurityHeaders(res);
            res.type("text/html").send(renderWelcomeHtml(welcomePage, serverName));
          }
        : null;

    // Onboarding redirect — must run BEFORE express.static, which
    // would otherwise serve `index.html` for `GET /` directly and
    // never give the SPA fallback (or this redirect) a chance.
    app.get(consolePath, (req, res, next) => {
      // Static middleware fires on the trailing-slash variant when
      // consolePath !== '/'. Both shapes route here.
      if (req.path !== consolePath && req.path !== `${consolePath}/`) {
        return next();
      }
      if (landingRedirect) {
        const target = landingRedirect();
        if (target && target !== req.path) {
          res.redirect(302, target);
          return;
        }
      }
      if (sendWelcomeHtml) {
        sendWelcomeHtml(res);
        return;
      }
      sendConsoleHtml(res);
    });
    app.use(
      consolePath,
      express.static(consoleDistDir, {
        // index:false — explicit handler above owns `/` so the meta
        // tag gets injected. Without this, express.static would
        // race the handler and sometimes serve the raw file.
        index: false,
        // Short cache — operators iterating on their server want
        // fresh copies after a rebuild; production-hardening
        // (etag, long-term caching for /assets/*) is a slice-3 polish
        // concern.
        maxAge: 0,
        fallthrough: true,
        // Attach the console security header set to every
        // static response. `setHeaders` runs for successful hits
        // (HTML + JS + CSS + asset 200s); misses that fall through
        // to the SPA fallback below are covered by the fallback's
        // explicit `applyDevtoolSecurityHeaders` call.
        setHeaders: applyDevtoolSecurityHeaders,
      })
    );
    // Admin-HTML gate. The SPA's `/admin/*` and `/devtools/*` zones
    // are operator-only — without this gate, every admin page is a
    // GET away from anyone who guesses the path. The corresponding
    // JSON APIs already gate at `/ggui/console/keys`, but the SPA
    // shell itself was unauthenticated. Mounted only when the gate
    // shape is available (admin token resolved + closure built).
    //
    // 302 to `/admin-login?next=<encoded-path>` on miss — the login
    // page reads `next` from the query string and bounces back after
    // a successful token paste. No client-side cookie set here; the
    // existing `POST /ggui/console/admin-login` route owns minting.
    //
    // Scope:
    //   - GATED: `/admin/*`, `/devtools/*`
    //   - UNGATED: `/admin-login`, `/s/*`, `/preview/*`, `/` (welcome
    //     when wired, SPA index otherwise)
    //
    // The welcome page (`/`) is intentionally public — it's the
    // operator-identification surface, not an admin tool. Public
    // deep-link surfaces stay reachable: a render viewer URL
    // `/s/<shortCode>` and a blueprint preview URL `/preview/<id>`
    // are how end-users / blueprint authors land on the server.
    if (requestHasAdminAuth !== null) {
      const adminAuth = requestHasAdminAuth;
      app.get(/^\/(admin|devtools)(\/.*)?$/, (req, res, next) => {
        if (req.path === "/admin-login") return next();
        if (adminAuth(req)) return next();
        applyDevtoolSecurityHeaders(res);
        const next_ = encodeURIComponent(req.originalUrl || req.path);
        res.redirect(302, `/admin-login?next=${next_}`);
      });
    }

    // SPA fallback: the console client owns client-side routes
    // (`/`, `/s/<shortCode>`, `/admin/*`, `/devtools/*`). An unknown
    // sub-path under the mount must serve the rewritten
    // `index.html` so the React router takes over.
    //
    // Express 5 / path-to-regexp v8 rejects the bare `'*'` and
    // `'foo/*'` wildcard strings that worked in v6; named splats
    // (`{*splat}`) or RegExp patterns are required. Using RegExp
    // here matches the admin-gate pattern above and avoids the
    // parser-version churn.
    const spaFallbackPattern =
      consolePath === "/"
        ? /^\/.*$/
        : new RegExp(`^${consolePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*$`);
    app.get(spaFallbackPattern, (req, res, next) => {
      // Only fallback for GET of non-asset, non-API paths.
      // `express.static` already served any asset that exists;
      // an `/assets/foo.js` that doesn't exist SHOULD 404 rather
      // than returning HTML.
      if (req.path.startsWith("/ggui/")) return next();
      if (req.path.startsWith(`${consolePath === "/" ? "" : consolePath}/assets/`)) {
        return next();
      }
      sendConsoleHtml(res);
    });
  } else {
    logger.warn("console_dist_missing", {
      distDir: consoleDistDir,
      hint: "Run `pnpm --filter @ggui-ai/console build` to produce the static bundle. Serving 503 from the mount point until the bundle exists.",
    });
    app.use(consolePath, (_req, res) => {
      applyDevtoolSecurityHeaders(res);
      res
        .status(503)
        .type("text/plain")
        .send("console bundle not built. Run:\n  pnpm --filter @ggui-ai/console build\n");
    });
  }
}
