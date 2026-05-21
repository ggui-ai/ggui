// packages/ui-gen/src/adapters/claude/sdk.ts
//
// Claude adapter using the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
// Uses query() async iterator with MCP servers for tool execution.
//
// Two modes:
// 1. Pre-configured MCP servers (production) — pass mcpServers in ClaudeSdkConfig
// 2. Direct tools (benchmark) — ToolDefinition[] auto-bridged to in-process MCP server

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { GeneratorAdapter, hasCredentials } from '../base';
import type { ClaudeSdkConfig, GenerateParams } from '../base';
import type { AdapterResult, ProviderName, AdapterMode } from '../types';
import { createArtifacts, processMessage } from './message-parser';
import { createToolMcpServer } from './tool-bridge';

export class ClaudeSdkAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'claude';
  readonly mode: AdapterMode = 'sdk';
  readonly displayName = 'Claude (Agent SDK)';

  constructor(config: ClaudeSdkConfig = {}) {
    super(config);
  }

  /** Narrowed config access for Claude SDK-specific fields. */
  private get sdkConfig(): ClaudeSdkConfig {
    return this.config as ClaudeSdkConfig;
  }

  isAvailable(): boolean {
    return hasCredentials(this.config, 'ANTHROPIC_API_KEY');
  }

  async generate(params: GenerateParams): Promise<AdapterResult> {
    const startTime = Date.now();
    const cfg = this.sdkConfig;

    // Dynamic import to avoid loading claude-agent-sdk in non-Claude contexts
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // Build environment from config or process.env
    const env = buildEnv(cfg.env);

    const artifacts = createArtifacts();
    const onProgress = cfg.onProgress;

    // Determine MCP servers — use config's servers or bridge from tools
    let mcpServers: Record<string, McpServerConfig> | undefined = cfg.mcpServers;
    let allowedTools: string[] | undefined = cfg.allowedTools;

    if (!mcpServers && params.tools.length > 0) {
      // Bridge ToolDefinition[] to in-process MCP server
      const bridge = await createToolMcpServer(params.tools);
      mcpServers = { ggui: bridge.server };
      allowedTools = bridge.allowedToolNames;
    }

    // Run SDK query — message parsing is handled by processMessage()
    for await (const message of query({
      prompt: params.userPrompt,
      options: {
        cwd: cfg.cwd,
        env,
        model: params.model,
        maxTurns: params.maxTurns,
        systemPrompt: params.systemPrompt,
        ...(mcpServers && { mcpServers }),
        ...(cfg.agents && { agents: cfg.agents }),
        ...(allowedTools && { allowedTools }),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(cfg.cliPath && { pathToClaudeCodeExecutable: cfg.cliPath }),
        ...(cfg.stderr && { stderr: cfg.stderr }),
      },
    })) {
      processMessage(
        message,
        artifacts,
        onProgress,
        params.maxTurns,
      );
    }

    const generationTimeMs = Date.now() - startTime;

    // Cache audit telemetry. Track whether the Claude Agent SDK is
    // actually caching the system prompt
    // across turns. `read > 0` on turn 2+ means the SDK's internal
    // cache_control is firing. `read = 0` across all turns = we're
    // paying full input cost every turn; explicit cache_control needed.
    const totalCacheIn = artifacts.inputTokens + artifacts.cacheCreationTokens + artifacts.cacheReadTokens;
    const cacheReadPct = totalCacheIn > 0
      ? Math.round((artifacts.cacheReadTokens / totalCacheIn) * 100)
      : 0;
    console.log(
      `[claude-sdk] cache: created=${artifacts.cacheCreationTokens} read=${artifacts.cacheReadTokens} input=${artifacts.inputTokens} output=${artifacts.outputTokens} turns=${artifacts.turnCount} cache-read-pct=${cacheReadPct}%`,
    );

    if (!artifacts.compiledCode) {
      const wasExhausted = artifacts.turnCount >= params.maxTurns;
      throw new Error(
        wasExhausted
          ? `Generation used all ${params.maxTurns} turns without producing compiled code.`
          : 'Generation completed without compiled code',
      );
    }

    return {
      compiledCode: artifacts.compiledCode,
      sourceCode: artifacts.sourceCode,
      tokens: {
        input: artifacts.inputTokens,
        output: artifacts.outputTokens,
        total:
          artifacts.inputTokens +
          artifacts.cacheCreationTokens +
          artifacts.cacheReadTokens +
          artifacts.outputTokens,
      },
      generationTimeMs,
      turnsUsed: artifacts.turnCount,
      rawCostUsd: artifacts.estimatedCostUsd,
      stream: artifacts.stream,
      generatorMeta: artifacts.generatorMeta,
      subagentsUsed: artifacts.subagentsUsed,
      cacheCreationTokens: artifacts.cacheCreationTokens,
      cacheReadTokens: artifacts.cacheReadTokens,
      sdkSessionId: artifacts.sdkSessionId,
    };
  }
}

function buildEnv(configEnv?: Record<string, string>): Record<string, string> {
  if (configEnv) return sanitizeEnv({ ...configEnv });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return sanitizeEnv(env);
}

/**
 * Remove env vars that would redirect the SDK subprocess to a non-running proxy.
 * The SDK subprocess must connect to the real Anthropic API.
 */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  // Strip ANTHROPIC_BASE_URL if it points to localhost (LiteLLM proxy)
  // — the SDK subprocess should always use the real Anthropic API
  if (env.ANTHROPIC_BASE_URL?.includes('localhost')) {
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}
