/**
 * useGenerate — Manual UI generation hook.
 *
 * Allows developers to programmatically trigger component generation
 * without going through the full agent MCP flow. Supports typed
 * predefined blueprints and freeform natural language prompts.
 *
 * Usage:
 *   const { generate, isGenerating, stack } = useGenerate({ sessionId });
 *
 *   // Typed predefined blueprint (strategy defaults to 'strict')
 *   await generate('data-table', { data: { columns: [...], data: [...] } });
 *
 *   // Freeform generation (must use 'balanced' or 'creative' strategy)
 *   await generate('A weather card for Tokyo', { strategy: 'creative' });
 *
 * NOTE: This hook creates its own WebSocket connection to the session.
 * Do NOT use it alongside GguiSession for the same sessionId — that
 * would create two WebSocket connections. Use useGenerate as a standalone
 * alternative to GguiSession for developer-driven (non-agent) generation.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  SessionStackEntry,
  StackItem,
  GeneratePayload,
  GenerationStrategy,
} from '@ggui-ai/protocol';
import { useGguiContext } from '../context/GguiContext';
import { useWebSocket } from './useWebSocket';

export interface UseGenerateOptions {
  /** Session ID to generate into. */
  sessionId: string;
}

export interface GenerateOptions<TProps = unknown, TContext = unknown> {
  /**
   * Generation strategy.
   * - 'strict': Only use predefined/cached blueprints (default for blueprint names)
   * - 'balanced': Try blueprint, fall back to LLM generation (default for freeform)
   * - 'creative': Always generate fresh via LLM
   */
  strategy?: GenerationStrategy;
  /** Props data to pass to the blueprint. */
  data?: TProps;
  /** Additional context for the generation. */
  context?: TContext;
}

export interface GenerateResult {
  /** The generated stack item. `generate()` only produces component
   * variants — MCP Apps iframes are agent-pushed, not developer-
   * generated — so this is the narrow {@link StackItem} shape, not
   * the union. */
  stackItem: StackItem;
  /** How the UI was resolved (blueprint match or generation). */
  matchType?: string;
}

export interface UseGenerateReturn {
  /**
   * Generate a UI component.
   *
   * @param promptOrBlueprint - A predefined blueprint name or freeform prompt.
   * @param options - Generation options (strategy, data, context).
   * @returns The generated stack item.
   */
  generate: (promptOrBlueprint: string, options?: GenerateOptions) => Promise<GenerateResult>;
  /** Whether a generation is currently in progress. */
  isGenerating: boolean;
  /** Current session stack (populated from WebSocket messages). May
   * include both generated components and embedded MCP Apps iframes. */
  stack: SessionStackEntry[];
  /** Last generation error, if any. */
  error: Error | null;
}

export function useGenerate({ sessionId }: UseGenerateOptions): UseGenerateReturn {
  const { appId, wsEndpoint, interfaceContext } = useGguiContext();
  const [isGenerating, setIsGenerating] = useState(false);
  const [stack, setStack] = useState<SessionStackEntry[]>([]);
  const [error, setError] = useState<Error | null>(null);

  // Pending generation promise resolver
  const resolverRef = useRef<{
    resolve: (result: GenerateResult) => void;
    reject: (error: Error) => void;
    requestId: string;
  } | null>(null);

  const handleMessage = useCallback((message: WebSocketMessage) => {
    if (message.type === 'ack' && !resolverRef.current) {
      // Subscribe ack — populate initial stack
      if (message.payload.stack) {
        setStack(message.payload.stack);
      }
    }

    if (message.type === 'push') {
      const { stackItem, matchType } = message.payload;
      if (stackItem) {
        setStack((prev) => {
          const idx = prev.findIndex((item) => item.id === stackItem.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = stackItem;
            return next;
          }
          return [...prev, stackItem];
        });

        // Resolve pending generation. `generate()` only ever resolves
        // on a COMPONENT variant — MCP Apps iframes + system cards are
        // server-pushed via different paths and never fulfill a
        // developer's `generate()` promise.
        if (
          resolverRef.current &&
          stackItem.type !== 'mcpApps' &&
          stackItem.type !== 'system'
        ) {
          resolverRef.current.resolve({ stackItem, matchType });
          resolverRef.current = null;
          setIsGenerating(false);
        }
      }
    }

    if (message.type === 'error') {
      const err = new Error(message.payload.message);
      setError(err);

      if (resolverRef.current) {
        resolverRef.current.reject(err);
        resolverRef.current = null;
        setIsGenerating(false);
      }
    }
  }, []);

  const { send, status: connectionStatus } = useWebSocket({
    url: wsEndpoint || '',
    sessionId,
    appId,
    onMessage: handleMessage,
  });

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (resolverRef.current) {
        resolverRef.current.reject(new Error('Component unmounted during generation'));
        resolverRef.current = null;
      }
    };
  }, []);

  const generate = useCallback(
    (promptOrBlueprint: string, options?: GenerateOptions): Promise<GenerateResult> => {
      if (connectionStatus !== 'connected') {
        return Promise.reject(new Error('WebSocket not connected'));
      }

      if (resolverRef.current) {
        return Promise.reject(new Error('Generation already in progress'));
      }

      setError(null);
      setIsGenerating(true);

      const requestId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const payload: GeneratePayload = {
        sessionId,
        prompt: promptOrBlueprint,
        interfaceContext,
        strategy: options?.strategy ?? 'balanced',
        ...(options?.data != null && { data: options.data as GeneratePayload['data'] }),
        ...(options?.context != null && { context: options.context as GeneratePayload['context'] }),
      };

      // If data is provided and no explicit strategy, default to 'strict'
      // (implies the developer knows which template they want)
      if (options?.data && !options?.strategy) {
        payload.strategy = 'strict';
        payload.blueprintName = promptOrBlueprint;
      }

      send({
        type: 'generate',
        payload,
        requestId,
      });

      return new Promise<GenerateResult>((resolve, reject) => {
        resolverRef.current = { resolve, reject, requestId };
      });
    },
    [connectionStatus, sessionId, interfaceContext, send]
  );

  return { generate, isGenerating, stack, error };
}
