import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RENDER_FAILURE_ERROR_NAME_PATTERN,
  RENDER_FAILURE_MAX_CATCHES,
  RENDER_FAILURE_MAX_ID_LENGTH,
  RENDER_FAILURE_PHASES,
  renderFailureErrorName,
} from './render-failure.js';
import * as fromTheSchemas from './schemas/mcp.js';

const SOURCE = readFileSync(fileURLToPath(new URL('./render-failure.ts', import.meta.url)), 'utf8');

// ggui#1679 — the runtime emits what the server bounds, from one place, and the place costs a bundle nothing.
describe('@ggui-ai/protocol/render-failure', () => {
  it('is PURE-CONST: no imports at all, nothing re-exported from elsewhere, no require', () => {
    // A value import here would pull that module (and its dependencies: zod, ajv…) into every bundle that imports
    // this subpath; the iframe runtime's bundle budget is exactly what that would spend (+34 KB when these names
    // were imported from the package root).
    expect(SOURCE.split('\n').filter((l) => /^\s*import\b/.test(l))).toEqual([]);
    expect(SOURCE.split('\n').filter((l) => /^\s*export\s+(\*|\{[^}]*\})\s+from\b/.test(l))).toEqual([]);
    expect(SOURCE).not.toMatch(/\brequire\(/);
  });

  it('the package root re-exports the same bindings, so the schema and the runtime cannot drift apart', () => {
    expect(fromTheSchemas.RENDER_FAILURE_PHASES).toBe(RENDER_FAILURE_PHASES);
    expect(fromTheSchemas.RENDER_FAILURE_ERROR_NAME_PATTERN).toBe(RENDER_FAILURE_ERROR_NAME_PATTERN);
    expect(fromTheSchemas.RENDER_FAILURE_MAX_CATCHES).toBe(RENDER_FAILURE_MAX_CATCHES);
    expect(fromTheSchemas.RENDER_FAILURE_MAX_ID_LENGTH).toBe(RENDER_FAILURE_MAX_ID_LENGTH);
    expect(fromTheSchemas.renderFailureErrorName).toBe(renderFailureErrorName);
  });
});
