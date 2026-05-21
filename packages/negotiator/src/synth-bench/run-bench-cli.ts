#!/usr/bin/env node
/**
 * Synthesizer bench CLI — live LLM probe.
 *
 * Reads ~/.ggui/credentials.json for the Anthropic API key, runs
 * synthesizeContract over BENCH_CORPUS, prints per-shape precision
 * + the redundant-action firing count + p50/p95 latency.
 *
 * Costs ~$0.001 per entry on Haiku 4.5 → roughly $0.05 for the full
 * 50+ corpus run. NOT run in CI; opt-in only.
 *
 * Usage:
 *   pnpm -F @ggui-ai/negotiator bench-synth
 *   pnpm -F @ggui-ai/negotiator bench-synth -- --limit 10
 *   pnpm -F @ggui-ai/negotiator bench-synth -- --shape context+action
 *   ANTHROPIC_API_KEY=sk-... pnpm -F @ggui-ai/negotiator bench-synth
 *   pnpm -F @ggui-ai/negotiator bench-synth -- --json > report.json
 *
 * Bench-only — not exported from the package index.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { evaluateAgainstCorpus, formatBenchReport } from './run-bench.js';
import type { LLMCaller, ToolSchema } from '../llm-caller.js';
import { contractShape } from './corpus.js';

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
      `bench-synth: could not read ${credsPath} (${err instanceof Error ? err.message : String(err)}). Set ANTHROPIC_API_KEY env var or run \`ggui auth set anthropic\`.`,
    );
  }
  const key = parsed.apps?.global?.anthropic;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `bench-synth: no anthropic key found at apps.global.anthropic in ${credsPath}.`,
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
      throw new Error('bench-synth: text-mode not exercised — synth uses callStructured');
    },
    async callStructured<T>(
      systemPrompt: string,
      userMessage: string,
      tool: ToolSchema,
      maxTokens?: number,
    ): Promise<T> {
      // `temperature` deprecated on Haiku 4.5+ — Anthropic rejects with
      // HTTP 400. `tool_choice: { type: 'tool', name }` below already
      // binds output to the input_schema; residual stochasticity stays
      // bounded via canonical-key normalization downstream.
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

const SHAPE_FILTERS = [
  'props-only',
  'context-only',
  'context+action',
  'stream',
  'with-gadgets',
  'empty',
] as const;

interface CliArgs {
  limit?: number;
  shapeFilter?: string;
  model: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let limit: number | undefined;
  let shapeFilter: string | undefined;
  let model = DEFAULT_MODEL;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) {
      limit = Number(argv[++i]);
    } else if (a === '--shape' && argv[i + 1]) {
      const v = argv[++i]!;
      if ((SHAPE_FILTERS as readonly string[]).includes(v)) {
        shapeFilter = v;
      } else {
        throw new Error(
          `unknown shape: ${v} (expected one of ${SHAPE_FILTERS.join(', ')})`,
        );
      }
    } else if (a === '--model' && argv[i + 1]) {
      model = argv[++i]!;
    } else if (a === '--json') {
      json = true;
    }
  }
  const result: CliArgs = { model, json };
  if (limit !== undefined) result.limit = limit;
  if (shapeFilter !== undefined) result.shapeFilter = shapeFilter;
  return result;
}

const HAIKU_4_5_PRICE_INPUT_PER_TOKEN = 1.0 / 1_000_000;
const HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN = 5.0 / 1_000_000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = resolveAnthropicKey();
  const llm = buildAnthropicLlmCaller(apiKey, args.model);

  if (!args.json) {
    process.stdout.write(`bench-synth: model=${args.model}\n\n`);
  }
  const report = await evaluateAgainstCorpus(
    { llm },
    {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.shapeFilter !== undefined
        ? { shapeFilter: args.shapeFilter }
        : {}),
      onProgress: args.json
        ? undefined
        : (outcome, idx, total) => {
            const status = outcome.score.pass ? 'OK ' : 'NO ';
            const id = outcome.entry.id.padEnd(28);
            const shape = contractShape(outcome.entry.expected).padEnd(16);
            process.stdout.write(
              `[${status}] ${(idx + 1).toString().padStart(2)}/${total}  ${shape}  ${id}  ${outcome.latencyMs}ms\n`,
            );
          },
    },
  );

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2));
    process.stdout.write('\n');
    return;
  }

  process.stdout.write('\n');
  process.stdout.write(formatBenchReport(report));
  process.stdout.write('\n\n');

  const totalCost =
    totalInputTokens * HAIKU_4_5_PRICE_INPUT_PER_TOKEN +
    totalOutputTokens * HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN;
  const callsMade = report.totals.all - report.totals.synthDeclined;
  const costPerCall = callsMade === 0 ? 0 : totalCost / callsMade;
  process.stdout.write(
    `Tokens: input=${totalInputTokens} output=${totalOutputTokens}\n`,
  );
  process.stdout.write(
    `Cost:   total=$${totalCost.toFixed(4)} per-call=$${costPerCall.toFixed(4)}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `bench-synth failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
