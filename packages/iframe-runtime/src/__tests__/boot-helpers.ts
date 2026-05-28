/**
 * Shared test helpers for `bootSequence` specs post-Phase-1.19b.3.
 *
 * Before the App-class swap, tests injected a `callUiInitialize` closure
 * returning a `JsonRpcResponse`. Post-swap the seam is an `App` instance
 * + `Transport`; tests construct both via {@link buildBootHarness},
 * configure the handshake response + optional toolresult delivery, and
 * pass them straight to `bootSequence`.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import { toMcpAppEnvelope } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { MockTransport, type QueueResponseOptions } from './mock-transport.js';

const PROTOCOL_VERSION = '2026-01-26';

export const DEFAULT_HOST_CONTEXT = {
  availableDisplayModes: ['inline', 'fullscreen', 'pip'] as const,
};

/**
 * Build a happy `ui/initialize` response — pinned to the spec-canonical
 * shape (no `toolOutput`; Reading-B is retired). Tests that want to
 * exercise spec-strict hosts (no `toolOutput`) pass this verbatim;
 * tests that need to fail the handshake pass `{error: ...}` instead.
 */
export function buildHappyInitResult(overrides?: {
  readonly hostContext?: Record<string, unknown>;
}): { readonly result: Record<string, unknown> } {
  return {
    result: {
      protocolVersion: PROTOCOL_VERSION,
      hostInfo: { name: 'test-host', version: '1.0' },
      hostCapabilities: {},
      hostContext: overrides?.hostContext ?? { ...DEFAULT_HOST_CONTEXT },
    },
  };
}

/**
 * Build a `ui/notifications/tool-result` notification params payload
 * that carries an `ai.ggui/render` slice on `_meta`. The params is the
 * same shape App's `toolresult` event surfaces — `params` of the
 * notification.
 */
export function buildToolResultParams(
  meta: McpAppAiGguiRenderMeta,
): Record<string, unknown> {
  return {
    _meta: toMcpAppEnvelope(meta),
    content: [{ type: 'text', text: 'rendered' }],
    structuredContent: { renderId: meta.renderId },
  };
}

export interface BootHarness {
  readonly app: App;
  readonly transport: MockTransport;
  /**
   * Drive a `ui/notifications/tool-result` notification into the bound
   * App from the test. The boot sequence resolves slice meta off the
   * first such notification.
   */
  readonly pushToolResult: (meta: McpAppAiGguiRenderMeta) => void;
}

export interface BuildBootHarnessOptions {
  /**
   * Queue the App's response to `ui/initialize`. Default: a happy
   * spec-canonical response with `hostContext.availableDisplayModes`.
   * Pass `{error: ...}` to drive `UI_INITIALIZE_FAILED`.
   */
  readonly initResponse?: QueueResponseOptions;
  /**
   * App constructor options — defaults to `{ autoResize: false }` so
   * tests don't touch jsdom's `document.body` size APIs.
   */
  readonly appOptions?: { readonly autoResize?: boolean };
}

/**
 * Drain the microtask + immediate-timer queues so the bound App has
 * a chance to advance past `transport.start()` and register its
 * inbound `onmessage` callback. Tests that push notifications before
 * the handshake settles need this so the push lands on a live
 * listener instead of dropping silently.
 */
export async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function buildBootHarness(opts: BuildBootHarnessOptions = {}): BootHarness {
  const transport = new MockTransport();
  transport.queueResponse(
    'ui/initialize',
    opts.initResponse ?? buildHappyInitResult(),
  );
  const app = new App(
    { name: 'test-runtime', version: '0.1.0' },
    {},
    { autoResize: opts.appOptions?.autoResize ?? false },
  );
  return {
    app,
    transport,
    pushToolResult(meta) {
      transport.pushNotification({
        method: 'ui/notifications/tool-result',
        params: buildToolResultParams(meta),
      });
    },
  };
}
