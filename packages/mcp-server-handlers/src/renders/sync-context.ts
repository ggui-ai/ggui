/**
 * `ggui_runtime_sync_context` — runtime → server context-snapshot mirror.
 *
 * The iframe-runtime emits `ui/update-model-context` to the host
 * (claude.ai et al) on every contextSpec slot change, carrying the
 * full snapshot of all declared slot values. The host displays
 * those values to the agent's LLM via `read_widget_context`.
 *
 * Today the SERVER never sees those snapshots — they're an
 * iframe→host postMessage. On chat-history rehydrate, the iframe
 * re-mounts with the contract's authoring-time defaults; the user's
 * last-known interactive state (typed text, counter values, toggle
 * positions) is silently lost.
 *
 * This tool is the symmetric server-side mirror. The runtime calls
 * `tools/call` with `name: 'ggui_runtime_sync_context'` alongside the
 * existing `ui/update-model-context` post; the handler writes the
 * snapshot onto the render's `contextSnapshot` field via
 * `renderStore.commit`'s upsert. On rehydrate, the resource handler
 * (and the bootstrap-meta projection) prefer `contextSnapshot[name]`
 * over `entry.default` per slot — restoring the user's state.
 *
 * Wire shape (mirrors the runtime's emitter in `context-observer.ts`):
 *
 * ```jsonc
 * {
 *   "method": "tools/call",
 *   "params": {
 *     "name": "ggui_runtime_sync_context",
 *     "arguments": {
 *       "sessionId":  "rnd_…",
 *       "appId":     "app_…",
 *       "snapshot":  { "count": 5, "noteText": "draft" }
 *     }
 *   }
 * }
 * ```
 *
 * **REPLACE semantics, not append.** Each call carries the FULL
 * current snapshot. Last-write-wins per sessionId. Matches the
 * runtime's existing posture (see `context-observer.ts` —
 * claude.ai's host already treats `ui/update-model-context` as
 * REPLACE, so deltas would diverge between server and host).
 *
 * **Visibility.** Registered with `_meta.ui.visibility: ['app']` so
 * MCP Apps hosts route iframe-issued `tools/call` to this handler
 * per spec §401. Outer agents don't see the tool — context state is
 * a runtime concern, not an agent gesture.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from
 * `{sessionId, stackItemId, ...}` to `{sessionId, ...}` — every render
 * IS the addressable scope.
 */
import { z } from 'zod';
import {
  CONTEXT_SLOT_VALUE_MAX_BYTES,
  CONTEXT_SNAPSHOT_MAX_BYTES,
  CONTEXT_SNAPSHOT_MAX_SLOTS,
  validateContextData,
  type ComponentGguiSession,
  type ContextSpec,
  type ContractViolation,
  type JsonObject,
} from '@ggui-ai/protocol';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';
import type { SharedHandler } from '../types.js';

const inputSchema = {
  sessionId: z
    .string()
    .min(1, 'sessionId is required')
    .describe(
      'Active render id — sourced from `_meta["ai.ggui/render"].sessionId` on the iframe boot envelope.',
    ),
  appId: z
    .string()
    .min(1, 'appId is required')
    .describe(
      'Active app id — sourced from `_meta["ai.ggui/render"].appId` on the iframe boot envelope.',
    ),
  snapshot: z
    .record(z.string(), z.unknown())
    .describe(
      'Full current snapshot of every declared contextSpec slot. Last-write-wins; the server overwrites any prior `contextSnapshot` on the render with this map verbatim.',
    ),
} as const;

const outputSchema = {
  ok: z.boolean(),
  code: z
    .enum([
      'SESSION_NOT_FOUND',
      'TENANT_MISMATCH',
      'CONTEXT_SCHEMA_VIOLATION',
      'CONTEXT_TOO_LARGE',
    ])
    .optional(),
  message: z.string().optional(),
} as const;

