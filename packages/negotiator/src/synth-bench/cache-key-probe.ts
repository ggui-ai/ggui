#!/usr/bin/env node
/**
 * Blueprint cache-key stability probe.
 *
 * The handshake blueprint cache hits ONLY on exact canonical-contract
 * equality: `blueprintKey(contract)` = sha256 of `canonicalizeContracts`
 * (RFC 8785), which preserves spec placement, action/slot/tool NAMES and
 * schema shapes (it only normalizes key order / whitespace and strips
 * `description`/`usage`). The semantic/fuzzy match is disabled whenever a
 * contract is present. So two requests for the SAME intent reuse a cached
 * blueprint only if the LLM authored a byte-identical canonical contract
 * both times.
 *
 * This probe synthesizes one intent N times and reports:
 *   1. how many DISTINCT blueprintKeys result (distinct > 1 ⇒ the
 *      exact-key cache structurally cannot hit on re-runs);
 *   2. the KEY-AFFECTING diff — every leaf path where the runs disagree
 *      (descriptions/usage stripped, since the key ignores them) — so we
 *      can see WHETHER the variance is trivial (normalizable: required
 *      order, additionalProperties, optional fields) or semantic
 *      (property names / structure → only a semantic match can bridge it).
 *
 * Usage:
 *   pnpm -F @ggui-ai/negotiator cache-probe -- --intent "my todo items" --n 5
 *   pnpm -F @ggui-ai/negotiator cache-probe -- --n 5 --dump /tmp/cache-probe.json
 */
import { writeFileSync } from 'node:fs';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import type { DataContract } from '@ggui-ai/protocol';
import { synthesizeContract } from '../synthesize-contract.js';
import {
  DEFAULT_MODEL,
  buildAnthropicLlmCaller,
  resolveAnthropicKey,
} from './cli-llm.js';

interface Args {
  intent: string;
  n: number;
  model: string;
  dump?: string;
}

function parseArgs(argv: readonly string[]): Args {
  let intent = 'my todo items';
  let n = 3;
  let model = DEFAULT_MODEL;
  let dump: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--intent' && argv[i + 1]) intent = argv[++i]!;
    else if (a === '--n' && argv[i + 1]) n = Number(argv[++i]);
    else if (a === '--model' && argv[i + 1]) model = argv[++i]!;
    else if (a === '--dump' && argv[i + 1]) dump = argv[++i]!;
  }
  return { intent, n, model, ...(dump !== undefined ? { dump } : {}) };
}

/** One-line canonical-surface summary — the bits blueprintKey is sensitive to. */
function shapeSummary(c: DataContract): string {
  const parts: string[] = [];
  const props = Object.keys(c.propsSpec?.properties ?? {});
  const ctx = Object.keys(c.contextSpec ?? {});
  const act = Object.keys(c.actionSpec ?? {});
  const str = Object.keys(c.streamSpec ?? {});
  const tools = Object.keys(c.agentCapabilities?.tools ?? {});
  if (props.length) parts.push(`props{${props.join(',')}}`);
  if (ctx.length) parts.push(`context{${ctx.join(',')}}`);
  if (act.length) parts.push(`action{${act.join(',')}}`);
  if (str.length) parts.push(`stream{${str.join(',')}}`);
  if (tools.length) parts.push(`tools{${tools.join(',')}}`);
  return parts.join(' ') || '(empty)';
}

/**
 * Flatten a contract to `path → json-encoded leaf`, applying the same
 * domain rule the cache key does: drop string-valued `description` /
 * `usage` (informational — `canonicalizeContracts` strips them). Objects
 * recurse; arrays are encoded whole (order is key-affecting under JCS,
 * which sorts object keys but NOT array elements).
 */
function flattenKeyAffecting(
  value: unknown,
  prefix: string,
  out: Map<string, string>,
): void {
  if (Array.isArray(value)) {
    out.set(prefix, JSON.stringify(value));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'description' || k === 'usage') && typeof v === 'string') {
        continue; // stripped by the cache key
      }
      flattenKeyAffecting(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out.set(prefix, JSON.stringify(value));
}

