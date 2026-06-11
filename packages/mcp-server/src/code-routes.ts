/**
 * Content-addressable code delivery routes.
 *
 * GET /code/:hash.js — content-addressable componentCode delivery.
 * GET /contract/:hash.js — content-addressable contract-validator-bundle
 *   delivery (#109).
 *
 * Both routes serve from the same {@link CodeStore} keyed by
 * `sha256(bytes)`. The same store is safe to share — content-addressable
 * hashes can't collide across kinds unless the bytes are identical
 * (in which case the cached value is equally valid for either path).
 * Two separate URLs exist for debuggability + protocol clarity: a
 * request to `/code/<hash>.js` is unambiguously a component fetch;
 * `/contract/<hash>.js` is unambiguously a validator-bundle fetch.
 *
 * Cache posture: `Cache-Control: public, max-age=31536000, immutable` —
 * hash is content-derived, the bytes can NEVER change for a given URL,
 * so browsers + CDNs cache forever (immutable means "don't even
 * revalidate"). A second render with the same componentCode / contract
 * hits browser cache for free.
 *
 * CORS: same `*` posture as `/r/:shortCode` (JSON branch) — bytes are
 * public-by-shortCode anyway (the agent already shared the URL with
 * the host), and the bytes carry no credentials.
 *
 * Validation: hash MUST match `[a-f0-9]{64}` — strict charset gate
 * closes path-traversal (`..`, `/`) and other shenanigans before the
 * store sees the parameter.
 */

import type { CodeStore } from "@ggui-ai/mcp-server-core";
import { CODE_HASH_REGEX } from "@ggui-ai/mcp-server-core";
import type { Express, Request, Response } from "express";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Content-addressable store both routes serve from. */
  readonly codeStore: CodeStore;
  /** Structured logger for fetch-failure warnings. */
  readonly logger: Logger;
}

/**
 * Mount `GET /code/:hash.js` + `GET /contract/:hash.js` onto the
 * express app. Returns nothing — the routes self-register.
 */
export function mountCodeRoutes(opts: MountOptions): void {
  const { app, codeStore, logger } = opts;
  const mountContentAddressableRoute = (mountPath: string, label: "code" | "contract"): void => {
    app.get(mountPath, async (req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const hash = req.params["hash"];
      if (typeof hash !== "string" || !CODE_HASH_REGEX.test(hash)) {
        res.setHeader("Cache-Control", "no-store");
        res.status(400).json({
          error: {
            code: "invalid_request",
            message: "hash path parameter must be 64-char lowercase hex",
          },
        });
        return;
      }
      try {
        const code = await codeStore.get(hash);
        if (code === null) {
          res.setHeader("Cache-Control", "no-store");
          res.status(404).json({
            error: {
              code: "not_found",
              message: `unknown ${label} hash`,
            },
          });
          return;
        }
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.status(200).send(code);
      } catch (err) {
        logger.warn(`${label}_route_failed`, { hash, error: String(err) });
        res.setHeader("Cache-Control", "no-store");
        res.status(500).json({
          error: {
            code: "internal",
            message: `${label} fetch failed`,
          },
        });
      }
    });
  };
  mountContentAddressableRoute("/code/:hash.js", "code");
  mountContentAddressableRoute("/contract/:hash.js", "contract");
}
