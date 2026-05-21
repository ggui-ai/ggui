#!/usr/bin/env node
/**
 * Rerank quality probe CLI.
 *
 * Reads `~/.ggui/credentials.json` for the Anthropic API key, runs
 * the probe against `claude-haiku-4-5`, prints the report.
 *
 * Usage:
 *   pnpm -F @ggui-ai/negotiator probe-rerank
 *   ANTHROPIC_API_KEY=sk-... pnpm -F @ggui-ai/negotiator probe-rerank
 *   pnpm -F @ggui-ai/negotiator probe-rerank -- --limit 5
 *
 * Cost: ~$0.025 for the full 25-pair run with Haiku 4.5.
 *
 * Eval-only — not exported from the package index.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { runProbe, formatReport } from './run-probe.js';
import type { LLMCaller, ToolSchema } from '../llm-caller.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5';

interface CredsFile {
  apps?: { global?: { anthropic?: string } };
}

function resolveAnthropicKey(): string {
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey && envKey.length > 0) return envKey;
  const credsPath = pathResolve(homedir(), '.ggui', 'credentials.json');
  let parsed: CredsFile;
  try {
    parsed = JSON.parse(readFileSync(credsPath, 'utf8')) as CredsFile;
  } catch (err) {
    throw new Error(
      `probe-rerank: could not read ${credsPath} (${err instanceof Error ? err.message : String(err)}). Set ANTHROPIC_API_KEY env var or run \`ggui auth set anthropic\`.`,
    );
  }
  const key = parsed.apps?.global?.anthropic;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `probe-rerank: no anthropic key found at apps.global.anthropic in ${credsPath}.`,
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

function buildAnthropicLlmCaller(apiKey: string, model: string): LLMCaller {
  return {
    async call(): Promise<string> {
      throw new Error('probe-cli: text-mode not exercised — use callStructured');
    },
    async callStructured<T>(
      systemPrompt: string,
      userMessage: string,
      tool: ToolSchema,
      maxTokens?: number,
    ): Promise<T> {
      const body = {
        model,
        max_tokens: maxTokens ?? 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        tools: [
          {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          },
        ],
        tool_choice: { type: 'tool', name: tool.name },
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

function parseArgs(argv: readonly string[]): { limit?: number; threshold?: number; model: string } {
  let limit: number | undefined;
  let threshold: number | undefined;
  let model = DEFAULT_MODEL;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) {
      limit = Number(argv[++i]);
    } else if (a === '--threshold' && argv[i + 1]) {
      threshold = Number(argv[++i]);
    } else if (a === '--model' && argv[i + 1]) {
      model = argv[++i]!;
    }
  }
  const result: { limit?: number; threshold?: number; model: string } = { model };
  if (limit !== undefined) result.limit = limit;
  if (threshold !== undefined) result.threshold = threshold;
  return result;
}

// Approximate Haiku 4.5 pricing as of 2026-05.
// Input: $1.00 / Mtok, output: $5.00 / Mtok.
const HAIKU_4_5_PRICE_INPUT_PER_TOKEN = 1.0 / 1_000_000;
const HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN = 5.0 / 1_000_000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = resolveAnthropicKey();
  const llm = buildAnthropicLlmCaller(apiKey, args.model);

  process.stdout.write(`probe: model=${args.model}\n\n`);
  const report = await runProbe(
    { llm },
    {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
      onProgress: (outcome, idx, total) => {
        const status = outcome.correct ? 'OK ' : 'NO ';
        const conf = outcome.decision.confidence.toFixed(2);
        const id = outcome.pair.id.padEnd(24);
        process.stdout.write(
          `[${status}] ${(idx + 1).toString().padStart(2)}/${total}  ${id}  conf=${conf}  pred=${outcome.predictedMatchId ?? 'null'}  gold=${outcome.pair.goldMatchId ?? 'null'}\n`,
        );
      },
    },
  );

  process.stdout.write('\n');
  process.stdout.write(formatReport(report));
  process.stdout.write('\n\n');

  const totalCost =
    totalInputTokens * HAIKU_4_5_PRICE_INPUT_PER_TOKEN +
    totalOutputTokens * HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN;
  const callsMade = report.outcomes.filter(
    (o) => !/short-circuited/.test(o.decision.reason),
  ).length;
  const costPerCall = callsMade === 0 ? 0 : totalCost / callsMade;
  process.stdout.write(
    `Tokens:         input=${totalInputTokens} · output=${totalOutputTokens}\n`,
  );
  process.stdout.write(
    `Cost:           total=$${totalCost.toFixed(4)} · per-call=$${costPerCall.toFixed(4)}\n`,
  );
  process.stdout.write(
    `  G4 cost ≤ $0.002/call →  ${costPerCall <= 0.002 ? 'PASS' : 'FAIL'} ($${costPerCall.toFixed(4)})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `probe-rerank failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
