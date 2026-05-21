/**
 * Reference-adapter tests for `NoopAuditSink` and `InMemoryAuditSink`.
 * The interface contract is self-describing (`audit-sink.ts`); these
 * tests pin the two OSS reference behaviours — silent drop vs.
 * unbounded retain — so downstream consumers can depend on them
 * without re-reading implementation source.
 */
import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../audit-sink.js';
import { InMemoryAuditSink, NoopAuditSink } from './audit-sink.js';

function sampleEntry(action: string, at = 1): AuditEntry {
  return {
    at,
    action,
    actor: { kind: 'builder', id: 'op@example' },
    resource: { kind: 'pairing', id: 'p_abc' },
  };
}

describe('NoopAuditSink', () => {
  it('record resolves without side effect', async () => {
    const sink = new NoopAuditSink();
    await expect(sink.record(sampleEntry('noop.test'))).resolves.toBeUndefined();
  });

  it('record is async — returns a Promise so callers can await uniformly', () => {
    const sink = new NoopAuditSink();
    const maybePromise: unknown = sink.record(sampleEntry('x'));
    expect(maybePromise).toBeInstanceOf(Promise);
  });
});

describe('InMemoryAuditSink — retention contract', () => {
  it('record + snapshot preserves order', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(sampleEntry('one', 1));
    await sink.record(sampleEntry('two', 2));
    await sink.record(sampleEntry('three', 3));
    expect(sink.length).toBe(3);
    expect(sink.snapshot().map((e) => e.action)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('snapshot returns a copy — external mutation does not leak back', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(sampleEntry('a'));
    const copy = sink.snapshot();
    copy.length = 0;
    expect(sink.length).toBe(1);
  });

  it('drain returns entries and empties the buffer', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(sampleEntry('one'));
    await sink.record(sampleEntry('two'));
    const out = sink.drain();
    expect(out.map((e) => e.action)).toEqual(['one', 'two']);
    expect(sink.length).toBe(0);
  });

  it('unbounded by design — no silent drop under volume', async () => {
    const sink = new InMemoryAuditSink();
    for (let i = 0; i < 2000; i++) await sink.record(sampleEntry(`e${i}`, i));
    expect(sink.length).toBe(2000);
  });

  it('preserves metadata verbatim including null-valued fields', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record({
      at: 1,
      action: 'thread.title.changed',
      actor: { kind: 'user', id: 'u1' },
      resource: { kind: 'thread', id: 't1' },
      metadata: { before: 'Old', after: null, byAdmin: true, count: 3 },
    });
    const [entry] = sink.snapshot();
    expect(entry!.metadata).toEqual({
      before: 'Old',
      after: null,
      byAdmin: true,
      count: 3,
    });
  });

  it('accepts the system actor for server-initiated actions', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record({
      at: 1,
      action: 'pairing.token.revoked',
      actor: { kind: 'system' },
      resource: { kind: 'pairing-token', id: 'abc12345' },
    });
    const [entry] = sink.snapshot();
    expect(entry!.actor).toEqual({ kind: 'system' });
  });
});
