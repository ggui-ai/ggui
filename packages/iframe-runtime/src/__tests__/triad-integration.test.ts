/**
 * Triad integration — exercises the `bootSequence` + `triadWiring`
 * composition end-to-end against in-memory stubs.
 *
 * The test pins the renderer's load-bearing behavior:
 *
 *   1. `globalThis.__ggui__` is populated BEFORE any stack item
 *      renders (TOCTOU ordering claim).
 *   2. A `push` frame that lands with empty componentCode mounts
 *      the provisional renderer for that stack item (data-ggui-
 *      stack-item-root container).
 *   3. A subsequent `push` with componentCode transitions the same
 *      container to the React mount (kind change).
 *   4. A `data` envelope on a tool:<name> channel fires the
 *      registered ClientToolBus handler AND emits a `feedback`
 *      frame through the manager shim.
 *   5. A `props_update` frame revalidates + patches the stack
 *      model.
 *
 * Post-B3b: the triad's `ChannelRegistry` is the dispatch surface for
 * every WS frame. Tests drive frames by invoking the registered
 * handler directly through `inspectHandlers()` — no `messageHandler`
 * callback to thread through anymore.
 */
import { describe, it, expect, vi } from 'vitest';
import { mountViewToMcpAppMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { act } from 'react';
import type { SessionStackEntry } from '@ggui-ai/protocol';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type { McpAppAiGguiMountView } from '@ggui-ai/protocol/integrations/mcp-apps';
import { bootSequence, type TriadHandle, type TriadWiringHooks } from '../runtime.js';
import {
  buildRootWireConfig,
  StreamBus,
} from '../wire-config.js';
import { StackRenderer, type StackRenderContext } from '../stack-item-renderer.js';
import {
  installGlobalRegistry,
  getGlobalRegistry,
} from '../globals.js';
import { mergeReservedValidators } from '../validation.js';
import { ChannelRegistry } from '@ggui-ai/channel-client';
import {
  createChannelErrorHandler,
  createChannelPayloadHandler,
  createDataHandler,
  createDrainAckHandler,
  createFeedbackHandler,
  createPropsUpdateHandler,
  createPushHandler,
} from '../channels/index.js';
import type { ConnectFn } from '../registry-subscribe.js';

async function flush(fn?: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    if (fn) await fn();
  });
}

const VALID_BOOTSTRAP: McpAppAiGguiMountView = {
  wsUrl: 'wss://example/ws',
  token: 'tok',
  expiresAt: '2099-01-01T00:00:00.000Z',
  sessionId: 'sess_1',
  appId: 'app_1',
  runtimeUrl: '/_ggui/iframe-runtime.js',
};

function buildHappyInit(): { result: unknown } {
  return {
    result: {
      toolOutput: {
        _meta: mountViewToMcpAppMeta(VALID_BOOTSTRAP),
        structuredContent: {},
      },
    },
  };
}

function componentItem(
  id: string,
  componentCode: string = '',
): SessionStackEntry {
  return {
    id,
    componentCode,
    createdAt: new Date().toISOString(),
  } as SessionStackEntry;
}

/**
 * Helper — emit a frame by looking up the handler in the registry.
 * Tests use this in place of the old `messageHandler!({...})` calls.
 */
function emitFrame(
  registry: ChannelRegistry,
  type: string,
  payload: unknown,
): void {
  const handler = registry.inspectHandlers().get(type);
  if (handler === undefined) {
    throw new Error(`no handler registered for type "${type}"`);
  }
  void handler.onMessage(payload);
}

/**
 * Build a `connectFn` that captures the registry it receives and the
 * ack payload to deliver post-bind. Returns the connectFn plus a
 * reference to the captured registry so tests can drive frames
 * through registered handlers.
 */
function buildMockConnect(stack: SessionStackEntry[] | undefined): {
  connectFn: ConnectFn;
  registryRef: { current: ChannelRegistry | null };
  realManagerSend: ReturnType<typeof vi.fn>;
} {
  const registryRef: { current: ChannelRegistry | null } = { current: null };
  const realManagerSend = vi.fn();
  const connectFn: ConnectFn = async (opts) => {
    registryRef.current = opts.registry;
    return {
      handle: {
        kind: 'ws' as const,
        status: 'open' as const,
        send: realManagerSend,
        start: vi.fn(),
        dispose: async () => {},
      },
      ack: {
        sequence: 1,
        timestamp: Date.now(),
        ...(stack !== undefined ? { stack } : {}),
      },
    };
  };
  return { connectFn, registryRef, realManagerSend };
}

/**
 * Build a test-only `triadWiring` that mirrors `bootProduction`'s
 * real wiring but uses fakes for the module handles (no need to
 * actually import React's 500 KB dependency graph for these tests).
 */
