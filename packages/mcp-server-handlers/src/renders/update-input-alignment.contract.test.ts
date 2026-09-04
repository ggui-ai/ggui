/**
 * Contract alignment: `ggui_update`'s handler ↔ `updateInputSchema`.
 *
 * The protocol export (`@ggui-ai/protocol` `updateInputSchema`, mirrored
 * in SPEC.md §7.1.2) is a STRICT discriminated union with `sessionId`
 * required on both arms. The handler's tool-facing `inputSchema` is a
 * flat non-strict-looking raw shape — MCP tool registration takes a
 * `ZodRawShape`, which cannot express a top-level union — and re-imposes
 * the union semantics imperatively.
 *
 * Nothing bound the two before this file existed, and they drifted for
 * ~8 weeks on the OUTPUT side (`resourceUri`, ggui#385) with only a
 * docstring ("must not drift") standing guard. Per
 * docs/principles/protocol-and-contract-bar.md, an obligation without an
 * observable violation is a failure in disguise — this suite is the
 * mechanism.
 *
 * What it asserts:
 *  1. FIELD PARITY — the flat shape's keys are exactly the union of the
 *     protocol arms' keys. Adding a field to either side alone fails.
 *  2. VERDICT AGREEMENT — for a corpus spanning both arms, every
 *     mixed/missing-field shape, unknown keys, and a bogus kind: the
 *     handler accepts a payload end-to-end iff `updateInputSchema`
 *     accepts it.
 *  3. THE ONE DECLARED CARVE-OUT — `sessionId` omitted on the wire but
 *     threaded via `HandlerContext.sessionId` (in-process dispatch).
 *     Protocol rejects, handler accepts, and that divergence is
 *     asserted HERE as intentional rather than left as an undeclared
 *     loosening.
 *  4. MALFORMED COSTS NOTHING — union narrowing runs before any store
 *     read, so a malformed call burns zero persistence reads (and the
 *     update.ts flow doc's "before tenant work" claim stays true by
 *     test rather than by prose).
 *
 * The one tolerance this file does NOT cover: the MCP SDK transport
 * parses tool args non-strictly and strips unknown keys BEFORE any
 * handler runs, so wire callers get tolerant-reader behavior while the
 * handler itself (and any in-process dispatcher) rejects unknown keys
 * exactly as protocol does. That transport-layer behavior is pinned at
 * the wire level in
 * `oss/e2e/mcp-host-simulator/tests/update-transport-tolerance.contract.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { updateInputSchema, updateOutputSchema } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import {
  createGguiUpdateHandler,
  ContractViolationError,
  GguiSessionNotFoundError,
} from './update';

const APP = 'app-align';
const SESSION = 'render-align-1';
const NOW_MS = Date.parse('2026-07-27T00:00:00.000Z');

async function makeSeededHandler() {
  const store = new InMemoryGguiSessionStore();
  const render: ComponentGguiSession = {
    id: SESSION,
    appId: APP,
    type: 'component',
    componentCode: 'export default function X(){return null}',
    props: { count: 0 },
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await store.commit({ render, appId: APP });
  return { store, handler: createGguiUpdateHandler({ renderStore: store }) };
}

/** Accept = resolves; reject = throws one of the three contract-level
 *  error classes. Anything else thrown is an infrastructure bug and
 *  fails the test loudly rather than counting as a "reject". */
async function handlerVerdict(
  payload: Record<string, unknown>,
  ctx: { appId: string; requestId: string; sessionId?: string },
): Promise<'accept' | 'reject'> {
  const { handler } = await makeSeededHandler();
  try {
    await handler.handler(payload as never, ctx);
    return 'accept';
  } catch (err) {
    const contractual =
      err instanceof ContractViolationError ||
      err instanceof GguiSessionNotFoundError ||
      (err as { name?: string }).name === 'ZodError' ||
      (err as { name?: string }).name === '$ZodError';
    if (!contractual) throw err;
    return 'reject';
  }
}