/** Every leaf path where the N contracts do not all agree, with the
 *  distinct per-run values (or `∅` when a run omits the path). */
function crossRunDiff(
  contracts: readonly DataContract[],
): Array<{ path: string; values: string[] }> {
  const flat = contracts.map((c) => {
    const m = new Map<string, string>();
    flattenKeyAffecting(c, '', m);
    return m;
  });
  const allPaths = new Set<string>();
  for (const m of flat) for (const p of m.keys()) allPaths.add(p);

  const divergent: Array<{ path: string; values: string[] }> = [];
  for (const path of [...allPaths].sort()) {
    const values = flat.map((m) => m.get(path) ?? '∅');
    if (new Set(values).size > 1) divergent.push({ path, values });
  }
  return divergent;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const llm = buildAnthropicLlmCaller(resolveAnthropicKey('cache-probe'), args.model);
  process.stdout.write(
    `cache-probe: intent=${JSON.stringify(args.intent)} n=${args.n} model=${args.model}\n\n`,
  );

  const contracts: DataContract[] = [];
  const keys: string[] = [];
  for (let i = 0; i < args.n; i++) {
    const synth = await synthesizeContract({ llm }, args.intent);
    if (synth.contract === null) {
      process.stdout.write(`  run ${i + 1}: synth declined — ${synth.reason}\n`);
      continue;
    }
    const key = blueprintKey(synth.contract);
    contracts.push(synth.contract);
    keys.push(key);
    process.stdout.write(
      `  run ${i + 1}: ${key}  ${shapeSummary(synth.contract)}\n`,
    );
  }

  const distinct = new Set(keys);
  process.stdout.write(
    `\nDistinct blueprintKeys: ${distinct.size}/${keys.length}\n`,
  );
  if (distinct.size <= 1 && keys.length > 1) {
    process.stdout.write(
      'STABLE → the exact-key cache WOULD hit on a re-run of this intent.\n',
    );
  } else if (keys.length > 1) {
    process.stdout.write(
      'UNSTABLE → same intent yields different canonical contracts → the exact-key\n' +
        'cache cannot hit; each request cold-gens a new blueprint.\n',
    );
  }

  // Key-affecting cross-run diff — the "what varies" the user asked for.
  if (contracts.length > 1) {
    const diff = crossRunDiff(contracts);
    process.stdout.write(
      `\n=== KEY-AFFECTING DIFF (${diff.length} divergent paths; descriptions stripped) ===\n`,
    );
    for (const { path, values } of diff) {
      process.stdout.write(`  ${path}\n`);
      values.forEach((v, i) => {
        const capped = v.length > 100 ? `${v.slice(0, 100)}…` : v;
        process.stdout.write(`    run${i + 1}: ${capped}\n`);
      });
    }
    // Heuristic taxonomy hint.
    const isArrayOrderOnly = diff.every(({ values }) => {
      const parsed = values
        .filter((v) => v !== '∅')
        .map((v) => {
          try {
            return JSON.stringify([...(JSON.parse(v) as unknown[])].sort());
          } catch {
            return v;
          }
        });
      return new Set(parsed).size === 1;
    });
    process.stdout.write(
      `\nHint: ${
        diff.length === 0
          ? 'no key-affecting differences — variance must be elsewhere'
          : isArrayOrderOnly
            ? 'ALL divergent paths are arrays differing only in ORDER → a canonical sort in canonicalizeContracts would collapse these keys (cheap fix, no semantic match needed).'
            : 'divergent paths include non-array-order differences (names / types / structure / presence) → a semantic intent-match is needed to bridge them (canonicalization alone cannot).'
      }\n`,
    );
  }

  if (args.dump !== undefined) {
    writeFileSync(
      args.dump,
      JSON.stringify({ intent: args.intent, model: args.model, keys, contracts }, null, 2),
    );
    process.stdout.write(`\nDumped ${contracts.length} contracts → ${args.dump}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(
    `cache-probe failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