interface SyncContextAccepted {
  readonly ok: true;
}
interface SyncContextRejected {
  readonly ok: false;
  readonly code:
    | 'SESSION_NOT_FOUND'
    | 'TENANT_MISMATCH'
    | 'CONTEXT_SCHEMA_VIOLATION'
    | 'CONTEXT_TOO_LARGE';
  readonly message: string;
}
type SyncContextOutput = SyncContextAccepted | SyncContextRejected;

export interface CreateGguiSyncContextHandlerDeps {
  readonly renderStore: GguiSessionStore;
}

/**
 * Build the `ggui_runtime_sync_context` handler. Registers as app-visible so
 * MCP Apps hosts route iframe-issued `tools/call` to it per
 * spec §401.
 */
export function createGguiSyncContextHandler(
  deps: CreateGguiSyncContextHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, SyncContextOutput> {
  return {
    name: 'ggui_runtime_sync_context',
    title: '[runtime] Sync Context',
    audience: ['runtime'],
    description:
      'Mirrors a contextSpec snapshot from the iframe-runtime to the server (REPLACE semantics, last-write-wins per sessionId). Iframe-only — `_meta.ui.visibility: [\'app\']` restricts callers per spec §401. Server stores the snapshot on the render; chat-history rehydrate seeds `contextSlots[i].default` with the snapshotted values, restoring the user\'s last-known interactive state instead of resetting to authoring-time defaults.',
    inputSchema,
    outputSchema,
    _meta: {
      ui: { visibility: ['app'] as const },
    },
    async handler(input): Promise<SyncContextOutput> {
      const parsed = z.object(inputSchema).safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `sync-context envelope rejected at top-level: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
        };
      }
      const { sessionId, appId, snapshot } = parsed.data;

      // Bound the snapshot. contextSpec is observable state for the
      // agent, NOT content storage. Reject (not truncate) so authors
      // notice and route bulky data through the right surface
      // (propsSpec / streamSpec / a tool call).
      const sizeViolation = enforceSnapshotSize(
        snapshot as Record<string, unknown>,
      );
      if (sizeViolation !== null) {
        return {
          ok: false,
          code: 'CONTEXT_TOO_LARGE',
          message: sizeViolation,
        };
      }

      const stored = await deps.renderStore.get(sessionId);
      if (!stored) {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `render "${sessionId}" not found — likely TTL-expired or closed. Iframe should drop further sync attempts until the next render refreshes the bootstrap.`,
        };
      }
      // Tenant gate. Without this, a malicious iframe (or a buggy
      // bootstrap that captured a stale appId) could write context
      // onto a render it doesn't own. Match the appId carried on
      // the bootstrap against the render's appId; mismatch = drop.
      if (stored.appId !== appId) {
        return {
          ok: false,
          code: 'TENANT_MISMATCH',
          message: `render "${sessionId}" is owned by a different app — request declared "${appId}" but render is bound to "${stored.appId}".`,
        };
      }
      // mcpApps locator renders have no contextSpec — they're
      // embedded third-party iframes the iframe-runtime doesn't
      // render. Drop sync attempts onto them rather than corrupting
      // the row.
      if (stored.render.type === 'mcpApps') {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `render "${sessionId}" is an MCP Apps locator (third-party iframe) — context sync is not applicable.`,
        };
      }
      if (stored.render.type === 'system') {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `render "${sessionId}" is a system card — context sync is not applicable.`,
        };
      }
      // Schema validation: every snapshot key MUST be a declared slot
      // in the render's contextSpec, AND its value MUST satisfy
      // the slot's JSON Schema.
      const renderContextSpec = stored.render.contextSpec;
      const violations = validateSnapshotAgainstSpec(
        snapshot as Record<string, unknown>,
        renderContextSpec,
      );
      if (violations.length > 0) {
        return {
          ok: false,
          code: 'CONTEXT_SCHEMA_VIOLATION',
          message: `sync-context snapshot violates contextSpec: ${violations
            .map((v) => `${v.field}: ${v.message}`)
            .join('; ')}`,
        };
      }
      // Upsert the render with the snapshot. `commit` is upsert-by-id
      // — same render.id replaces the existing entry in place. No new
      // event sequence bump for context sync; this is internal state-
      // mirroring, not an observable agent event.
      const updated: ComponentGguiSession = {
        ...stored.render,
        contextSnapshot: snapshot as JsonObject,
      };
      await deps.renderStore.commit({
        render: updated,
        appId: stored.appId,
        ...(stored.userId !== undefined ? { userId: stored.userId } : {}),
        ...(stored.endUserIdentity !== undefined
          ? { endUserIdentity: stored.endUserIdentity }
          : {}),
        ...(stored.themeId !== undefined ? { themeId: stored.themeId } : {}),
        ...(stored.hostSession !== undefined
          ? { hostSession: stored.hostSession }
          : {}),
      });
      return { ok: true };
    },
  };
}

/**
 * Validate the agent-supplied snapshot against the render's
 * declared contextSpec. Each declared slot's value (when present in
 * the snapshot) is type-checked against its JSON Schema via
 * `validateContextData`. Snapshot keys that aren't declared in the
 * spec count as `Unknown context slot` violations (strict policy —
 * matches the propsSpec posture).
 *
 * Empty snapshot is always valid: it's idempotent + matches the
 * absence-of-snapshot default.
 *
 * Absent contextSpec on the render with a non-empty snapshot is
 * a contract drift — every slot in the snapshot reports as
 * unknown.
 */
function validateSnapshotAgainstSpec(
  snapshot: Record<string, unknown>,
  spec: ContextSpec | undefined,
): ContractViolation[] {
  const slots = Object.keys(snapshot);
  if (slots.length === 0) return [];
  if (!spec) {
    return [
      {
        field: 'contextSnapshot',
        message:
          'snapshot supplied but the render declares no contextSpec — refine the contract OR drop the snapshot.',
        expected: 'no snapshot (no contextSpec declared)',
        received: `snapshot with keys: ${slots.join(', ')}`,
      },
    ];
  }
  const violations: ContractViolation[] = [];
  for (const slotName of slots) {
    const value = snapshot[slotName];
    const result = validateContextData(slotName, value, spec);
    if (!result.valid) violations.push(...result.violations);
  }
  return violations;
}

/**
 * Bound the snapshot to {@link CONTEXT_SLOT_VALUE_MAX_BYTES} per slot,
 * {@link CONTEXT_SNAPSHOT_MAX_BYTES} total, and
 * {@link CONTEXT_SNAPSHOT_MAX_SLOTS} entries. Returns a non-null
 * error message when any bound is exceeded; otherwise null.
 *
 * Byte size is measured against UTF-8 serialization of each value
 * (`JSON.stringify(v)` byte length). `undefined` slots stringify to
 * the literal `undefined` (zero in JSON; we conservatively count the
 * raw string).
 */
function enforceSnapshotSize(snapshot: Record<string, unknown>): string | null {
  const keys = Object.keys(snapshot);
  if (keys.length > CONTEXT_SNAPSHOT_MAX_SLOTS) {
    return `snapshot has ${keys.length} slots; max ${CONTEXT_SNAPSHOT_MAX_SLOTS}. contextSpec is observable state, not content storage — route bulky data through propsSpec, streamSpec, or a tool call.`;
  }
  let totalBytes = 0;
  for (const slot of keys) {
    const value = snapshot[slot];
    const serialized = JSON.stringify(value) ?? String(value);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > CONTEXT_SLOT_VALUE_MAX_BYTES) {
      return `slot "${slot}" value is ${bytes} bytes; max ${CONTEXT_SLOT_VALUE_MAX_BYTES} per slot. contextSpec is observable state — large blobs belong on propsSpec, streamSpec, or a tool call.`;
    }
    totalBytes += bytes;
    if (totalBytes > CONTEXT_SNAPSHOT_MAX_BYTES) {
      return `snapshot total exceeds ${CONTEXT_SNAPSHOT_MAX_BYTES} bytes (running total ${totalBytes}). contextSpec is observable state, not content storage.`;
    }
  }
  return null;
}
