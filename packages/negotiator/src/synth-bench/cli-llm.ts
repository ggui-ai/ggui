/**
 * Shared CLI LLM plumbing for the synth-bench family of live probes
 * (bench-synth, bench-repair) and the rerank probe CLI. Builds an
 * Anthropic-backed {@link LLMCaller} over the shared structured call,
 * resolves the API key from env or `~/.ggui/credentials.json`, and
 * accumulates token usage for the per-run cost line. Dev tooling run
 * from source: not exported from the package index and not in the
 * published package, so `@ggui-ai/ui-gen` is a devDependency.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import type { LLMCaller, ToolSchema } from '../llm-caller.js';
import { anthropicToolCall } from '@ggui-ai/ui-gen/providers';

/** Default bench model — the model the `ui-gen-default` seed generator declares. */
export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** Haiku 4.5 token pricing (USD per token) for the cost report. */
export const HAIKU_4_5_PRICE_INPUT_PER_TOKEN = 1.0 / 1_000_000;
export const HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN = 5.0 / 1_000_000;

interface CredsFile {
  apps?: { global?: { anthropic?: string } };
}

/**
 * Resolve the Anthropic API key: `ANTHROPIC_API_KEY` env var first, then
 * `~/.ggui/credentials.json` at `apps.global.anthropic`. `scriptName`
 * prefixes the error hints so a failure names the bench that needs it.
 */
export function resolveAnthropicKey(scriptName: string): string {
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey && envKey.length > 0) return envKey;
  const credsPath = pathResolve(homedir(), '.ggui', 'credentials.json');
  let parsed: CredsFile;
  try {
    parsed = JSON.parse(readFileSync(credsPath, 'utf8')) as CredsFile;
  } catch (err) {
    throw new Error(
      `${scriptName}: could not read ${credsPath} (${err instanceof Error ? err.message : String(err)}). Set ANTHROPIC_API_KEY env var or run \`ggui auth set anthropic\`.`,
    );
  }
  const key = parsed.apps?.global?.anthropic;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `${scriptName}: no anthropic key found at apps.global.anthropic in ${credsPath}.`,
    );
  }
  return key;
}

let totalInputTokens = 0;
let totalOutputTokens = 0;

/** Running token usage accumulated across `callStructured` calls in this
 *  process — read after a run for the cost line. */
export function getTokenUsage(): {
  readonly input: number;
  readonly output: number;
} {
  return { input: totalInputTokens, output: totalOutputTokens };
}

/**
 * The dev caller the synth benches and the rerank probe CLI share
 * (Haiku-pinned by default; every CLI takes `--model`). Text mode is not
 * exercised — every consumer uses `callStructured`. The request shape
 * and the named failures are the shared structured call's
 * (`anthropicToolCall` in `@ggui-ai/ui-gen/providers`, ggui#1271).
 */
export function buildAnthropicLlmCaller(
  apiKey: string,
  model: string,
): LLMCaller {
  return {
    async call(): Promise<string> {
      throw new Error(
        'negotiator dev caller: text-mode not exercised — use callStructured',
      );
    },
    async callStructured(
      systemPrompt: string,
      userMessage: string,
      tool: ToolSchema,
      maxTokens?: number,
    ): Promise<unknown> {
      const result = await anthropicToolCall({
        apiKey,
        model,
        systemPrompt,
        userPrompt: userMessage,
        tool,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
      if (result.usage) {
        totalInputTokens += result.usage.input;
        totalOutputTokens += result.usage.output;
      }
      return result.input;
    },
  };
}
