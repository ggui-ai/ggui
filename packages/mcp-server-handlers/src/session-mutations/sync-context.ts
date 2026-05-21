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
 * snapshot onto the active StackItem's `contextSnapshot` field via
 * `appendStackItem`'s upsert. On rehydrate, the resource handler
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
 *       "sessionId":   "sess_…",
 *       "appId":       "app_…",
 *       "stackItemId": "page_…",
 *       "snapshot":    { "count": 5, "noteText": "draft" }
 *     }
 *   }
 * }
 * ```
 *
 * **REPLACE semantics, not append.** Each call carries the FULL
 * current snapshot. Last-write-wins per (sessionId, stackItemId).
 * Matches the runtime's existing posture (see `context-observer.ts`
 * — claude.ai's host already treats `ui/update-model-context` as
 * REPLACE, so deltas would diverge between server and host).
 *
 * **Visibility.** Registered with `_meta.ui.visibility: ['app']` so
 * MCP Apps hosts route iframe-issued `tools/call` to this handler
 * per spec §401. Outer agents don't see the tool — context state is
 * a runtime concern, not an agent gesture.
 */
import { z } from 'zod';
import {
  CONTEXT_SLOT_VALUE_MAX_BYTES,
  CONTEXT_SNAPSHOT_MAX_BYTES,
  CONTEXT_SNAPSHOT_MAX_SLOTS,
  validateContextData,
  type ContextSpec,
  type ContractViolation,
  type JsonObject,
  type SessionStackEntry,
  type StackItem,
} from '@ggui-ai/protocol';
import type { SessionStore } from '@ggui-ai/mcp-server-core';
import type { SharedHandler } from '../types.js';

const inputSchema = {
  sessionId: z
    .string()
    .min(1, 'sessionId is required')
    .describe(
      'Active session id — sourced from `_meta.ggui.bootstrap.sessionId` on the iframe boot envelope.',
    ),
  appId: z
    .string()
    .min(1, 'appId is required')
    .describe(
      'Active app id — sourced from `_meta.ggui.bootstrap.appId` on the iframe boot envelope.',
    ),
  stackItemId: z
    .string()
    .min(1, 'stackItemId is required')
    .describe(
      'Active stack item id — the iframe-runtime knows it from `bootstrap.stackItemId`. Server upserts onto this stack entry.',
    ),
  snapshot: z
    .record(z.string(), z.unknown())
    .describe(
      'Full current snapshot of every declared contextSpec slot. Last-write-wins; the server overwrites any prior `contextSnapshot` on the stack item with this map verbatim.',
    ),
} as const;

const outputSchema = {
  ok: z.boolean(),
  code: z
    .enum([
      'SESSION_NOT_FOUND',
      'STACK_ITEM_NOT_FOUND',
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
    | 'STACK_ITEM_NOT_FOUND'
    | 'TENANT_MISMATCH'
    | 'CONTEXT_SCHEMA_VIOLATION'
    | 'CONTEXT_TOO_LARGE';
  readonly message: string;
}
type SyncContextOutput = SyncContextAccepted | SyncContextRejected;

export interface CreateGguiSyncContextHandlerDeps {
  readonly sessionStore: SessionStore;
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
      'Mirrors a contextSpec snapshot from the iframe-runtime to the server (REPLACE semantics, last-write-wins per (sessionId, stackItemId)). Iframe-only — `_meta.ui.visibility: [\'app\']` restricts callers per spec §401. Server stores the snapshot on the active stack item; chat-history rehydrate seeds `contextSlots[i].default` with the snapshotted values, restoring the user\'s last-known interactive state instead of resetting to authoring-time defaults.',
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
          code: 'STACK_ITEM_NOT_FOUND',
          message: `sync-context envelope rejected at top-level: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
        };
      }
      const { sessionId, appId, stackItemId, snapshot } = parsed.data;

      // PIPE-2 (2026-05-12) — bound the snapshot. contextSpec is
      // observable state for the agent, NOT content storage. Reject
      // (not truncate) so authors notice and route bulky data through
      // the right surface (propsSpec / streamSpec / a tool call).
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

      const session = await deps.sessionStore.get(sessionId);
      if (!session) {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `session "${sessionId}" not found — likely TTL-expired or evicted. Iframe should drop further sync attempts until the next push refreshes the bootstrap.`,
        };
      }
      // Tenant gate. Without this, a malicious iframe (or a buggy
      // bootstrap that captured a stale appId) could write context
      // onto a session it doesn't own. Match the appId carried on
      // the bootstrap against the session's appId; mismatch = drop.
      if (session.appId !== appId) {
        return {
          ok: false,
          code: 'TENANT_MISMATCH',
          message: `session "${sessionId}" is owned by a different app — request declared "${appId}" but session is bound to "${session.appId}".`,
        };
      }
      // Find the target stack item. The iframe-runtime knows its
      // stackItemId from bootstrap; if the server's session has no
      // matching entry, the snapshot lands nowhere and we drop with
      // a typed code rather than upserting blindly (which would
      // create a phantom item). Compatible-by-id only.
      const target = session.stack.find(
        (entry): entry is SessionStackEntry & { id: string } =>
          entry.id === stackItemId,
      );
      if (!target) {
        return {
          ok: false,
          code: 'STACK_ITEM_NOT_FOUND',
          message: `stack item "${stackItemId}" not found in session "${sessionId}".`,
        };
      }
      // mcpApps locator items have no contextSpec — they're embedded
      // third-party iframes the iframe-runtime doesn't render. Drop
      // sync attempts onto them rather than corrupting the stack.
      if (target.type === 'mcpApps') {
        return {
          ok: false,
          code: 'STACK_ITEM_NOT_FOUND',
          message: `stack item "${stackItemId}" is an MCP Apps locator (third-party iframe) — context sync is not applicable.`,
        };
      }
      // Schema validation: every snapshot key MUST be a declared slot
      // in the StackItem's contextSpec, AND its value MUST satisfy
      // the slot's JSON Schema. Strict policy — a mistyped slot
      // or undeclared slot rejects with a structured per-slot
      // violation summary the runtime can surface. Without this gate,
      // a buggy generator could write nonsense onto the StackItem and
      // silently corrupt future rehydrate.
      //
      // No contextSpec on the StackItem → the contract didn't
      // declare any observable state, so a non-empty snapshot is
      // also a contract drift; reject. Empty snapshot is a no-op.
      //
      // Post-2026-05-13 trim: the per-slot `violations` array was
      // retired from the output — the iframe is fire-and-forget and
      // never branched on the structured list. The composed `message`
      // carries the full per-slot summary for operator-log debugging.
      const itemContextSpec = (target as StackItem).contextSpec;
      const violations = validateSnapshotAgainstSpec(
        snapshot as Record<string, unknown>,
        itemContextSpec,
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
      // Upsert the StackItem with the snapshot. `appendStackItem` is
      // upsert-by-id — same `target.id` replaces the existing entry
      // in place. No new event sequence bump for context sync; this
      // is internal state-mirroring, not an observable agent event.
      const updated: StackItem = {
        ...(target as StackItem),
        contextSnapshot: snapshot as JsonObject,
      };
      await deps.sessionStore.appendStackItem(sessionId, updated);
      return { ok: true };
    },
  };
}

/**
 * Validate the agent-supplied snapshot against the StackItem's
 * declared contextSpec. Each declared slot's value (when present in
 * the snapshot) is type-checked against its JSON Schema via
 * `validateContextData`. Snapshot keys that aren't declared in the
 * spec count as `Unknown context slot` violations (strict policy —
 * matches the propsSpec posture).
 *
 * Empty snapshot is always valid: it's idempotent + matches the
 * absence-of-snapshot default.
 *
 * Absent contextSpec on the StackItem with a non-empty snapshot is
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
          'snapshot supplied but the active stack item declares no contextSpec — refine the contract OR drop the snapshot.',
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
