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
import { evaluateAgainstCorpus, formatBenchReport } from './run-bench.js';
import { contractShape } from './corpus.js';
import {
  DEFAULT_MODEL,
  HAIKU_4_5_PRICE_INPUT_PER_TOKEN,
  HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN,
  buildAnthropicLlmCaller,
  getTokenUsage,
  resolveAnthropicKey,
} from './cli-llm.js';

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = resolveAnthropicKey('bench-synth');
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

  const usage = getTokenUsage();
  const totalCost =
    usage.input * HAIKU_4_5_PRICE_INPUT_PER_TOKEN +
    usage.output * HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN;
  const callsMade = report.totals.all - report.totals.synthDeclined;
  const costPerCall = callsMade === 0 ? 0 : totalCost / callsMade;
  process.stdout.write(
    `Tokens: input=${usage.input} output=${usage.output}\n`,
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
