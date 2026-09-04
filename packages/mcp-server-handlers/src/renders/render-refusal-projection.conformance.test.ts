/**
 * Drift-catch: the SHIPPING pre-generation-refusal projection ↔ the
 * `@ggui-ai/protocol-conformance` refusal-envelope catalog (ggui#786).
 *
 * Sibling to `resolve-gadget-urls.conformance.test.ts` and
 * `assert-gadgets.conformance.test.ts` — same shape, same reason.
 *
 * The kit's own meta-test grades a faithful in-test projector built
 * from SPEC §7.1 plus `@ggui-ai/protocol` primitives. That proves the
 * catalog is satisfiable while keeping the vendor-neutral kit free of
 * any dependency on a server implementation.
 *
 * THIS test closes the other half: it drives the REAL `ggui_render`
 * handler with a gate that returns each catalog refusal, and grades
 * what the handler actually projects. Without it the catalog would
 * grade only its own reference — a silent gate (see
 * docs/principles/no-silent-block.md). If the shipping projection ever
 * drifts — an identity field leaking onto the refused envelope, `_meta`
 * appearing, the text stopping leading with the code, or a code from a
 * non-render surface becoming projectable — the failure surfaces HERE.
 */
import {
  refusalEnvelopeCases,
  runRefusalEnvelopeConformance,
  type PreGenerationRefusalInput,
  type ProjectedRefusalResult,
} from '@ggui-ai/protocol-conformance/refusal-envelope-conformance';
import {
  refusedOutputSchema,
  renderRefusalSchema,
} from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { beforeAll, describe, expect, it } from 'vitest';

import { createGguiRenderHandler } from './render.js';
import { isHandlerFailure, type HandlerContext } from '../types.js';

const CTX: HandlerContext = { appId: 'app-conformance', requestId: 'r-conf' };

/**
 * The identity fields a committed render reports. A refusal commits
 * nothing, so finding any of these on the projected envelope is the
 * regression the catalog exists to guard.
 */
const IDENTITY_FIELDS = [
  'sessionId',
  'resourceUri',
  'action',
  'contractHash',
  'blueprintId',
  'variantKey',
  'cache',
] as const;

/**
 * Drive the real handler once for `input` and report what it projected,
 * or `null` when the code has no render envelope at all.
 *
 * The `null` arm is NOT a special case in the handler — it falls out of
 * the wire schema: `renderRefusalSchema.code` is the closed render-gate
 * subset of the registry, so a code whose surfaces exclude the render
 * gate cannot even be constructed as a refusal on this surface. That
 * parse is also what keeps this test cast-free.
 */
async function projectThroughHandler(
  input: PreGenerationRefusalInput,
): Promise<ProjectedRefusalResult | null> {
  const parsedRefusal = renderRefusalSchema.safeParse(input);
  if (!parsedRefusal.success) return null;

  const handler = createGguiRenderHandler({
    renderStore: new InMemoryGguiSessionStore(),
    preValidationGate: () => parsedRefusal.data,
  });
  // Deliberately malformed input, dispatched IN-PROCESS — not over the
  // wire, where the SDK's declared-shape validation would reject `{}`
  // before any handler ran. The projection runs before the HANDLER's own
  // parse, so this call must still produce the envelope: the claim under
  // test is "nothing read, nothing committed", not "nothing validated".
  const out = await handler.handler({}, CTX);
  if (!isHandlerFailure(out)) {
    throw new Error('the shipping handler did not project a refusal envelope');
  }
  const structuredContent = refusedOutputSchema.parse(out.data);
  const meta = await handler.resultMeta?.(out, {}, CTX);
  const present: string[] = IDENTITY_FIELDS.filter((field) => field in out.data);
  return {
    isError: true,
    text: out.errorText,
    structuredContent,
    hasMeta: meta !== undefined,
    identityFields: present,
  };
}

describe('ggui_render refusal projection — protocol-conformance catalog', () => {
  /**
   * The kit's runner is synchronous (a projection is a pure function of
   * the refusal); the handler is async. So every case is driven once up
   * front and the runner reads the memoized results.
   */
  const projections = new Map<string, ProjectedRefusalResult | null>();

  beforeAll(async () => {
    for (const testCase of refusalEnvelopeCases) {
      projections.set(testCase.name, await projectThroughHandler(testCase.refusal));
    }
  });

  it('the SHIPPING projection passes every catalog case', () => {
    const byCode = new Map<string, ProjectedRefusalResult | null>();
    for (const testCase of refusalEnvelopeCases) {
      byCode.set(testCase.refusal.code, projections.get(testCase.name) ?? null);
    }
    const result = runRefusalEnvelopeConformance(
      (refusal) => byCode.get(refusal.code) ?? null,
    );
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(refusalEnvelopeCases.length);
  });
});
