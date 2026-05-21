import { describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { renderHook } from '@testing-library/react';
import { GguiWireProvider, type StreamDelivery, type WireConfig } from '@ggui-ai/wire';
import { useAction, useStream, useAuth, useApp, useSession } from '@ggui-ai/wire';

// ── Mock WireConfig ──────────────────────────────────────────

function createMockConfig(overrides?: Partial<WireConfig>): WireConfig {
  return {
    app: { appId: 'test-app', appName: 'Test App', appDescription: 'A test', appIcon: undefined },
    session: { sessionId: 'sess-123', isConnected: true },
    auth: { userId: 'user-alice', isAuthenticated: true },
    dispatch: vi.fn(),
    subscribe: vi.fn(() => vi.fn()), // returns unsubscribe
    callWiredTool: vi.fn(async () => ({ result: 'mock' })),
    ...overrides,
  };
}

function createWrapper(config: WireConfig) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <GguiWireProvider config={config}>{children}</GguiWireProvider>;
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('Wire hooks inside GguiWireProvider', () => {
  describe('useAuth', () => {
    it('returns auth context', () => {
      const config = createMockConfig();
      const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(config) });
      expect(result.current.userId).toBe('user-alice');
      expect(result.current.isAuthenticated).toBe(true);
    });
  });

  describe('useApp', () => {
    it('returns app metadata', () => {
      const config = createMockConfig();
      const { result } = renderHook(() => useApp(), { wrapper: createWrapper(config) });
      expect(result.current.appId).toBe('test-app');
      expect(result.current.appName).toBe('Test App');
      expect(result.current.appDescription).toBe('A test');
    });
  });

  describe('useSession', () => {
    it('returns session info', () => {
      const config = createMockConfig();
      const { result } = renderHook(() => useSession(), { wrapper: createWrapper(config) });
      expect(result.current.sessionId).toBe('sess-123');
      expect(result.current.isConnected).toBe(true);
    });
  });

  describe('useAction', () => {
    it('returns a fire function', () => {
      const config = createMockConfig();
      const { result } = renderHook(() => useAction('sendMessage'), { wrapper: createWrapper(config) });
      expect(typeof result.current).toBe('function');
    });

    it('calls dispatch with action name and data', () => {
      const dispatch = vi.fn();
      const config = createMockConfig({ dispatch });
      const { result } = renderHook(() => useAction<{ text: string }>('sendMessage'), { wrapper: createWrapper(config) });

      act(() => {
        result.current({ text: 'hello' });
      });

      expect(dispatch).toHaveBeenCalledWith('sendMessage', { text: 'hello' });
    });
  });

  describe('useStream', () => {
    it('returns { latest: null, all: [] } initially', () => {
      const config = createMockConfig();
      const { result } = renderHook(() => useStream('message'), { wrapper: createWrapper(config) });
      expect(result.current.latest).toBeNull();
      expect(result.current.all).toEqual([]);
    });

    it('calls subscribe with event type', () => {
      const subscribe = vi.fn(() => vi.fn());
      const config = createMockConfig({ subscribe });
      renderHook(() => useStream('message'), { wrapper: createWrapper(config) });
      expect(subscribe).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('append mode — accumulates deliveries', () => {
      let capturedHandler: ((delivery: StreamDelivery<{ text: string }>) => void) | null = null;
      const subscribe = vi.fn((_: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return vi.fn();
      });
      const config = createMockConfig({ subscribe });
      const { result } = renderHook(
        () => useStream<{ text: string }>('message'),
        { wrapper: createWrapper(config) },
      );

      expect(capturedHandler).not.toBeNull();

      act(() => {
        capturedHandler!({ payload: { text: 'hello' }, mode: 'append' });
      });
      expect(result.current.latest).toEqual({ text: 'hello' });
      expect(result.current.all).toEqual([{ text: 'hello' }]);
      expect(result.current.isComplete).toBe(false);

      act(() => {
        capturedHandler!({ payload: { text: 'world' }, mode: 'append' });
      });
      expect(result.current.latest).toEqual({ text: 'world' });
      expect(result.current.all).toEqual([{ text: 'hello' }, { text: 'world' }]);
      expect(result.current.isComplete).toBe(false);
    });

    it('replace mode — collapses all to single-latest', () => {
      let capturedHandler: ((delivery: StreamDelivery<{ total: number }>) => void) | null = null;
      const subscribe = vi.fn((_: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return vi.fn();
      });
      const config = createMockConfig({ subscribe });
      const { result } = renderHook(
        () => useStream<{ total: number }>('snapshot'),
        { wrapper: createWrapper(config) },
      );

      act(() => {
        capturedHandler!({ payload: { total: 1 }, mode: 'append' });
      });
      expect(result.current.all).toEqual([{ total: 1 }]);

      act(() => {
        capturedHandler!({ payload: { total: 42 }, mode: 'replace' });
      });
      expect(result.current.latest).toEqual({ total: 42 });
      // replace collapses: only the latest value survives in `.all`.
      expect(result.current.all).toEqual([{ total: 42 }]);
    });

    it('complete=true flips isComplete to true', () => {
      let capturedHandler: ((delivery: StreamDelivery<{ token: string }>) => void) | null = null;
      const subscribe = vi.fn((_: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return vi.fn();
      });
      const config = createMockConfig({ subscribe });
      const { result } = renderHook(
        () => useStream<{ token: string }>('finale'),
        { wrapper: createWrapper(config) },
      );

      act(() => {
        capturedHandler!({ payload: { token: 'a' }, mode: 'append' });
      });
      expect(result.current.isComplete).toBe(false);

      act(() => {
        capturedHandler!({
          payload: { token: 'b' },
          mode: 'append',
          complete: true,
        });
      });
      expect(result.current.isComplete).toBe(true);
      expect(result.current.latest).toEqual({ token: 'b' });
    });
  });

  // `useWiredTool` retired 2026-05-11 alongside the EE+ wire-shape v2.
  // agentTools is now a CATALOG the AGENT invokes — there is no
  // component-side hook surface (no `useAgentTool` replacement). User
  // gestures fire via `useAction(name)` and the optional `nextStep`
  // field on the action entry names the tool the agent SHOULD invoke
  // on its next turn.
  //
  // `useClientTool` and `registerClientTool` retired 2026-05-11
  // (commit 4 of EE+ wire-shape-v2). The `clientCapabilities` reframe
  // owns the new mechanism — browser-capability hooks live in
  // `@ggui-ai/gadgets`, not on the WireConfig surface.

  describe('hooks throw without provider', () => {
    it('useAuth throws without GguiWireProvider', () => {
      expect(() => {
        renderHook(() => useAuth());
      }).toThrow(/WireProvider/);
    });
  });
});
