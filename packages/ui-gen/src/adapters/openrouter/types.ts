// packages/ui-gen/src/adapters/openrouter/types.ts
//
// OpenRouter-specific types for the chat completion API.
// Reference: https://openrouter.ai/docs/api-reference

import type { JsonObject } from '@ggui-ai/protocol';

// =============================================================================
// Model metadata (from GET /api/v1/models)
// =============================================================================

/** Model entry from OpenRouter's /api/v1/models endpoint */
export interface OpenRouterModelEntry {
  id: string;
  name: string;
  description: string;
  pricing: { prompt: string; completion: string; image?: string };
  context_length: number;
  architecture: {
    modality: string;
    tokenizer: string;
    instruct_type: string | null;
  };
  top_provider: {
    context_length: number;
    max_completion_tokens: number;
    is_moderated: boolean;
  };
  per_request_limits: Record<string, string> | null;
}

// =============================================================================
// Chat Completion API
// =============================================================================

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenRouterContentBlock[] | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
}

export interface OpenRouterContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

export interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterMessage[];
  tools?: OpenRouterTool[];
  tool_choice?: 'auto' | 'required' | 'none';
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  thinking?: { type: 'enabled'; budget_tokens: number };
}

export interface OpenRouterChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenRouterToolCall[];
      thinking?: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// =============================================================================
// SSE Streaming
// =============================================================================

export interface OpenRouterStreamDelta {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: OpenRouterChatResponse['usage'];
}

// =============================================================================
// Error
// =============================================================================

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }

  get isTransient(): boolean {
    return this.status === 408 || this.status === 429
      || this.status === 502 || this.status === 503;
  }
}
