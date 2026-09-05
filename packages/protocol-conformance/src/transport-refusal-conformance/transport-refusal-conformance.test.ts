/**
 * Transport-refusal conformance catalog — self-test (ggui#825).
 *
 * Grades a deployment's PER-APP ENDPOINT refusal projector: the function
 * that turns a registry refusal into the JSON-RPC error a deprovisioned
 * app answers with, on every request (initialize included). A kit-local
 * reference projector proves the catalog coherent; a deliberately wrong
 * one proves each case discriminates.
 */
import { MCP_ENDPOINT_REFUSAL_CODES } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

import {
  runTransportRefusalConformance,
  transportRefusalCases,
  type ProjectedTransportRefusal,
  type TransportRefusalInput,
} from './index.js';

function referenceProject(refusal: TransportRefusalInput): ProjectedTransportRefusal | null {
  const endpoint: readonly string[] = MCP_ENDPOINT_REFUSAL_CODES;
  if (!endpoint.includes(refusal.code)) return null;
  return {
    httpStatus: 403,
    error: { code: -32000, message: 'Forbidden', data: { refusal } },
  };
}

describe('transport-refusal conformance catalog', () => {
  it('ships 2 cases: the deprovisioned endpoint, and a render-only code that has no transport envelope', () => {
    expect(transportRefusalCases.map((c) => c.name).sort()).toEqual([
      'refuse-deprovisioned-endpoint',
      'refuse-render-only-code',
    ]);
  });

  it('every case carries the load-bearing fields, and only the deprovisioned case projects', () => {
    for (const c of transportRefusalCases) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(Object.keys(c.refusal).sort()).toEqual(['code', 'fix', 'message', 'retry']);
    }
    const projecting = transportRefusalCases.filter((c) => c.expect !== null);
    expect(projecting.map((c) => c.refusal.code)).toEqual(['app_deprovisioned']);
  });

  it('a spec-correct projector passes every case (catalog is coherent)', () => {
    const result = runTransportRefusalConformance(referenceProject);
    expect(result.failed).toEqual([]);
    expect([...result.passed].sort()).toEqual(transportRefusalCases.map((c) => c.name).sort());
  });

  it('a projector that types a render-only code fails exactly that case', () => {
    const overTyping = (refusal: TransportRefusalInput): ProjectedTransportRefusal | null => ({
      httpStatus: 403,
      error: { code: -32000, message: 'Forbidden', data: { refusal } },
    });
    const result = runTransportRefusalConformance(overTyping);
    expect(result.failed.map((f) => f.name)).toEqual(['refuse-render-only-code']);
  });

  it('a projector that drops data (the bare 403) fails the deprovisioned case — the illegibility the catalog exists for', () => {
    const bare = (refusal: TransportRefusalInput): ProjectedTransportRefusal | null => {
      const r = referenceProject(refusal);
      return r === null ? null : { ...r, error: { ...r.error, data: { refusal: { ...refusal, fix: '' } } } };
    };
    const result = runTransportRefusalConformance(bare);
    expect(result.failed.map((f) => f.name)).toEqual(['refuse-deprovisioned-endpoint']);
  });

  it('a projector that changes the transport status or code fails the deprovisioned case', () => {
    const wrongCode = (refusal: TransportRefusalInput): ProjectedTransportRefusal | null => {
      const r = referenceProject(refusal);
      return r === null ? null : { ...r, error: { ...r.error, code: -32001 } };
    };
    expect(runTransportRefusalConformance(wrongCode).failed.map((f) => f.name)).toEqual(['refuse-deprovisioned-endpoint']);
    const wrongStatus = (refusal: TransportRefusalInput): ProjectedTransportRefusal | null => {
      const r = referenceProject(refusal);
      return r === null ? null : { ...r, httpStatus: 401 };
    };
    expect(runTransportRefusalConformance(wrongStatus).failed.map((f) => f.name)).toEqual(['refuse-deprovisioned-endpoint']);
  });
});