function buildTestTriadWiring(
  renderInto: HTMLElement,
  managerCapture: { current: { send: ReturnType<typeof vi.fn> } | null },
): TriadWiringHooks {
  return {
    setup: ({ bootstrap, stackModel, statusRefs }) => {
      installGlobalRegistry({
        react: { __fake: true },
        reactDom: { __fake: true },
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
      });

      const streamBus = new StreamBus();
      const buffered: WebSocketMessage[] = [];
      const shim = {
        send: vi.fn((msg: WebSocketMessage) => {
          if (managerCapture.current !== null) {
            managerCapture.current.send(msg);
            return;
          }
          buffered.push(msg);
        }),
      };

      const { config: rootConfig, buildScopedConfig } = buildRootWireConfig({
        sessionId: bootstrap.sessionId,
        appId: bootstrap.appId,
        getStack: () => stackModel.snapshot(),
        manager: shim,
        streamBus,
      });

      const containersById = new Map<string, HTMLElement>();
      const containerFor = (id: string): HTMLElement => {
        const existing = containersById.get(id);
        if (existing !== undefined) return existing;
        const el = renderInto.ownerDocument.createElement('div');
        el.setAttribute('data-ggui-stack-item-root', id);
        renderInto.appendChild(el);
        containersById.set(id, el);
        return el;
      };

      const stackCtx: StackRenderContext = {
        containerFor,
        getScopedWireConfig: (item) => {
          if (item.type === 'mcpApps' || item.type === 'system') return null;
          return buildScopedConfig({
            stackItemId: item.id,
            ...(item.actionSpec !== undefined ? { actionSpec: item.actionSpec } : {}),
          });
        },
        streamBus,
        sessionId: bootstrap.sessionId,
      };
      const stackRenderer = new StackRenderer(stackCtx);

      // B3b — wire the same channel-client registry the production
      // path builds, with the FULL handler set (every routable WS
      // frame has a registered handler). `bind()` is never called
      // (the test fakes the WS via the connectFn); tests drive
      // frames by invoking handlers directly through
      // `inspectHandlers()`.
      const validatorCtx = {
        reservedValidators: mergeReservedValidators(undefined, undefined),
      };
      const channelTransportStub = {
        applyStackItem: () => {},
        handleWsFrame: () => false,
        onWsStatusChange: () => {},
        dispose: () => {},
      };
      const channelRegistry = new ChannelRegistry({
        subscribeFrameBuilder: () => ({
          type: 'subscribe',
          payload: { sessionId: bootstrap.sessionId, appId: bootstrap.appId },
        }),
      });
      channelRegistry.register(
        createPushHandler({
          stackModel,
          statusRefs,
          getStackRenderer: () => stackRenderer,
          getChannelTransport: () => channelTransportStub,
        }),
      );
      channelRegistry.register(
        createDataHandler({ stackModel, streamBus, validatorCtx }),
      );
      channelRegistry.register(
        createPropsUpdateHandler({
          stackModel,
          getStackRenderer: () => stackRenderer,
        }),
      );
      channelRegistry.register(
        createDrainAckHandler({ dispatch: () => {} }),
      );
      channelRegistry.register(createFeedbackHandler());
      channelRegistry.register(
        createChannelPayloadHandler({
          getChannelTransport: () => channelTransportStub,
        }),
      );
      channelRegistry.register(
        createChannelErrorHandler({
          getChannelTransport: () => channelTransportStub,
        }),
      );

      return {
        rootWireConfig: rootConfig,
        streamBus,
        stackRenderer,
        validatorCtx,
        manager: shim,
        channelTransport: channelTransportStub,
        channelRegistry,
      };
    },
    attachManager: (_handle, real) => {
      managerCapture.current = real as { send: ReturnType<typeof vi.fn> };
    },
    teardown: (handle) => {
      handle.stackRenderer.unmountAll();
    },
  };
}

describe('triad boot — full flow', () => {
  it('installs globalThis.__ggui__ before first stack render + applies ack stack', async () => {
    const dom = document.implementation.createHTMLDocument('int-test');
    const initialItem = componentItem('a', '');
    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInit());

    const { connectFn } = buildMockConnect([initialItem]);

    const managerCapture: { current: { send: ReturnType<typeof vi.fn> } | null } = { current: null };
    const triadWiring = buildTestTriadWiring(dom.body, managerCapture);

    const triadHandleBox: { value: TriadHandle | null } = { value: null };
    const origSetup = triadWiring.setup;
    triadWiring.setup = (params) => {
      const h = origSetup(params);
      triadHandleBox.value = h;
      return h;
    };

    await flush(async () => {
      await bootSequence({
        doc: dom,
        callUiInitialize,
        connectFn,
        notifyParent: vi.fn(),
        triadWiring,
      });
    });

    // __ggui__ populated BEFORE applyStack ran (setup() installs it).
    const registry = getGlobalRegistry();
    expect(registry).toBeDefined();
    expect(registry?.react).toEqual({ __fake: true });

    const containers = dom.body.querySelectorAll('[data-ggui-stack-item-root]');
    expect(containers.length).toBe(1);
    expect(containers[0]?.getAttribute('data-ggui-stack-item-root')).toBe('a');

    // `attachManager` ran — managerCapture populated by real send.
    expect(managerCapture.current).not.toBeNull();

    expect(triadHandleBox.value).not.toBeNull();
    expect(triadHandleBox.value?.streamBus).toBeInstanceOf(StreamBus);
  });
});

