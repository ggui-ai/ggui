/**
 * The Plane-2 registry (ggui#880) — the ONLY list of domain-error slugs.
 *
 * SPEC §7.9 Plane 2 promised "the `code` field on each class is the wire
 * literal" while the SDK ships a thrown error as prose only; the slug now
 * LEADS `content[0].text` (`<code>: <detail>`), composed by the
 * `DomainError` base from a code in this registry. These pins keep the
 * registry closed, snake_case, disjoint from the refusal registry (a reader
 * branches on `text.startsWith(code + ': ')` — one code, one plane), and
 * bound to the data-plane tools that emit it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODES,
  DOMAIN_ERROR_RECOVERIES,
  DOMAIN_ERROR_REGISTRY,
  isDomainErrorCode,
  type DomainErrorCode,
} from '../domain-error-codes';
import { PRE_GENERATION_REFUSAL_CODES } from '../refusal-codes';

/** The data-plane `tools/call` surfaces a Plane-2 slug may name. */
const DATA_PLANE_TOOLS = [
  'ggui_handshake',
  'ggui_render',
  'ggui_consume',
  'ggui_get_session',
  'ggui_get_render_source',
  'ggui_update',
  'ggui_amend',
  'ggui_emit',
  'ggui_runtime_pull',
] as const;

/** The rows the ruling on ggui#880 named — one state, one code. */
const RULED: readonly DomainErrorCode[] = [
  'session_not_found',
  'handshake_not_found',
  'contract_violation',
  'schema_mismatch_error',
  'contract_validation_failed',
  'override_contract_invalid',
  'channel_not_declared',
  'invalid_complete',
  'gadget_not_registered',
  'gadget_package_mismatch',
  'gadget_public_env_missing',
  'duplicate_gadget_hook',
  'gadget_types_fetch_failed',
  'gadget_catalog_integrity',
  'blueprint_rejected',
];

describe('DOMAIN_ERROR_CODES — the closed Plane-2 registry (ggui#880)', () => {
  it('is exactly the ruled set, each code equal to its key', () => {
    expect([...DOMAIN_ERROR_CODES].sort()).toEqual([...RULED].sort());
    for (const code of DOMAIN_ERROR_CODES) {
      expect(DOMAIN_ERROR_REGISTRY[code].code).toBe(code);
    }
  });

  it('every code is a snake_case slug — the grammar a reader branches on', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    }
  });

  it('is disjoint from the refusal registry — one code names one plane', () => {
    const refusals = new Set<string>(Object.keys(PRE_GENERATION_REFUSAL_CODES));
    for (const code of DOMAIN_ERROR_CODES) {
      expect(refusals.has(code), code).toBe(false);
    }
  });

  it('every row names at least one data-plane tool that emits it, and a recovery class', () => {
    const tools = new Set<string>(DATA_PLANE_TOOLS);
    for (const code of DOMAIN_ERROR_CODES) {
      const row = DOMAIN_ERROR_REGISTRY[code];
      expect(row.tools.length, code).toBeGreaterThan(0);
      for (const tool of row.tools) expect(tools.has(tool), `${code} → ${tool}`).toBe(true);
      expect(DOMAIN_ERROR_RECOVERIES).toContain(row.recovery);
      expect(row.emitter.length, code).toBeGreaterThan(0);
      expect(row.description.length, code).toBeGreaterThan(0);
    }
  });

  it('recovery classes are the three the SPEC names — same id, re-mint, or time', () => {
    expect(DOMAIN_ERROR_RECOVERIES).toEqual(['retry-same-id', 're-mint', 'later']);
    expect(DOMAIN_ERROR_REGISTRY.session_not_found.recovery).toBe('re-mint');
    expect(DOMAIN_ERROR_REGISTRY.handshake_not_found.recovery).toBe('re-mint');
    expect(DOMAIN_ERROR_REGISTRY.contract_violation.recovery).toBe('retry-same-id');
    expect(DOMAIN_ERROR_REGISTRY.gadget_types_fetch_failed.recovery).toBe('later');
  });

  it('isDomainErrorCode narrows a string to the registry and nothing else', () => {
    expect(isDomainErrorCode('session_not_found')).toBe(true);
    expect(isDomainErrorCode('MCP error -32602')).toBe(false);
    expect(isDomainErrorCode('ggui_render')).toBe(false);
    expect(isDomainErrorCode('app_policy_missing')).toBe(false);
    expect(isDomainErrorCode('')).toBe(false);
  });
});

/**
 * SPEC §7.9's Plane-2 table is this registry's MIRROR — the human-readable
 * statement of the same closed set. Read from the repo (this pin lives
 * here, where the invariant is owned; the kit ships only `dist`).
 */
const SPEC_FILE = fileURLToPath(new URL('../../../../../../docs/protocol/SPEC.md', import.meta.url));

function specPlaneTwoCodes(): string[] {
  const spec = readFileSync(SPEC_FILE, 'utf8');
  const start = spec.indexOf('**Plane 2 —');
  const end = spec.indexOf('**Plane 3 —', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const codes: string[] = [];
  for (const line of spec.slice(start, end).split('\n')) {
    const match = /^\| `([a-z][a-z0-9_]*)`\s+\|/.exec(line);
    if (match?.[1] !== undefined) codes.push(match[1]);
  }
  return codes;
}

describe('SPEC §7.9 Plane-2 table — the registry mirror (ggui#880)', () => {
  it('lists exactly the registered codes, each once', () => {
    const listed = specPlaneTwoCodes();
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...DOMAIN_ERROR_CODES].sort());
  });
});
