/**
 * Shared CLI LLM plumbing for the synth-bench family of live probes
 * (bench-synth, bench-repair). Builds an Anthropic-backed
 * {@link LLMCaller} with forced tool-use, resolves the API key from env
 * or `~/.ggui/credentials.json`, and accumulates token usage for the
 * per-run cost line. Bench-only — not exported from the package index.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import type { LLMCaller, ToolSchema } from '../llm-caller.js';
import { anthropicRejectsForcedToolChoice } from '@ggui-ai/protocol';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

/** Default bench model — the model the `ui-gen-default` seed generator declares. */
export const DEFAULT_MODEL = 'claude-haiku-4-5';

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

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?: { type?: string; message?: string };
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
 * Thinking budget added to the caller's answer budget for a model that
 * refuses a forced tool (ggui#1264). Same value and reason as the
 * negotiator's production caller in `@ggui-ai/mcp-server`; the three
 * copies are consolidated under ggui#1271.
 */
const ALWAYS_THINKING_HEADROOM_TOKENS = 16_000;

/**
 * The dev caller the synth benches and the rerank probe CLI share
 * (Haiku-pinned by default; every CLI takes `--model`). Text mode is not
 * exercised — every consumer uses `callStructured`.
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
    async callStructured<T>(
      systemPrompt: string,
      userMessage: string,
      tool: ToolSchema,
      maxTokens?: number,
    ): Promise<T> {
      // `temperature` deprecated on Haiku 4.5+ — Anthropic rejects with
      // HTTP 400. Residual stochasticity stays bounded via canonical-key
      // normalization downstream.
      //
      // ggui#1264 — a forced `tool_choice` only where the model accepts
      // one. The always-thinking models (`@ggui-ai/protocol`
      // `anthropicRejectsForcedToolChoice`) 400 on it, so they get
      // `auto` + at most one call + the tool named in the system prompt,
      // and thinking headroom on top of the answer budget (their thinking
      // counts against `max_tokens` and comes first).
      const refusesForcedTool = anthropicRejectsForcedToolChoice(model);
      const answerBudget = maxTokens ?? 1024;
      const body = {
        model,
        max_tokens: refusesForcedTool
          ? answerBudget + ALWAYS_THINKING_HEADROOM_TOKENS
          : answerBudget,
        system: refusesForcedTool
          ? `${systemPrompt}\n\nAnswer by calling the \`${tool.name}\` tool exactly once. Do not answer in text.`
          : systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        tools: [
          {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          },
        ],
        tool_choice: refusesForcedTool
          ? { type: 'auto', disable_parallel_tool_use: true }
          : { type: 'tool', name: tool.name },
      };
      const res = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as AnthropicResponse;
      if (!res.ok) {
        const errType = json.error?.type ?? 'unknown';
        const errMsg = json.error?.message ?? `HTTP ${res.status}`;
        throw new Error(`anthropic ${errType}: ${errMsg}`);
      }
      if (json.usage) {
        totalInputTokens += json.usage.input_tokens ?? 0;
        totalOutputTokens += json.usage.output_tokens ?? 0;
      }
      const toolBlock = json.content?.find((b) => b.type === 'tool_use');
      if (!toolBlock || toolBlock.input === undefined) {
        throw new Error(
          `anthropic: no tool_use block in response (stop_reason=${json.stop_reason ?? 'unknown'})`,
        );
      }
      return toolBlock.input as T;
    },
  };
}
