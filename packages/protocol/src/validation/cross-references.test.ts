import { describe, it, expect } from 'vitest';
import type { DataContract } from '../types/data-contract';
import {
  CTR_REF_NEXT_STEP,
  CTR_REF_STREAM_SOURCE,
  CrossReferenceError,
  assertCrossReferences,
  checkActionNextStepRefs,
  checkCrossReferences,
  checkStreamSourceRefs,
} from './cross-references';

const stringSchema = { type: 'string' as const };

function withAgentTools(tools: Record<string, unknown> = {}): DataContract {
  return {
    agentCapabilities: {
      tools: Object.fromEntries(
        Object.entries(tools).map(([k]) => [
          k,
          { inputSchema: { type: 'object' as const } },
        ]),
      ),
    },
  };
}

describe('checkActionNextStepRefs', () => {
  it('returns no violations when actionSpec is omitted', () => {
    expect(checkActionNextStepRefs(undefined, { tools: {} })).toEqual([]);
  });

  it('returns no violations when no action entry declares nextStep', () => {
    const violations = checkActionNextStepRefs(
      {
        submit: { label: 'Submit' },
        cancel: { label: 'Cancel' },
      },
      { tools: {} },
    );
    expect(violations).toEqual([]);
  });

  it('returns no violations when every nextStep resolves', () => {
    const violations = checkActionNextStepRefs(
      {
        archive: { label: 'Archive', nextStep: 'archive_email' },
        send: { label: 'Send', nextStep: 'send_email' },
      },
      {
        tools: {
          archive_email: { inputSchema: { type: 'object' as const } },
          send_email: { inputSchema: { type: 'object' as const } },
        },
      },
    );
    expect(violations).toEqual([]);
  });

  it('returns a CTR_REF_NEXT_STEP violation when nextStep names an undeclared tool', () => {
    const violations = checkActionNextStepRefs(
      { archive: { label: 'Archive', nextStep: 'archive_email' } },
      { tools: { send_email: { inputSchema: { type: 'object' as const } } } },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_REF_NEXT_STEP);
    expect(violations[0].field).toBe('actionSpec.archive.nextStep');
    expect(violations[0].received).toBe('archive_email');
    expect(violations[0].message).toContain('archive_email');
    expect(violations[0].message).toContain('send_email');
  });

  it('returns a violation when nextStep is declared but agentCapabilities is absent', () => {
    const violations = checkActionNextStepRefs(
      { archive: { label: 'Archive', nextStep: 'archive_email' } },
      undefined,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_REF_NEXT_STEP);
    expect(violations[0].message).toContain('(none)');
  });

  it('aggregates one violation per unresolved entry', () => {
    const violations = checkActionNextStepRefs(
      {
        archive: { label: 'Archive', nextStep: 'archive_email' },
        send: { label: 'Send', nextStep: 'send_email' },
        ok: { label: 'OK', nextStep: 'noop' },
      },
      { tools: { noop: { inputSchema: { type: 'object' as const } } } },
    );
    expect(violations.map((v) => v.received)).toEqual([
      'archive_email',
      'send_email',
    ]);
  });
});

describe('checkStreamSourceRefs', () => {
  it('returns no violations when streamSpec is omitted', () => {
    expect(checkStreamSourceRefs(undefined, { tools: {} })).toEqual([]);
  });

  it('returns no violations when channels declare no source', () => {
    const violations = checkStreamSourceRefs(
      {
        chat: { schema: stringSchema },
        toast: { schema: stringSchema },
      },
      { tools: {} },
    );
    expect(violations).toEqual([]);
  });

  it('returns no violations when every source.tool resolves', () => {
    const violations = checkStreamSourceRefs(
      {
        ticker: {
          schema: stringSchema,
          source: { tool: 'fetch_ticker' },
        },
        alerts: {
          schema: stringSchema,
          source: { tool: 'list_alerts', args: { limit: 10 } },
        },
      },
      {
        tools: {
          fetch_ticker: { inputSchema: { type: 'object' as const } },
          list_alerts: { inputSchema: { type: 'object' as const } },
        },
      },
    );
    expect(violations).toEqual([]);
  });

  it('returns a CTR_REF_STREAM_SOURCE violation when source.tool is undeclared', () => {
    const violations = checkStreamSourceRefs(
      {
        ticker: {
          schema: stringSchema,
          source: { tool: 'fetch_ticker' },
        },
      },
      { tools: {} },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_REF_STREAM_SOURCE);
    expect(violations[0].field).toBe('streamSpec.ticker.source.tool');
    expect(violations[0].received).toBe('fetch_ticker');
  });

  it('returns a violation when source is declared but agentCapabilities is absent', () => {
    const violations = checkStreamSourceRefs(
      {
        ticker: { schema: stringSchema, source: { tool: 'fetch_ticker' } },
      },
      undefined,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_REF_STREAM_SOURCE);
  });
});

describe('checkCrossReferences (aggregate)', () => {
  it('returns no violations for an empty contract', () => {
    expect(checkCrossReferences({})).toEqual([]);
  });

  it('returns no violations for a contract with no cross-refs', () => {
    const contract: DataContract = {
      actionSpec: {
        submit: { label: 'Submit' },
      },
      streamSpec: {
        toast: { schema: stringSchema },
      },
    };
    expect(checkCrossReferences(contract)).toEqual([]);
  });

  it('aggregates action + stream violations in stable order (action first)', () => {
    const contract: DataContract = {
      actionSpec: {
        archive: { label: 'Archive', nextStep: 'archive_email' },
      },
      streamSpec: {
        ticker: { schema: stringSchema, source: { tool: 'fetch_ticker' } },
      },
      agentCapabilities: { tools: {} },
    };
    const violations = checkCrossReferences(contract);
    expect(violations.map((v) => v.code)).toEqual([
      CTR_REF_NEXT_STEP,
      CTR_REF_STREAM_SOURCE,
    ]);
  });

  it('passes when both refs resolve to the same agentCapabilities.tools key', () => {
    const contract: DataContract = {
      actionSpec: { fetch: { label: 'Fetch', nextStep: 'fetch_ticker' } },
      streamSpec: {
        ticker: { schema: stringSchema, source: { tool: 'fetch_ticker' } },
      },
      agentCapabilities: {
        tools: { fetch_ticker: { inputSchema: { type: 'object' as const } } },
      },
    };
    expect(checkCrossReferences(contract)).toEqual([]);
  });
});

describe('assertCrossReferences', () => {
  it('is a no-op when invariants hold', () => {
    expect(() =>
      assertCrossReferences(withAgentTools({ noop: {} })),
    ).not.toThrow();
  });

  it('throws CrossReferenceError with every violation listed', () => {
    const contract: DataContract = {
      actionSpec: {
        archive: { label: 'Archive', nextStep: 'archive_email' },
        send: { label: 'Send', nextStep: 'send_email' },
      },
      streamSpec: {
        ticker: { schema: stringSchema, source: { tool: 'fetch_ticker' } },
      },
      agentCapabilities: { tools: {} },
    };
    let caught: unknown;
    try {
      assertCrossReferences(contract);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CrossReferenceError);
    const err = caught as CrossReferenceError;
    expect(err.code).toBe('cross_reference_unresolved');
    expect(err.violations).toHaveLength(3);
    expect(err.message).toContain('CTR_REF_NEXT_STEP');
    expect(err.message).toContain('CTR_REF_STREAM_SOURCE');
  });
});
