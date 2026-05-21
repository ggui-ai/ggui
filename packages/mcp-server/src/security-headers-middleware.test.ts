/**
 * Security headers middleware tests — Slice B C5
 * (`docs/plans/2026-05-01-end-user-auth-slices.md`).
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import { createSecurityHeadersMiddleware } from './security-headers-middleware.js';

async function asyncRequest(
  app: express.Express,
  path: string,
): Promise<{
  status: number;
  headers: Record<string, string | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) {
        server.close();
        reject(new Error('listen returned non-info'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url)
        .then(async (res) => {
          await res.text();
          const headers: Record<string, string | undefined> = {};
          res.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
          server.close();
          resolve({ status: res.status, headers });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('createSecurityHeadersMiddleware', () => {
  it('sets the three default security headers on a basic GET response', async () => {
    const app = express();
    app.use(createSecurityHeadersMiddleware());
    app.get('/echo', (_req, res) => res.status(200).end());
    const res = await asyncRequest(app, '/echo');
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not overwrite a header already present on the outbound response', async () => {
    const app = express();
    // Route sets X-Frame-Options BEFORE delegating to the middleware
    // chain (Express 4 runs middleware then handler — so to test
    // "already set" we set it inside the handler before sending; the
    // middleware ran first, so we test the inverse: middleware
    // refuses to set when a previous middleware claimed the header).
    app.use((_req, res, next) => {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      next();
    });
    app.use(createSecurityHeadersMiddleware());
    app.get('/echo', (_req, res) => res.status(200).end());
    const res = await asyncRequest(app, '/echo');
    expect(res.status).toBe(200);
    // Earlier middleware's value preserved.
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    // Other headers still applied.
    expect(res.headers['referrer-policy']).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
