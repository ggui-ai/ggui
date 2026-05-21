// packages/ui-gen/src/adapters/openrouter/client.ts
//
// Direct fetch()-based HTTP client for OpenRouter's API.
// No OpenAI SDK dependency — independent implementation.

import type {
  OpenRouterChatRequest,
  OpenRouterChatResponse,
  OpenRouterStreamDelta,
} from './types';
import { OpenRouterError } from './types';

export interface OpenRouterClientConfig {
  apiKey: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: OpenRouterClientConfig) {
    this.baseUrl = config.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
    this.headers = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.siteUrl ?? process.env.OPENROUTER_SITE_URL ?? 'https://ggui.ai',
      'X-Title': config.siteName ?? process.env.OPENROUTER_SITE_NAME ?? 'ggui',
    };
  }

  /**
   * Non-streaming chat completion.
   */
  async chatCompletion(
    params: Omit<OpenRouterChatRequest, 'stream'>,
  ): Promise<OpenRouterChatResponse> {
    const body: OpenRouterChatRequest = { ...params, stream: false };
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const message = (errorBody as { error?: { message?: string } }).error?.message ?? response.statusText;
      throw new OpenRouterError(message, response.status);
    }

    return response.json() as Promise<OpenRouterChatResponse>;
  }

  /**
   * Streaming chat completion via SSE.
   * Yields delta chunks, accumulates the final usage from the last chunk.
   */
  async *chatCompletionStream(
    params: Omit<OpenRouterChatRequest, 'stream'>,
  ): AsyncGenerator<OpenRouterStreamDelta> {
    const body: OpenRouterChatRequest = { ...params, stream: true };
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const message = (errorBody as { error?: { message?: string } }).error?.message ?? response.statusText;
      throw new OpenRouterError(message, response.status);
    }

    if (!response.body) {
      throw new OpenRouterError('No response body for streaming request', 500);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') return;
          if (!trimmed.startsWith('data: ')) continue;

          const json = trimmed.slice('data: '.length);
          try {
            yield JSON.parse(json) as OpenRouterStreamDelta;
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
