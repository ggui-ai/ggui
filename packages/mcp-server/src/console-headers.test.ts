/**
 * Unit tests for `console-headers.ts`.
 *
 * The header string is user-facing (operators inspect responses with
 * curl / devtools) and enforcement-bearing (CSP directly gates what
 * the browser will execute). Both aspects are easy to regress silently
 * — a typo in a directive, a reordered entry that confuses tooling,
 * or a forgotten helper call in the server wiring. These tests pin
 * the exact shape.
 *
 * The WIRING tests (the server calling `applyDevtoolSecurityHeaders`
 * on each response path) live in `console.test.ts` alongside the
 * other route tests.
 */
import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import {
  DEVTOOL_CSP,
  DEVTOOL_SECURITY_HEADERS,
  applyDevtoolSecurityHeaders,
} from './console-headers.js';
import { GGUI_SESSION_SHELL_SCRIPT_HASH } from './mcp-apps-outbound.js';

describe('DEVTOOL_CSP', () => {
  it('contains the load-bearing directives in the locked shape', () => {
    // If you're here because a test failed, the CSP string changed —
    // verify the change is intentional and update
    // `docs/plans/2026-04-20-core-server-console-mvp.md` §8.4 so
    // the design note and implementation stay in sync.
    expect(DEVTOOL_CSP).toBe(
      "default-src 'none'; " +
        `script-src 'self' blob: data: ${GGUI_SESSION_SHELL_SCRIPT_HASH}; ` +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "connect-src 'self'; " +
        "img-src 'self' data:; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "frame-ancestors 'none'; " +
        "base-uri 'none'; " +
        "form-action 'self'",
    );
  });

  it('script-src embeds the production thin-shell sha-256 hash so srcdoc iframes can execute the shell bootstrap', () => {
    // Reading B (`docs/principles/renderer-as-portable-runtime.md` §6.2)
    // mounts the shell via `srcdoc` from inside `<McpAppIframe>`. The
    // `about:srcdoc` iframe inherits the parent console SPA's CSP. The
    // shell's inline `<script>` block executes ONLY when the parent's
    // `script-src` lists a matching source expression — `'unsafe-inline'`
    // is forbidden, so we authorise the exact bytes by hash.
    //
    // If `GGUI_SESSION_SHELL_SCRIPT_HASH` changes (its companion drift
    // test in `mcp-apps-outbound.test.ts` will catch a stale value),
    // this assertion follows because the hash is interpolated.
    const scriptPart = DEVTOOL_CSP
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src '));
    expect(scriptPart).toBeDefined();
    expect(scriptPart).toContain(GGUI_SESSION_SHELL_SCRIPT_HASH);
    expect(GGUI_SESSION_SHELL_SCRIPT_HASH).toMatch(
      /^'sha256-[A-Za-z0-9+/]+=*'$/,
    );
  });

  it('permits `blob:` and `data:` in script-src for the Slice 3/4 renderer path', () => {
    // The generated-componentCode mount path needs TWO script sources:
    //   1. `blob:` — the outer `loadModule` call wraps compiled ESM
    //      in a Blob and `import()`s the object URL.
    //   2. `data:` — bare-specifier imports inside the generated
    //      module (e.g., `import React from 'react'`) are rewritten
    //      to `data:text/javascript,…` shims by
    //      `@ggui-ai/design/rendering/rewrite-imports.ts`.
    // Stripping either silently breaks every generated UI in a real
    // browser (jsdom doesn't enforce CSP; the live-generation
    // browser spec is the only test that catches regressions here).
    const scriptPart = DEVTOOL_CSP
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src '));
    expect(scriptPart).toBeDefined();
    expect(scriptPart).toMatch(/(^|\s)blob:($|\s)/);
    expect(scriptPart).toMatch(/(^|\s)data:($|\s)/);
  });

  it('denies the dangerous directives by omission or explicit lock', () => {
    // Rather than asserting "not present," assert that the key
    // security-critical axes are explicitly locked to the narrowest
    // value. This catches the regression "someone widened
    // frame-ancestors to 'self' accidentally."
    expect(DEVTOOL_CSP).toMatch(/frame-ancestors 'none'/);
    expect(DEVTOOL_CSP).toMatch(/object-src|default-src 'none'/); // default-src covers object-src
    expect(DEVTOOL_CSP).toMatch(/base-uri 'none'/);
  });

  it('does NOT allow unsafe-inline scripts', () => {
    // Specifically script-src — `'unsafe-inline'` is permitted for
    // style-src (React inline styles) but NEVER for scripts. Catch a
    // copy-paste regression that widens scripts by mistake.
    const scriptPart = DEVTOOL_CSP
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src '));
    expect(scriptPart).toBeDefined();
    expect(scriptPart).not.toMatch(/unsafe-inline/);
    expect(scriptPart).not.toMatch(/unsafe-eval/);
  });
});

describe('DEVTOOL_SECURITY_HEADERS', () => {
  it('enumerates every header we emit', () => {
    const names = DEVTOOL_SECURITY_HEADERS.map(([n]) => n);
    expect(names).toEqual([
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Cross-Origin-Opener-Policy',
    ]);
  });

  it('X-Frame-Options is DENY (clickjacking lock alongside CSP frame-ancestors)', () => {
    const entry = DEVTOOL_SECURITY_HEADERS.find(
      ([n]) => n === 'X-Frame-Options',
    );
    expect(entry?.[1]).toBe('DENY');
  });

  it('X-Content-Type-Options is nosniff (MIME confusion lock)', () => {
    const entry = DEVTOOL_SECURITY_HEADERS.find(
      ([n]) => n === 'X-Content-Type-Options',
    );
    expect(entry?.[1]).toBe('nosniff');
  });

  it('Referrer-Policy limits cross-origin referrer leakage', () => {
    const entry = DEVTOOL_SECURITY_HEADERS.find(
      ([n]) => n === 'Referrer-Policy',
    );
    expect(entry?.[1]).toBe('strict-origin-when-cross-origin');
  });
});

describe('applyDevtoolSecurityHeaders', () => {
  function makeFakeRes(): { calls: Array<[string, string]>; setHeader: ServerResponse['setHeader'] } {
    const calls: Array<[string, string]> = [];
    const setHeader: ServerResponse['setHeader'] = (name, value) => {
      calls.push([String(name), String(value)]);
      return undefined as unknown as ServerResponse;
    };
    return { calls, setHeader };
  }

  it('sets every header from the locked list', () => {
    const fake = makeFakeRes();
    applyDevtoolSecurityHeaders({
      setHeader: fake.setHeader,
    } as unknown as ServerResponse);
    expect(fake.calls).toEqual(
      DEVTOOL_SECURITY_HEADERS.map(([n, v]) => [n, v]),
    );
  });

  it('is idempotent — calling twice overwrites with the same values', () => {
    const fake = makeFakeRes();
    const res = {
      setHeader: fake.setHeader,
    } as unknown as ServerResponse;
    applyDevtoolSecurityHeaders(res);
    applyDevtoolSecurityHeaders(res);
    expect(fake.calls.length).toBe(DEVTOOL_SECURITY_HEADERS.length * 2);
  });
});
