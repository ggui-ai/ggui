/**
 * InMemoryGguiSessionStreamBuffer — the shared conformance suite, plus the
 * behaviour only an in-process buffer has.
 *
 * The port's behaviour (sequencing, the replay policies, truncation,
 * `clear`, `getSize`, reserved channels, epochs) lives in
 * `../contract-tests/ggui-session-stream-buffer.conformance.ts`, which
 * every implementation runs. End-to-end replay over the OSS `/ws` channel
 * lives in `packages/mcp-server`.
 */
import { describe, expect, it } from 'vitest';
import type { StreamSpec } from '@ggui-ai/protocol';
import { runGguiSessionStreamBufferConformance } from '../contract-tests/ggui-session-stream-buffer.conformance.js';
import { InMemoryGguiSessionStreamBuffer } from './ggui-session-stream-buffer.js';

runGguiSessionStreamBufferConformance('InMemoryGguiSessionStreamBuffer', {
  create: (opts) => new InMemoryGguiSessionStreamBuffer(opts),
});

const SESSION = 'sess-1';
const SPEC: StreamSpec = { feed: { schema: { type: 'object' }, replay: 'all' } };
const feed = (n: number) => ({ sessionId: SESSION, channel: 'feed', mode: 'append' as const, payload: { n } });

describe('InMemoryGguiSessionStreamBuffer — constructor guards', () => {
  it('rejects maxPerSession < 1', () => {
    expect(() => new InMemoryGguiSessionStreamBuffer({ maxPerSession: 0 })).toThrow();
    expect(() => new InMemoryGguiSessionStreamBuffer({ maxPerSession: -5 })).toThrow();
  });
});

describe('InMemoryGguiSessionStreamBuffer — epochs live in process memory (ggui#1531)', () => {
  it('mints a 32-hex-character epoch', async () => {
    const buf = new InMemoryGguiSessionStreamBuffer();
    expect((await buf.record(feed(1), SPEC)).envelope.streamEpoch).toMatch(/^[0-9a-f]{32}$/);
  });

  it('another instance (a new process) holds another epoch for the same session, and starts its seq again', async () => {
    const first = new InMemoryGguiSessionStreamBuffer();
    await first.record(feed(1), SPEC);
    const firstEpoch = (await first.record(feed(2), SPEC)).envelope.streamEpoch;
    const second = new InMemoryGguiSessionStreamBuffer();
    const restarted = (await second.record(feed(3), SPEC)).envelope;
    expect(restarted.seq).toBe(1);
    expect(restarted.streamEpoch).not.toBe(firstEpoch);
  });
});
