/**
 * Smoke tests for the `./server` export. Full wiring is exercised in
 * `@ggui-ai/mcp-server`'s `console.test.ts`; this file keeps the
 * contract of this module narrow and explicit so consumers know what
 * shape to rely on.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { CONSOLE_DIST_DIR } from './server.js';

describe('CONSOLE_DIST_DIR', () => {
  it('is an absolute filesystem path', () => {
    expect(path.isAbsolute(CONSOLE_DIST_DIR)).toBe(true);
  });

  it('points at a directory named `dist` under the package root', () => {
    expect(path.basename(CONSOLE_DIST_DIR)).toBe('dist');
    // One level up must be the package root (the directory that
    // owns package.json). We don't statSync that file here — the
    // wiring test in mcp-server does that against a built dist —
    // but the path shape is what consumers compose against.
    expect(path.basename(path.dirname(CONSOLE_DIST_DIR))).toBe(
      'console',
    );
  });
});
