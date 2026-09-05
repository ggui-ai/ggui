/**
 * `ggui_runtime_telemetry` — the iframe runtime's transport
 * self-report, and the ONLY window an operator has into the delivery
 * ladder's behavior on sandboxed MCP-Apps hosts.
 *
 * Why this tool exists (2026-08-12, transport-ladder debugging): on
 * claude.ai the view runs in a `claudemcpcontent.com` sandbox frame
 * whose console is unreadable from outside and whose CSP blocks every
 * network channel — when the WS → SSE → polling → bridge-pull ladder
 * misbehaves there, NOTHING reaches server logs and the failure is
 * invisible by construction. The runtime therefore batches its own
 * ladder events (boot-path decision, per-rung status transitions, the
 * live-channel logger's `channel_*` diagnostics, doorbell rings) and
 * flushes them over the host's `tools/call` postMessage bridge — the
 * one carrier a CSP jail cannot block.
 *
 * Posture: fire-and-forget diagnostics, NEVER a data plane.
 *   - Stores nothing; emits ONE structured log line per batch.
 *   - `sessionId` is client-claimed — a log tag, never a read key, so
 *     no app-scope gate and no store dependency (nothing to leak).
 *   - Bounded by the protocol schema (≤ 40 events/batch, kind ≤ 64
 *     chars, detail ≤ 512) against log flooding; `ctx.appId` (the
 *     PROVED identity on this carrier) tags every line so abuse is
 *     attributable.
 */
import { z } from 'zod';
import {
  runtimeTelemetryInputShape,
  type GguiRuntimeTelemetryOutput,
} from '@ggui-ai/protocol';
import { defineHandler, type HandlerContext } from '../types.js';

const inputSchema = runtimeTelemetryInputShape;

const outputSchema = {
  ok: z.literal(true),
} as const;

/**
 * Structured-log sink. Matches the narrow slice of the server
 * logger this handler needs; OSS default falls back to a single-line
 * `console.log` in the same shape the log pipeline already parses.
 */
export interface RuntimeTelemetryLogger {
  info(event: string, fields: Record<string, unknown>): void;
}

export interface GguiRuntimeTelemetryHandlerDeps {
  /** Optional structured logger; absent → single-line console JSON. */
  readonly logger?: RuntimeTelemetryLogger;
}

/**
 * Build the `ggui_runtime_telemetry` handler. Registers as
 * app-visible (`_meta.ui.visibility: ['app']`) so MCP Apps hosts route
 * iframe-issued `tools/call` to it per spec §401 — the same channel
 * `ggui_runtime_submit_action` and `ggui_runtime_pull` ride.
 */
export function createGguiRuntimeTelemetryHandler(
  deps: GguiRuntimeTelemetryHandlerDeps = {},
) {
  return defineHandler({
    name: 'ggui_runtime_telemetry',
    title: '[runtime] Report Transport Telemetry',
    audience: ['runtime'],
    description:
      "Fire-and-forget transport diagnostics from the iframe runtime — batched delivery-ladder events (boot path, WS/SSE/polling/bridge rung transitions, doorbell rings) logged server-side for operator forensics. Stores nothing, returns {ok: true}. Never invoked by the model — `_meta.ui.visibility: ['app']` restricts callers to MCP Apps views; sandboxed hosts expose no console, so this tool is the only way ladder behavior there reaches an operator.",
    inputSchema,
    outputSchema,
    _meta: {
      ui: {
        // Spec §401: only an MCP Apps view (iframe) can call. The
        // outer agent does NOT see this tool.
        visibility: ['app'] as const,
      },
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- SharedHandler's handler contract is async; this one has no awaits (log-and-return)
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiRuntimeTelemetryOutput> {
      const parsed = z.object(inputSchema).parse(rawInput);
      const line = {
        sessionId: parsed.sessionId,
        appId: ctx.appId,
        eventCount: parsed.events.length,
        events: parsed.events.map((e) => ({
          at: e.at,
          kind: e.kind,
          ...(e.detail !== undefined ? { detail: e.detail } : {}),
        })),
      };
      if (deps.logger) {
        deps.logger.info('runtime_telemetry', line);
      } else {
        // eslint-disable-next-line no-console -- structured single-line event for log-pipeline pickup (same posture as render-identity's emitters)
        console.log(JSON.stringify({ msg: 'runtime_telemetry', ...line }));
      }
      return { ok: true };
    },
  });
}
