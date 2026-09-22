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
import { runProbe, formatReport } from './run-probe.js';
import {
  buildAnthropicLlmCaller,
  getTokenUsage,
  resolveAnthropicKey,
} from '../synth-bench/cli-llm.js';

const DEFAULT_MODEL = 'claude-haiku-4-5';

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
  const apiKey = resolveAnthropicKey('probe-rerank');
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

  const usage = getTokenUsage();
  const totalCost =
    usage.input * HAIKU_4_5_PRICE_INPUT_PER_TOKEN +
    usage.output * HAIKU_4_5_PRICE_OUTPUT_PER_TOKEN;
  const callsMade = report.outcomes.filter(
    (o) => !/short-circuited/.test(o.decision.reason),
  ).length;
  const costPerCall = callsMade === 0 ? 0 : totalCost / callsMade;
  process.stdout.write(
    `Tokens:         input=${usage.input} · output=${usage.output}\n`,
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
