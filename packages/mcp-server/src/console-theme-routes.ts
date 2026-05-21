/**
 * Console theme picker routes — `GET /ggui/console/theme` +
 * `POST /ggui/console/theme`.
 *
 * Shape:
 *
 *   GET /ggui/console/theme
 *     → 200 {
 *         presets: ThemeEntry[],   // from @ggui-ai/design#listThemes()
 *         current: ThemeConfig | null,  // ggui.json#theme as parsed
 *         writerEnabled: boolean,  // POST availability
 *       }
 *
 *   POST /ggui/console/theme
 *     body: ThemeConfig | null     // null = clear field, fall back to default
 *     → 200 { ok: true }
 *     → 400 { error: 'invalid_config', issue }    — schema rejected
 *     → 501 { error: 'writer_not_configured' }    — opts.themeWriter omitted
 *     → 500 { error: 'write_failed', message }    — writer threw
 *
 * Authentication: piggy-backs on the same admin gate the LLM-keys
 * routes use — operator-only since the value persists to ggui.json,
 * which the OSS server treats as trusted manifest input. End-users
 * who paired into a session don't get to mutate the project's
 * theme. Multi-tenant deployments may relax this in a follow-up by
 * scoping overrides per user (overrides become server state, not
 * file state).
 */

import type { Express, Request, Response } from 'express';
import {
  ThemeConfigSchema,
  safeParseThemeDocument,
  type ThemeConfig,
} from '@ggui-ai/project-config';
import { applyDevtoolSecurityHeaders } from './console-headers.js';

/**
 * Persists a theme selection back to disk. The mcp-server never
 * touches the filesystem itself — `@ggui-ai/cli` provides the
 * implementation that knows where `ggui.json` lives.
 *
 * `null` clears the field and falls the manifest back to the
 * default-theme branch on next boot.
 */
export type ThemeWriter = (config: ThemeConfig | null) => Promise<void>;

/**
 * Writes an uploaded DTCG theme document next to `ggui.json` under the
 * caller-supplied filename. Atomic + scoped to the project directory —
 * the implementation rejects any filename containing path separators.
 *
 * Pairs with {@link ThemeWriter}: after a successful upload, the route
 * calls `themeWriter({ file: './<filename>', mode })` so the manifest
 * points at the freshly-saved file.
 */
export type ThemeFileUploader = (
  filename: string,
  content: unknown,
) => Promise<void>;

/**
 * Filename gate for `POST /ggui/console/theme/upload`. Operators upload
 * arbitrary names; we constrain to a small alphabet that can't escape
 * the project directory or shadow tooling files.
 */
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]+\.json$/;
const FORBIDDEN_FILENAMES = new Set(['ggui.json', 'package.json']);

interface MountOptions {
  /**
   * Express app to mount onto. The same app the rest of the console
   * routes mount against.
   */
  app: Express;
  /**
   * Current resolved theme selection — what's parsed from ggui.json
   * at boot. `null` when the manifest had no `theme` field. Read-only
   * snapshot; subsequent picker GETs reflect what the operator saved
   * via POST since the snapshot was taken (handled internally).
   */
  initialConfig: ThemeConfig | null;
  /**
   * Optional persister — mounted only when present. When omitted,
   * POST returns 501 so the picker UI can surface a "read-only"
   * banner instead of silently failing.
   */
  themeWriter?: ThemeWriter;
  /**
   * Optional file uploader — mounted only when present alongside
   * `themeWriter`. When omitted, `POST /ggui/console/theme/upload`
   * returns 501 and the picker hides its "Upload theme.json" affordance.
   */
  themeFileUploader?: ThemeFileUploader;
  /**
   * Auth gate — same callable the LLM-keys routes use. Returns
   * `true` when the request carries a valid admin bearer/cookie.
   */
  requestHasAdminAuth: (req: Request) => boolean;
  /**
   * Optional change notifier — fires every time the operator's
   * theme selection changes through `POST /ggui/console/theme` (or
   * the `/upload` variant). The CLI uses this to mirror writes into
   * a shared mutable state cell that the push handler's
   * `themeProvider` reads, so a save reaches the next push without
   * a server restart.
   *
   * Fires AFTER the on-disk write succeeds and AFTER the route's
   * own internal cache updates. Errors thrown by the handler are
   * caught and ignored — the route still returns 200 so the picker
   * UI doesn't see a phantom failure for a downstream subscription
   * issue. Operators with strict-observability needs should wire
   * their own logger inside the callback.
   *
   * Optional: omitting this preserves the legacy per-restart
   * behaviour (POST writes ggui.json; running server stays on the
   * boot-baked theme until restart).
   */
  onConfigChange?: (next: ThemeConfig | null) => void;
}

/**
 * Mount `GET /ggui/console/theme` + `POST /ggui/console/theme` onto
 * the express app. Returns nothing — the routes self-register.
 *
 * The current-config state is held in-process (mutable closure) so
 * subsequent GETs reflect the latest POST without re-reading
 * ggui.json. Writes are durable via the supplied `themeWriter`.
 */
