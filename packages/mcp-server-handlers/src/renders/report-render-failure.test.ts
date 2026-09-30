/**
 * ggui#1609 — `ggui_runtime_report_render_failure`: a card whose render
 * failed tells the server. The server records a report only for the session
 * the call's view proof binds, refuses nothing (every answer is `ok`), and
 * never enqueues a report as an agent turn.
 */
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { GguiSessionStore, ViewProofVerdict } from '@ggui-ai/mcp-server-core';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { reportRenderFailureInputShape } from '@ggui-ai/protocol';
import type { HandlerContext } from '../types.js';
import {
  createGguiReportRenderFailureHandler,
  type CreateGguiReportRenderFailureHandlerDeps,
  type RenderFailureRecord,
} from './report-render-failure.js';

const VALID_PROOF: ViewProofVerdict = {
  verdict: 'valid',
  kid: 'k1',
  src: 'result',
  rootIat: 1,
  rootExp: 2,
  vtime: 3,
  userActivation: false,
  nonce: 'n',
};
const REPORT = { sessionId: 'render_1', appId: 'app-1', phase: 'mount', errorName: 'TypeError', catches: 2 } as const;
const NOW = new Date('2026-09-30T08:00:00.000Z');

async function seededStore(appId = 'app-1'): Promise<GguiSessionStore> {
  const store = new InMemoryGguiSessionStore();
  await store.create({ id: 'render_1', appId });
  return store;
}

function ctx(viewProof?: ViewProofVerdict): HandlerContext {
  return { appId: 'app-1', requestId: 'r', ...(viewProof !== undefined ? { viewProof } : {}) };
}

/** The structured lines the handler printed, parsed back: `[ggui] <event> {json}`. */
function lines(spy: ReturnType<typeof vi.spyOn>, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([first]) => (typeof first === 'string' ? first : ''))
    .filter((l) => l.startsWith(`[ggui] ${event} `))
    .map((l) => JSON.parse(l.slice(`[ggui] ${event} `.length)) as Record<string, unknown>);
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ggui_runtime_report_render_failure (ggui#1609)', () => {
  it('declares an app-only runtime tool whose view proof is required', async () => {
    const h = createGguiReportRenderFailureHandler({ renderStore: await seededStore() });
    expect(h.name).toBe('ggui_runtime_report_render_failure');
    expect(h.audience).toEqual(['runtime']);
    expect(h._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(h.inputSchema).toBe(reportRenderFailureInputShape);
    expect(h.viewProof).toBe('required');
  });

  it('a proven report for the caller\'s own session is recorded once, with exactly its members', async () => {
    const recorded: RenderFailureRecord[] = [];
    const h = createGguiReportRenderFailureHandler({
      renderStore: await seededStore(),
      recordRenderFailure: (r) => void recorded.push(r),
      now: () => NOW,
    });
    await expect(h.handler(REPORT, ctx(VALID_PROOF))).resolves.toEqual({ ok: true });
    expect(recorded).toEqual([{ ...REPORT, receivedAt: NOW.toISOString() }]);
    expect(lines(info, 'render_failed')).toEqual([{ sessionId: 'render_1', appId: 'app-1', phase: 'mount', errorName: 'TypeError', catches: 2 }]);
  });

  it('an unproven report records nothing, names why, carries no session, and still answers ok', async () => {
    const cases: Array<[ViewProofVerdict | undefined, string]> = [
      [undefined, 'unverifiable'],
      [{ verdict: 'missing', reason: 'meta_absent' }, 'missing:meta_absent'],
      [{ verdict: 'invalid', reason: 'session_mismatch' }, 'invalid:session_mismatch'],
    ];
    for (const [proof, reason] of cases) {
      const recorded: RenderFailureRecord[] = [];
      info.mockClear();
      const h = createGguiReportRenderFailureHandler({ renderStore: await seededStore(), recordRenderFailure: (r) => void recorded.push(r) });
      await expect(h.handler(REPORT, ctx(proof))).resolves.toEqual({ ok: true });
      expect(recorded, reason).toEqual([]);
      expect(lines(info, 'render_failure_unproven')).toEqual([{ appId: 'app-1', reason }]);
      expect(lines(info, 'render_failed')).toEqual([]);
    }
  });

  it('a session the caller\'s app does not hold records nothing and answers as a missing one', async () => {
    const recorded: RenderFailureRecord[] = [];
    const h = createGguiReportRenderFailureHandler({ renderStore: await seededStore('another-app'), recordRenderFailure: (r) => void recorded.push(r) });
    await expect(h.handler(REPORT, ctx(VALID_PROOF))).resolves.toEqual({ ok: false, code: 'SESSION_NOT_FOUND' });
    expect(recorded).toEqual([]);
    expect(warn.mock.calls.map(([l]) => String(l)).some((l) => l.includes('runtime_cross_app_refused'))).toBe(true);
  });

  it('a missing session, or a row read that fails, records nothing', async () => {
    const recorded: RenderFailureRecord[] = [];
    const empty = createGguiReportRenderFailureHandler({ renderStore: new InMemoryGguiSessionStore(), recordRenderFailure: (r) => void recorded.push(r) });
    await expect(empty.handler(REPORT, ctx(VALID_PROOF))).resolves.toEqual({ ok: false, code: 'SESSION_NOT_FOUND' });
    const failing = await seededStore();
    failing.get = async () => {
      throw new Error('store down');
    };
    const broken = createGguiReportRenderFailureHandler({ renderStore: failing, recordRenderFailure: (r) => void recorded.push(r) });
    await expect(broken.handler(REPORT, ctx(VALID_PROOF))).resolves.toEqual({ ok: false, code: 'SESSION_NOT_FOUND' });
    expect(recorded).toEqual([]);
  });

  it('a recorder that throws never changes the answer, and is named', async () => {
    const h = createGguiReportRenderFailureHandler({
      renderStore: await seededStore(),
      recordRenderFailure: () => {
        throw new Error('stamp failed');
      },
    });
    await expect(h.handler(REPORT, ctx(VALID_PROOF))).resolves.toEqual({ ok: true });
    expect(lines(warn, 'render_failed_record_failed')).toEqual([{ sessionId: 'render_1', appId: 'app-1', error: 'stamp failed' }]);
  });

  it('never enqueues a turn: its deps carry no pending-event pipe, by construction', () => {
    expectTypeOf<keyof CreateGguiReportRenderFailureHandlerDeps>().toEqualTypeOf<'renderStore' | 'recordRenderFailure' | 'now'>();
  });
});
