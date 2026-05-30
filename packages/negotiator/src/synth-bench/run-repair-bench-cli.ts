#!/usr/bin/env node
/**
 * Repair bench CLI — live round-trip-quality probe.
 *
 * Runs the production forgiving-handshake create-path
 * (`ensureConformingContract`) over REPAIR_CORPUS and reports the
 * round-trip-usable rate — the contract-quality number the shape bench
 * (bench-synth) cannot see. Reads ~/.ggui/credentials.json (or
 * ANTHROPIC_API_KEY) for the key.
 *
 * Costs ~$0.001 per repaired entry on Haiku 4.5 (clean drafts hit the
 * lint-clean fast path and make NO LLM call). NOT run in CI; opt-in.
 *
 * Usage:
 *   pnpm -F @ggui-ai/negotiator bench-repair
 *   pnpm -F @ggui-ai/negotiator bench-repair -- --limit 1
 *   pnpm -F @ggui-ai/negotiator bench-repair -- --json > repair-report.json
 *   ANTHROPIC_API_KEY=sk-... pnpm -F @ggui-ai/negotiator bench-repair
 *
 * Bench-only — not exported from the package index.
 */
import {
  evaluateRepairCorpus,
  formatRepairBenchReport,
} from './run-repair-bench.js';
import {
  DEFAULT_MODEL,
  HAIKU_4_5_PRICE_INPUT_PER_TOKEN,
  HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN,
  buildAnthropicLlmCaller,
  getTokenUsage,
  resolveAnthropicKey,
} from './cli-llm.js';

interface CliArgs {
  limit?: number;
  model: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let limit: number | undefined;
  let model = DEFAULT_MODEL;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) {
      limit = Number(argv[++i]);
    } else if (a === '--model' && argv[i + 1]) {
      model = argv[++i]!;
    } else if (a === '--json') {
      json = true;
    }
  }
  const result: CliArgs = { model, json };
  if (limit !== undefined) result.limit = limit;
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = resolveAnthropicKey('bench-repair');
  const llm = buildAnthropicLlmCaller(apiKey, args.model);

  if (!args.json) {
    process.stdout.write(`bench-repair: model=${args.model}\n\n`);
  }
  const report = await evaluateRepairCorpus(
    { llm },
    {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      onProgress: args.json
        ? undefined
        : (outcome, idx, total) => {
            const pass =
              outcome.roundTrip !== null
                ? outcome.roundTrip.pass
                : outcome.shape.pass;
            const status = pass ? 'OK ' : 'NO ';
            const id = outcome.entry.id.padEnd(22);
            const origin = `origin:${outcome.origin}`.padEnd(13);
            process.stdout.write(
              `[${status}] ${(idx + 1).toString().padStart(2)}/${total}  ${origin}  ${id}  ${outcome.latencyMs}ms\n`,
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
  process.stdout.write(formatRepairBenchReport(report));
  process.stdout.write('\n\n');

  const usage = getTokenUsage();
  const totalCost =
    usage.input * HAIKU_4_5_PRICE_INPUT_PER_TOKEN +
    usage.output * HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN;
  // Clean drafts (origin agent) make no LLM call — cost is per repaired entry.
  const callsMade = report.totals.originSynth;
  const costPerCall = callsMade === 0 ? 0 : totalCost / callsMade;
  process.stdout.write(
    `Tokens: input=${usage.input} output=${usage.output}\n`,
  );
  process.stdout.write(
    `Cost:   total=$${totalCost.toFixed(4)} per-repair=$${costPerCall.toFixed(4)}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `bench-repair failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