export function mountDevtoolThemeRoutes(opts: MountOptions): void {
  const { app, themeWriter, themeFileUploader, requestHasAdminAuth, onConfigChange } = opts;
  let currentConfig: ThemeConfig | null = opts.initialConfig;
  // Single helper for the two POST paths so the cell update + the
  // change-notifier fire in lockstep. Errors from the notifier are
  // swallowed — the operator's save already landed on disk, so a
  // downstream subscription glitch shouldn't surface as a UI failure.
  const updateConfig = (next: ThemeConfig | null): void => {
    currentConfig = next;
    if (onConfigChange !== undefined) {
      try {
        onConfigChange(next);
      } catch {
        /* observer-side failure is non-load-bearing */
      }
    }
  };
  const writerEnabled = themeWriter !== undefined;
  const uploadEnabled = themeWriter !== undefined && themeFileUploader !== undefined;

  // GET /ggui/console/theme — picker data
  app.get('/ggui/console/theme', (req: Request, res: Response) => {
    applyDevtoolSecurityHeaders(res);
    if (!requestHasAdminAuth(req)) {
      res.status(401).json({ error: 'admin_auth_required' });
      return;
    }
    // The list of registered presets is owned by `@ggui-ai/design`,
    // which the console client imports directly. The server only
    // returns the resolved-from-manifest selection + the writer's
    // posture; the client renders the preset grid from listThemes()
    // on its own.
    res.status(200).json({
      current: currentConfig,
      writerEnabled,
      uploadEnabled,
    });
  });

  // POST /ggui/console/theme — persist a selection
  app.post('/ggui/console/theme', async (req: Request, res: Response) => {
    applyDevtoolSecurityHeaders(res);
    if (!requestHasAdminAuth(req)) {
      res.status(401).json({ error: 'admin_auth_required' });
      return;
    }
    if (themeWriter === undefined) {
      res.status(501).json({
        error: 'writer_not_configured',
        message:
          'Theme writes require the CLI to provide a themeWriter — ' +
          'launch via `ggui serve` (writer is wired) instead of using ' +
          'createGguiServer directly without the option.',
      });
      return;
    }

    // body is `ThemeConfig | null`. Empty body / `null` clears.
    const raw = (req.body ?? null) as unknown;
    let parsed: ThemeConfig | null;
    if (raw === null) {
      parsed = null;
    } else {
      const result = ThemeConfigSchema.safeParse(raw);
      if (!result.success) {
        res.status(400).json({
          error: 'invalid_config',
          issue: result.error.flatten(),
        });
        return;
      }
      parsed = result.data;
    }

    try {
      await themeWriter(parsed);
      updateConfig(parsed);
      res.status(200).json({ ok: true, current: parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'write_failed', message });
    }
  });

  // POST /ggui/console/theme/upload — write a DTCG theme document
  // alongside ggui.json and switch the manifest to point at it.
  //
  // Body shape: { filename: string, content: unknown, mode: 'light' | 'dark' }
  //
  //   - filename is constrained by SAFE_FILENAME_RE — no path
  //     separators, no `ggui.json` / `package.json` collision.
  //   - content is validated via `safeParseThemeDocument` (plain DTCG
  //     v1) so a malformed paste is rejected before hitting disk.
  //   - On success we run `themeFileUploader(filename, content)`
  //     followed by `themeWriter({ file: './<filename>', mode })`,
  //     so a save lands the file AND updates the manifest atomically
  //     from the operator's POV. Partial-failure recovery is the
  //     CLI's responsibility — the seam contract says either both
  //     side-effects land or both throw.
  app.post(
    '/ggui/console/theme/upload',
    async (req: Request, res: Response) => {
      applyDevtoolSecurityHeaders(res);
      if (!requestHasAdminAuth(req)) {
        res.status(401).json({ error: 'admin_auth_required' });
        return;
      }
      if (themeWriter === undefined || themeFileUploader === undefined) {
        res.status(501).json({
          error: 'upload_not_configured',
          message:
            'Theme uploads require both themeWriter and themeFileUploader — ' +
            'launch via `ggui serve` (both are wired) instead of using ' +
            'createGguiServer directly without the options.',
        });
        return;
      }

      const body = (req.body ?? {}) as {
        filename?: unknown;
        content?: unknown;
        mode?: unknown;
      };

      const filename = typeof body.filename === 'string' ? body.filename : '';
      if (!SAFE_FILENAME_RE.test(filename)) {
        res.status(400).json({
          error: 'invalid_filename',
          message:
            'filename must match /^[a-zA-Z0-9._-]+\\.json$/ — no path ' +
            'separators, ends with .json. Got: ' + JSON.stringify(filename),
        });
        return;
      }
      if (FORBIDDEN_FILENAMES.has(filename)) {
        res.status(400).json({
          error: 'forbidden_filename',
          message: `filename "${filename}" would shadow a reserved file.`,
        });
        return;
      }

      const mode = body.mode;
      if (mode !== 'light' && mode !== 'dark') {
        res.status(400).json({
          error: 'invalid_mode',
          message: 'mode must be "light" or "dark".',
        });
        return;
      }

      const docResult = safeParseThemeDocument(body.content);
      if (!docResult.success) {
        res.status(400).json({
          error: 'invalid_content',
          issue: docResult.error.flatten(),
        });
        return;
      }

      try {
        await themeFileUploader(filename, docResult.data);
        const nextConfig: ThemeConfig = { file: `./${filename}`, mode };
        await themeWriter(nextConfig);
        updateConfig(nextConfig);
        res.status(200).json({ ok: true, current: nextConfig });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'write_failed', message });
      }
    },
  );
}
