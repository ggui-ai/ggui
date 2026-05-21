/**
 * `props_update` channel handler — factored out of `runtime.ts` into
 * the `@ggui-ai/channel-client` layer.
 *
 * Receives a `{stackItemId, props}` payload from the live channel, validates
 * the new props against the stack item's cached `propsSpec`, patches
 * the in-model entry, and re-applies the renderer so React picks up
 * the change.
 *
 * Skips when:
 *   - `stackItemId` is empty or not a string.
 *   - `props` is null / not an object (defensive — server can't emit
 *     this shape, but the dispatcher routes the frame on type alone).
 *   - No matching stack item exists (server raced ahead of our pop).
 *   - The matched item is `mcpApps` / `system` (no `propsSpec`; server
 *     should never emit `props_update` for these).
 *   - The new props fail validation against the cached spec.
 *
 * An OPTIONAL polling descriptor provides a fallback transport —
 * when `polling` is supplied at factory time, `PollingTransport`
 * polls `/api/bootstrap/<shortCode>` and synthesizes a frame
 * whenever `propsJson` diffs from the last seen hash. WS hosts are
 * unaffected (the `polling` descriptor is inert under `WSTransport`).
 */

import type {
  ChannelHandler,
  ChannelPollingDescriptor,
} from '@ggui-ai/channel-client';
import type {
  JsonObject,
  PropsUpdatePayload,
  SessionStackEntry,
} from '@ggui-ai/protocol';

import type { StackRenderer } from '../stack-item-renderer.js';
import type { StackModel } from '../stack.js';
import { validateInboundPropsPayload } from '../validation.js';

export interface PropsUpdateHandlerDeps {
  readonly stackModel: StackModel;
  readonly getStackRenderer: () => StackRenderer;
  /**
   * Optional polling fallback URL. When the registry's chosen transport
   * is `PollingTransport` (e.g. bootstrap missing wsUrl, or
   * `FailoverHandle` swapped WS → polling after a hard failure), this
   * URL is fetched on each tick. The response body is expected to carry
   * `propsJson` + `stackItemId` (the same shape `/api/bootstrap/<code>`
   * returns); the handler diffs `propsJson` between ticks and synthesizes
   * a `props_update` frame whenever it changes. WS hosts ignore this
   * descriptor (polling is inert under `WSTransport`).
   *
   * Producer: server stamps `bootstrap.pollingUrl` on the bootstrap
   * envelope. Consumer: iframe-runtime threads it here at handler
   * registration time. Absent → no polling fallback (WS-only mode).
   */
  readonly pollingUrl?: string;
  /**
   * Polling cadence in milliseconds. Defaults to 2000ms per the B5
   * plan (well inside the 10s drain-claim budget; 5 ticks of safety).
   */
  readonly pollingIntervalMs?: number;
}

const DEFAULT_POLLING_INTERVAL_MS = 2000;

/**
 * Tiny FNV-1a 32-bit hash — stable, no protocol dep, ~5 LOC. We only
 * need diff detection (not collision resistance), so the trade-off is
 * fine. Returns a hex string for human-readable logs.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiplication via additive bit-shifts.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16);
}

export function createPropsUpdateHandler(
  deps: PropsUpdateHandlerDeps,
): ChannelHandler<PropsUpdatePayload> {
  const polling = buildPollingDescriptor(deps);
  return {
    type: 'props_update',
    onMessage: async (payload) => {
      const { stackItemId, props } = payload;
      if (typeof stackItemId !== 'string' || stackItemId.length === 0) return;
      if (props === null || typeof props !== 'object') return;

      const target = deps.stackModel
        .snapshot()
        .find((item) => item.id === stackItemId);
      if (target === undefined) return;
      if (target.type === 'mcpApps' || target.type === 'system') return;

      const result = validateInboundPropsPayload(target.propsSpec, props);
      if (!result.valid) return;

      const nextSnapshot: SessionStackEntry[] = deps.stackModel
        .snapshot()
        .map((item) => {
          if (item.id !== stackItemId) return item;
          if (item.type === 'mcpApps' || item.type === 'system') return item;
          return { ...item, props };
        });
      deps.stackModel.setAll(nextSnapshot);
      await deps.getStackRenderer().applyStack(deps.stackModel.snapshot());
    },
    ...(polling !== undefined ? { polling } : {}),
  };
}

function buildPollingDescriptor(
  deps: PropsUpdateHandlerDeps,
): ChannelPollingDescriptor<PropsUpdatePayload> | undefined {
  const { pollingUrl } = deps;
  if (typeof pollingUrl !== 'string' || pollingUrl.length === 0) {
    return undefined;
  }
  const url = pollingUrl;
  // Closure state — last-seen propsJson hash + last-seen stackItemId.
  // Diff detection: emit only on change. First-poll fires (lastSeenHash
  // is null initially) so the iframe gets the current props as its
  // starting state when WS is absent.
  let lastSeenHash: string | null = null;
  let lastSeenStackItemId: string | null = null;
  return {
    url,
    intervalMs: deps.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
    parse: (body: unknown): PropsUpdatePayload | null => {
      if (body === null || typeof body !== 'object') return null;
      const propsJson = (body as { propsJson?: unknown }).propsJson;
      const bootstrapStackItemId = (body as { stackItemId?: unknown })
        .stackItemId;
      if (
        typeof propsJson !== 'string' ||
        typeof bootstrapStackItemId !== 'string' ||
        bootstrapStackItemId.length === 0
      ) {
        return null;
      }
      const hash = fnv1a(propsJson);
      if (
        hash === lastSeenHash &&
        bootstrapStackItemId === lastSeenStackItemId
      ) {
        return null; // Unchanged — skip dispatch.
      }
      lastSeenHash = hash;
      lastSeenStackItemId = bootstrapStackItemId;
      let parsedProps: unknown;
      try {
        parsedProps = JSON.parse(propsJson);
      } catch {
        return null;
      }
      if (
        parsedProps === null ||
        typeof parsedProps !== 'object' ||
        Array.isArray(parsedProps)
      ) {
        return null;
      }
      // JSON.parse of an object literal yields a JsonObject by
      // construction — JSON only carries JsonValue-compatible
      // structure. Narrow to the protocol's typed shape.
      return {
        stackItemId: bootstrapStackItemId,
        props: parsedProps as JsonObject,
      };
    },
  };
}
