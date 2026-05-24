// packages/ui-gen/src/adapters/base.ts
//
// Abstract base class for all generator adapters.

import type { McpServerConfig, AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { JsonObject } from '@ggui-ai/protocol';
import type { AdapterResult, ToolDefinition, ProviderName, AdapterMode } from './types';

/**
 * Core configuration shared by all adapters.
 */
export interface AdapterConfig {
  /** API key for the provider (BYOK) */
  apiKey?: string;
  /** Use Bedrock instead of direct API (Claude only) */
  useBedrock?: boolean;
}

/**
 * Extended configuration for Claude Agent SDK adapter.
 * Separated from AdapterConfig to avoid polluting the base interface
 * with provider-specific concerns.
 */
export interface ClaudeSdkConfig extends AdapterConfig {
  /** Working directory for SDK subprocess */
  cwd?: string;
  /** Environment variables for SDK subprocess */
  env?: Record<string, string>;
  /** MCP server configs for Claude Agent SDK (keyed by name) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Allowed tool names for Claude Agent SDK */
  allowedTools?: string[];
  /** Subagent definitions for Claude Agent SDK */
  agents?: Record<string, AgentDefinition>;
  /** Custom CLI path for Docker deployments */
  cliPath?: string;
  /** stderr callback for debug logging */
  stderr?: (data: string) => void;
  /** Progress callback */
  onProgress?: (event: { type: string; [key: string]: unknown }) => void;
}

/**
 * Union config type — adapters accept their specific config
 * but the registry uses this union so callers can pass any config.
 */
export type AnyAdapterConfig = AdapterConfig | ClaudeSdkConfig;

/**
 * Parameters for a single generation run.
 */
export interface GenerateParams {
  /** System prompt (HOW to build — shared across all SDKs) */
  systemPrompt: string;
  /** User prompt (WHAT to build — the specific request) */
  userPrompt: string;
  /** Model identifier (provider-native format, e.g., 'claude-sonnet-4-6') */
  model: string;
  /** SDK-agnostic tool definitions */
  tools: ToolDefinition[];
  /** Maximum agentic loop turns */
  maxTurns: number;
  /** Model-specific options (e.g., speed_priority for Claude fast mode) */
  modelOptions?: JsonObject;
}

/**
 * Abstract base class for generator adapters.
 *
 * Each adapter wraps a specific provider SDK (Claude, OpenAI, Google)
 * in either raw API mode or agent SDK mode, and implements the tool-use
 * loop using the SDK's native API. All adapters produce the same
 * output format (AdapterResult).
 */
export abstract class GeneratorAdapter {
  abstract readonly provider: ProviderName;
  abstract readonly mode: AdapterMode;
  abstract readonly displayName: string;

  constructor(protected readonly config: AnyAdapterConfig) {}

  /**
   * Run UI generation with the given tools, prompt, and model.
   */
  abstract generate(params: GenerateParams): Promise<AdapterResult>;

  /**
   * Check if this adapter can run (SDK installed, credentials available).
   */
  abstract isAvailable(): boolean;

  /**
   * Map a LiteLLM-format model ID to this SDK's native format.
   * Default: strips the provider prefix (e.g., 'anthropic/claude-sonnet-4-6' -> 'claude-sonnet-4-6').
   * Override only if the prefix convention differs.
   */
  resolveModelId(litellmModelId: string): string {
    return stripModelPrefix(litellmModelId);
  }
}

/**
 * Strip provider prefix from LiteLLM-format model IDs.
 * 'anthropic/claude-sonnet-4-6' -> 'claude-sonnet-4-6'
 * 'openai/gpt-5.3-codex' -> 'gpt-5.3-codex'
 * 'gemini/gemini-3-flash-preview' -> 'gemini-3-flash-preview'
 */
function stripModelPrefix(modelId: string): string {
  const slashIndex = modelId.indexOf('/');
  return slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId;
}

/**
 * Check if credentials are available from config or environment variables.
 */
export function hasCredentials(
  config: AdapterConfig,
  ...envVarNames: string[]
): boolean {
  if (config.apiKey) return true;
  if (config.useBedrock) return true;
  return envVarNames.some((name) => !!process.env[name]);
}