describe('ggui_update handler ↔ updateInputSchema alignment (ggui#385)', () => {
  it('flat-shape keys are exactly the union of the protocol arms', async () => {
    const { handler } = await makeSeededHandler();
    const flatKeys = Object.keys(handler.inputSchema).sort();
    const armKeys = new Set<string>();
    for (const arm of updateInputSchema.options) {
      for (const k of Object.keys(arm.shape)) armKeys.add(k);
    }
    expect(flatKeys).toEqual([...armKeys].sort());
  });

  /**
   * Every entry: [label, payload]. The expected verdict is COMPUTED from
   * `updateInputSchema`, never hardcoded — so a deliberate protocol-side
   * change flows through, and only handler-side drift fails.
   */
  const corpus: readonly [string, Record<string, unknown>][] = [
    ['replace happy path', { sessionId: SESSION, kind: 'replace', props: { a: 1 } }],
    ['merge happy path', { sessionId: SESSION, kind: 'merge', patch: { a: 1 } }],
    ['replace without props', { sessionId: SESSION, kind: 'replace' }],
    ['merge without patch', { sessionId: SESSION, kind: 'merge' }],
    ['replace carrying patch', { sessionId: SESSION, kind: 'replace', patch: {} }],
    ['replace with both fields', { sessionId: SESSION, kind: 'replace', props: {}, patch: {} }],
    ['merge with both fields', { sessionId: SESSION, kind: 'merge', props: {}, patch: {} }],
    ['merge carrying props', { sessionId: SESSION, kind: 'merge', props: {} }],
    ['unknown key alongside a valid replace', { sessionId: SESSION, kind: 'replace', props: {}, EXTRA: 1 }],
    ['unknown key alongside a valid merge', { sessionId: SESSION, kind: 'merge', patch: {}, EXTRA: 1 }],
    ['bogus kind', { sessionId: SESSION, kind: 'destroy' }],
    ['no sessionId anywhere', { kind: 'merge', patch: {} }],
    ['kind missing entirely', { sessionId: SESSION, props: {} }],
  ];

  for (const [label, payload] of corpus) {
    it(`verdicts agree — ${label}`, async () => {
      const protocolVerdict = updateInputSchema.safeParse(payload).success
        ? 'accept'
        : 'reject';
      const observed = await handlerVerdict(payload, {
        appId: APP,
        requestId: 'r-align',
      });
      expect(observed, `payload: ${JSON.stringify(payload)}`).toBe(
        protocolVerdict,
      );
    });
  }

  it('DECLARED carve-out: ctx.sessionId substitutes for the wire field (in-process dispatch)', async () => {
    const payload = { kind: 'merge', patch: { a: 2 } };
    // Protocol rejects — sessionId is required on the wire.
    expect(updateInputSchema.safeParse(payload).success).toBe(false);
    // Handler accepts when an in-process dispatcher threads the id via
    // HandlerContext. This is the ONE intentional widening of the
    // accepted language; if it ever stops being intentional, delete
    // this test and make sessionId required on the flat shape too.
    const verdict = await handlerVerdict(payload, {
      appId: APP,
      requestId: 'r-align',
      sessionId: SESSION,
    });
    expect(verdict).toBe('accept');
  });

  it('OUTPUT side: handler wire output parses under updateOutputSchema, key-for-key', async () => {
    // The output seam is where the last drift actually happened: the
    // handler started emitting `resourceUri` on 2026-05-28 and the
    // protocol export only caught up on 2026-07-23 (ggui#385) — with
    // nothing but the docstring "must not drift" standing guard for
    // those 8 weeks. This assertion is the missing mechanism: a real
    // end-to-end output must round-trip through the protocol schema
    // with no keys stripped and no keys missing.
    const { handler } = await makeSeededHandler();
    const out = await handler.handler(
      { sessionId: SESSION, kind: 'merge', patch: { a: 1 } } as never,
      { appId: APP, requestId: 'r-align' },
    );
    const parsed = updateOutputSchema.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(out).sort());
    // IDENTITY, not parity (ggui#798): the declared shape IS the
    // protocol schema's `.shape`, the same object. A key-for-key
    // comparison could only ever catch a MISSING or EXTRA field — it
    // was blind to a field whose zod type or `.describe()` string
    // diverged, which is the drift that actually reaches an agent
    // through `tools/list`. There is nothing left to keep in sync.
    expect(handler.outputSchema).toBe(updateOutputSchema.shape);
  });

  it('a malformed payload costs zero store reads', async () => {
    // The store read is the observable: it is the first thing on this
    // path that costs anything (a round trip, and on a hosted
    // deployment a billed one), and it is where tenant scoping starts.
    // Union narrowing has to reject BEFORE it, or a caller who sent
    // `kind:'replace'` with a `patch` has already paid for a lookup
    // that could never have been used.
    const store = new InMemoryGguiSessionStore();
    const getSpy = vi.spyOn(store, 'get');
    const handler = createGguiUpdateHandler({ renderStore: store });

    await expect(
      handler.handler(
        { sessionId: SESSION, kind: 'replace', patch: {} } as never,
        { appId: APP, requestId: 'r-align' },
      ),
    ).rejects.toBeInstanceOf(ContractViolationError);

    expect(getSpy).not.toHaveBeenCalled();
  });
});
