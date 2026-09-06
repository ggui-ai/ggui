/**
 * The `domain-error` catalog (ggui#880) — the kit's first `tools/call`
 * driver. SPEC §7.9 Plane 2: a domain failure is a tool RESULT with
 * `isError: true` whose `content[0].text` LEADS with the registered slug
 * (`<code>: <detail>`), no `structuredContent`, no `_meta`. Today's servers
 * ship the prose without the slug — the case that fails on `slug-leads` is
 * the receipt this catalog exists for.
 */
import { DOMAIN_ERROR_CODES, DOMAIN_ERROR_REGISTRY, isDomainErrorCode } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';
import {
  domainErrorCases,
  isRawToolCallResult,
  runDomainErrorConformance,
  type RawToolCallResult,
  type ToolCallDriver,
  type ToolCallScenario,
} from './index.js';

/** A spec-correct server: the slug leads the text, nothing else rides. */
const specCorrect: ToolCallDriver = (scenario: ToolCallScenario): RawToolCallResult => {
  const expected = domainErrorCases.find((c) => c.name === nameOf(scenario));
  return {
    isError: true,
    content: [{ type: 'text', text: `${expected?.expect.code ?? 'unknown'}: ${scenario.tool} refused the input — detail` }],
  };
};

/** Today's wire (executed on the built server, ggui#880): prose, no slug. */
const proseOnly: ToolCallDriver = (scenario) => ({
  isError: true,
  content: [{ type: 'text', text: `${scenario.tool}: id "${String(scenario.args['sessionId'] ?? scenario.args['handshakeId'])}" not found. Recovery: re-handshake.` }],
});

function nameOf(scenario: ToolCallScenario): string {
  const hit = domainErrorCases.find(
    (c) => c.scenario.tool === scenario.tool && JSON.stringify(c.scenario.args) === JSON.stringify(scenario.args),
  );
  return hit?.name ?? '';
}

describe('domainErrorCases — the catalog', () => {
  it('has six no-setup cases with unique names, each expecting a registered code on a tool that emits it', () => {
    expect(domainErrorCases.length).toBe(6);
    expect(new Set(domainErrorCases.map((c) => c.name)).size).toBe(6);
    for (const c of domainErrorCases) {
      expect(isDomainErrorCode(c.expect.code), c.name).toBe(true);
      const code = c.expect.code;
      if (!isDomainErrorCode(code)) throw new Error('unreachable');
      expect(DOMAIN_ERROR_REGISTRY[code].tools, `${c.name}: ${c.scenario.tool} emits ${code}`).toContain(c.scenario.tool);
      expect(c.description.length).toBeGreaterThan(0);
    }
    expect(DOMAIN_ERROR_CODES).toContain('session_not_found');
  });

  it('covers the two identity codes across every session-scoped tool the catalog can reach without setup', () => {
    const byCode = new Map<string, string[]>();
    for (const c of domainErrorCases) byCode.set(c.expect.code, [...(byCode.get(c.expect.code) ?? []), c.scenario.tool]);
    expect(byCode.get('handshake_not_found')).toEqual(['ggui_render']);
    expect(new Set(byCode.get('session_not_found'))).toEqual(
      new Set(['ggui_consume', 'ggui_get_session', 'ggui_update', 'ggui_amend', 'ggui_emit']),
    );
  });
});

describe('runDomainErrorConformance — grading the raw result', () => {
  it('passes every case for a spec-correct driver', async () => {
    const r = await runDomainErrorConformance(specCorrect);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.passed.length).toBe(6);
  });

  it("fails every case on `slug-leads` for today's prose-only wire — the receipt", async () => {
    const r = await runDomainErrorConformance(proseOnly);
    expect(r.passed).toEqual([]);
    expect(r.failed.length).toBe(6);
    for (const f of r.failed) expect(f.criterion).toBe('slug-leads');
    expect(String(r.failed[0]?.expected)).toMatch(/^[a-z_]+: /);
  });

  it('names the criterion that failed first: isError, content-text, no-structuredContent, no-meta', async () => {
    const base = (s: ToolCallScenario): RawToolCallResult => specCorrect(s) as RawToolCallResult;
    const notError = await runDomainErrorConformance((s) => ({ ...base(s), isError: false }));
    expect(notError.failed.map((f) => f.criterion)).toEqual(Array<string>(6).fill('isError'));
    const noText = await runDomainErrorConformance((s) => ({ ...base(s), content: [{ type: 'image' }] }));
    expect(noText.failed.map((f) => f.criterion)).toEqual(Array<string>(6).fill('content-text'));
    const structured = await runDomainErrorConformance((s) => ({ ...base(s), structuredContent: { outcome: 'rejected' } }));
    expect(structured.failed.map((f) => f.criterion)).toEqual(Array<string>(6).fill('no-structuredContent'));
    const meta = await runDomainErrorConformance((s) => ({ ...base(s), _meta: { x: 1 } }));
    expect(meta.failed.map((f) => f.criterion)).toEqual(Array<string>(6).fill('no-meta'));
  });

  it('skips a case, naming the tool, when the driver returns null (tool not bound)', async () => {
    const r = await runDomainErrorConformance((s) => (s.tool === 'ggui_emit' ? null : specCorrect(s)));
    expect(r.passed.length).toBe(5);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]?.reason).toContain('ggui_emit');
  });

  it('grades a throwing driver as a FAIL on that case only and keeps grading the rest', async () => {
    const r = await runDomainErrorConformance((s) => {
      if (s.tool === 'ggui_render') throw new Error('boom');
      return specCorrect(s);
    });
    expect(r.failed.length).toBe(1);
    expect(r.failed[0]?.criterion).toBe('driver-threw');
    expect(String(r.failed[0]?.actual)).toContain('boom');
    expect(r.passed.length).toBe(5);
  });

  it('accepts an async driver — a live tools/call is the intended binding', async () => {
    const r = await runDomainErrorConformance(async (s) => specCorrect(s));
    expect(r.passed.length).toBe(6);
  });
});

describe('isRawToolCallResult — the external-boundary guard', () => {
  it('accepts the SDK result shape and rejects the rest', () => {
    expect(isRawToolCallResult({ isError: true, content: [{ type: 'text', text: 'x' }] })).toBe(true);
    expect(isRawToolCallResult({ content: [] })).toBe(true);
    expect(isRawToolCallResult({ isError: true })).toBe(false);
    expect(isRawToolCallResult({ content: 'text' })).toBe(false);
    expect(isRawToolCallResult(null)).toBe(false);
  });
});