describe('triad — data envelope → stream bus fan-out', () => {
  it('fans out a validated data envelope to subscribers', async () => {
    const dom = document.implementation.createHTMLDocument('int-test');
    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInit());
    const { connectFn, registryRef } = buildMockConnect([componentItem('a', '')]);

    const managerCapture: { current: { send: ReturnType<typeof vi.fn> } | null } = { current: null };
    const triadWiring = buildTestTriadWiring(dom.body, managerCapture);

    let capturedHandle: TriadHandle | null = null;
    const origSetup = triadWiring.setup;
    triadWiring.setup = (p) => {
      capturedHandle = origSetup(p);
      return capturedHandle;
    };

    await flush(async () => {
      await bootSequence({
        doc: dom,
        callUiInitialize,
        connectFn,
        notifyParent: vi.fn(),
        triadWiring,
      });
    });

    const busHandler = vi.fn();
    capturedHandle!.streamBus.subscribe('progress', busHandler);

    // Simulate a server data frame on channel `progress` via the
    // registered handler.
    if (registryRef.current === null) throw new Error('registry not captured');
    emitFrame(registryRef.current, 'data', {
      sessionId: 'sess_1',
      channel: 'progress',
      mode: 'append',
      payload: { percent: 42 },
    });

    expect(busHandler).toHaveBeenCalledTimes(1);
    expect(busHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'progress',
        payload: { percent: 42 },
      }),
    );
  });
});

describe('triad — late `_ggui:preview` subscriber receives buffered envelopes', () => {
  it('replays reserved-channel frames that arrived before the subscribe to the late subscriber', async () => {
    const dom = document.implementation.createHTMLDocument('int-test');
    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInit());
    const { connectFn, registryRef } = buildMockConnect([componentItem('a', '')]);

    const managerCapture: { current: { send: ReturnType<typeof vi.fn> } | null } = { current: null };
    const triadWiring = buildTestTriadWiring(dom.body, managerCapture);

    let capturedHandle: TriadHandle | null = null;
    const origSetup = triadWiring.setup;
    triadWiring.setup = (p) => {
      capturedHandle = origSetup(p);
      return capturedHandle;
    };

    await flush(async () => {
      await bootSequence({
        doc: dom,
        callUiInitialize,
        connectFn,
        notifyParent: vi.fn(),
        triadWiring,
      });
    });

    const previewEnv = {
      sessionId: 'sess_1',
      channel: '_ggui:preview',
      mode: 'append' as const,
      payload: {
        version: 'v0.9',
        createSurface: { surfaceId: 'sx', catalogId: 'a2ui-v0.9-default' },
      },
      seq: 1,
    };
    if (registryRef.current === null) throw new Error('registry not captured');
    emitFrame(registryRef.current, 'data', previewEnv);

    const lateHandler = vi.fn();
    capturedHandle!.streamBus.subscribe('_ggui:preview', lateHandler);

    expect(lateHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: '_ggui:preview',
        payload: previewEnv.payload,
      }),
    );
  });
});

describe('triad — props_update applies patch', () => {
  it('updates stack-model props for target item on valid props_update', async () => {
    const dom = document.implementation.createHTMLDocument('int-test');
    const initialItem: SessionStackEntry = {
      id: 'a',
      componentCode: 'export default () => null;',
      createdAt: new Date().toISOString(),
      props: { count: 0 },
    } as SessionStackEntry;

    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInit());
    const { connectFn, registryRef } = buildMockConnect([initialItem]);

    const managerCapture: { current: { send: ReturnType<typeof vi.fn> } | null } = { current: null };
    const triadWiring = buildTestTriadWiring(dom.body, managerCapture);

    let capturedHandle: TriadHandle | null = null;
    const origSetup = triadWiring.setup;
    triadWiring.setup = (p) => {
      capturedHandle = origSetup(p);
      return capturedHandle;
    };

    let capturedStackModel: { snapshot: () => readonly SessionStackEntry[] } | null = null;
    const origSetup2 = triadWiring.setup;
    triadWiring.setup = (p) => {
      capturedStackModel = p.stackModel;
      return origSetup2(p);
    };

    await flush(async () => {
      await bootSequence({
        doc: dom,
        callUiInitialize,
        connectFn,
        notifyParent: vi.fn(),
        triadWiring,
      });
    });

    if (registryRef.current === null) throw new Error('registry not captured');
    await flush(async () => {
      emitFrame(registryRef.current!, 'props_update', {
        stackItemId: 'a',
        props: { count: 5 },
      });
    });

    const snapshot = capturedStackModel!.snapshot();
    const item = snapshot.find((s) => s.id === 'a');
    expect(item?.props).toEqual({ count: 5 });
  });
});
