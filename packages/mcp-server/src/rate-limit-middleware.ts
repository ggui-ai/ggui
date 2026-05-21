/**
 * Per-IP rate-limit middleware for `/pair`.
 *
 * Wraps an already-constructed {@link RateLimiter} (policy lives there —
 * limit + window are baked into the adapter at construction time, so
 * swapping a hosted Redis-backed limiter in for the OSS in-memory
 * `FixedWindowRateLimiter` does not change this middleware).
 *
 * Behavior:
 *   - Composes the bucket key as `${quotaKey}:${ip}`. `quotaKey` is
 *     caller-tagged so additional pre-auth surfaces can share the
 *     middleware with isolated quotas.
 *   - Per-IP source: `X-Forwarded-For` (first non-empty hop) when
 *     `trustProxy=true`, else `req.socket.remoteAddress`. Falls back to
 *     `'unknown'` and treats every unidentified peer as a single bucket.
 *   - On denial: 429 + `Retry-After` (seconds, ceiling) + JSON
 *     `{error: {code: 'rate_limited', message, retryAfter}}`.
 *   - On limiter throw: log + `next()` (fail-open). A limiter outage MUST
 *     NOT take down auth endpoints — same posture documented on the
 *     `RateLimiter` seam itself.
 */
import type { Request, RequestHandler } from 'express';
import type { RateLimiter } from '@ggui-ai/mcp-server-core';
import type { Logger } from './logger.js';

export interface PairLoginRateLimitOptions {
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  /** Tag prefix on the bucket key. */
  readonly quotaKey: string;
  /** When true, prefer the first `X-Forwarded-For` hop. Default false. */
  readonly trustProxy?: boolean;
}

/** Extracted so tests can target the IP-resolution path directly if needed. */
export function resolveClientIp(
  req: Pick<Request, 'headers' | 'socket'>,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header === 'string') {
      for (const segment of header.split(',')) {
        const trimmed = segment.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }
  const sock = req.socket.remoteAddress;
  return sock && sock.length > 0 ? sock : 'unknown';
}

export function createPairLoginRateLimitMiddleware(
  opts: PairLoginRateLimitOptions,
): RequestHandler {
  const { limiter, logger, quotaKey, trustProxy = false } = opts;
  return (req, res, next) => {
    const ip = resolveClientIp(req, trustProxy);
    const key = `${quotaKey}:${ip}`;
    limiter
      .check({ key })
      .then((decision) => {
        if (decision.allowed) {
          next();
          return;
        }
        const retryAfterSec = Math.max(
          1,
          Math.ceil((decision.retryAfterMs ?? 0) / 1000),
        );
        logger.info('rate_limit_hit', {
          quotaKey,
          ip,
          remaining: decision.remaining,
          retryAfterSec,
        });
        res
          .status(429)
          .setHeader('Retry-After', String(retryAfterSec))
          .json({
            error: {
              code: 'rate_limited',
              message: `Too many attempts. Try again in ${retryAfterSec} seconds.`,
              retryAfter: retryAfterSec,
            },
          });
      })
      .catch((err: unknown) => {
        // Fail-open: limiter outages must not block auth endpoints.
        logger.error('rate_limit_check_failed', {
          quotaKey,
          ip,
          error: err instanceof Error ? err.message : String(err),
        });
        next();
      });
  };
}
