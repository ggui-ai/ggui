import { z } from 'zod';
import { parseAnyLlmRoute } from '../types/llm-route';
import { renderInputShape } from './mcp';

/**
 * The render input ENVELOPE — the registered shape plus the route grammar
 * (ggui#818): `infra.model`, when present, MUST parse as a model route in
 * either wire form (canonical `provider:model` or LiteLLM `provider/model`;
 * aliases resolve in both). The render handler parses this BEFORE its
 * pre-generation gate, so a malformed route is a contract error at zod path
 * `infra.model` — never a policy refusal (`model_not_in_tier` is reserved
 * for a well-formed route with no rate row on the effective tier).
 *
 * Kept OUT of the registered shape on purpose: `@ggui-ai/iframe-runtime`
 * bundles `@ggui-ai/protocol` for the browser and never validates a render
 * input, so the route tables must not ride that bundle. The builder call is
 * `@__PURE__` so an importer that never uses the envelope drops it — and the
 * parser with it (the bundle-size gate is the receipt).
 */
function buildRenderInputEnvelope() {
  return z.object(renderInputShape).superRefine((value, ctx) => {
    const model = value.infra?.model;
    if (model !== undefined && parseAnyLlmRoute(model) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['infra', 'model'],
        message:
          'infra.model must be a model route: canonical `provider:model` or LiteLLM `provider/model` (aliases resolve in both). Bare model ids are not accepted.',
      });
    }
  });
}

export const renderInputEnvelopeSchema = /* @__PURE__ */ buildRenderInputEnvelope();

const ROUTE_MESSAGE =
  'infra.model must be a model route: canonical `provider:model` or LiteLLM `provider/model` (aliases resolve in both). Bare model ids are not accepted.';

/**
 * The pre-gate ROUTE GUARD — the route grammar and nothing else. The render
 * handler parses this before its pre-generation gate so a malformed
 * `infra.model` never reaches the gate, while a syntactically empty input
 * still does: #786 pins that a gate's refusal is projected BEFORE the
 * handler's own parse, so the guard MUST NOT require `handshakeId`/`props`
 * or reject unknown keys — the full envelope does that after the gate.
 */
function buildRenderInputRouteGuard() {
  return z
    .object({
      infra: z
        .object({
          model: z
            .string()
            .refine((s) => parseAnyLlmRoute(s) !== null, { message: ROUTE_MESSAGE })
            .optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough();
}

export const renderInputRouteGuardSchema = /* @__PURE__ */ buildRenderInputRouteGuard();

export type RenderInputEnvelope = z.infer<typeof renderInputEnvelopeSchema>;
