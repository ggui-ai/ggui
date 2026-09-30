import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_LOG_EVENTS,
  CONNECTION_STATUSES,
  RUNTIME_TELEMETRY_KINDS,
} from './runtime-telemetry.js';

const SOURCE = readFileSync(fileURLToPath(new URL('./runtime-telemetry.ts', import.meta.url)), 'utf8');

// ggui#1381 — the vocabulary emitters and doors import from one place.
describe('runtime-telemetry — the kind vocabulary (ggui#1381)', () => {
  it('is PURE-CONST: every import is type-only, and nothing is re-exported from elsewhere', () => {
    // A value import here would pull that module (and its dependencies: zod, ajv…) into every bundle that imports
    // this subpath, including packages that had no dependency at all before it.
    const imports = SOURCE.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((l) => !/^\s*import type\b/.test(l))).toEqual([]);
    expect(SOURCE.split('\n').filter((l) => /^\s*export\s+(\*|\{[^}]*\})\s+from\b/.test(l))).toEqual([]);
    expect(SOURCE).not.toMatch(/\brequire\(/);
    expect(SOURCE).not.toMatch(/\bimport\(/);
  });

  it('names every kind once, and every channel event and connection status as a health kind with no detail', () => {
    const kinds = RUNTIME_TELEMETRY_KINDS.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const e of CHANNEL_LOG_EVENTS) {
      expect(RUNTIME_TELEMETRY_KINDS.find((s) => s.kind === e)).toEqual({ kind: e, batch: 'health', detail: 'none' });
    }
    for (const s of CONNECTION_STATUSES) {
      expect(RUNTIME_TELEMETRY_KINDS.find((k) => k.kind === `status.${s}`)).toEqual({ kind: `status.${s}`, batch: 'health', detail: 'none' });
    }
    expect(new Set(CHANNEL_LOG_EVENTS).size).toBe(CHANNEL_LOG_EVENTS.length);
  });

  it('keeps free text off the health batch: a health kind admits none, an id or booleans, never fields', () => {
    for (const s of RUNTIME_TELEMETRY_KINDS) {
      if (s.batch === 'health') expect(['none', 'id', 'booleans'], s.kind).toContain(s.detail);
      else expect(['none', 'fields'], s.kind).toContain(s.detail);
    }
    expect(RUNTIME_TELEMETRY_KINDS.find((s) => s.kind === 'doorbell.ring')).toEqual({ kind: 'doorbell.ring', batch: 'health', detail: 'id' });
  });
});
