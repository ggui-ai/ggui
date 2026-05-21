#!/usr/bin/env node
/**
 * Probe a real generated component with the runtime render check.
 *
 * Usage:
 *   node --import tsx packages/benchmark/scripts/probe-it.mjs <benchmark-dir> <commit-id>
 *
 * Example:
 *   node --import tsx scripts/probe-it.mjs \
 *     benchmark-results/benchmark-2026-04-13T08-34-28-161Z/claude-0-kanban-board kanban-board
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARKS_DIR = resolve(__dirname, '..');
const WORKSPACE_ROOT = resolve(BENCHMARKS_DIR, '../..');
const GEN_RUNTIME_DIR = resolve(WORKSPACE_ROOT, 'cloud/generation-runtime');

const [benchmarkDir, commitId] = process.argv.slice(2);
if (!benchmarkDir || !commitId) {
  console.error('Usage: node --import tsx scripts/probe-it.mjs <benchmark-dir> <commit-id>');
  process.exit(1);
}

// Set up happy-dom globals BEFORE any imports that might touch React
// (mirrors what render-check.ts does internally).
const { Window } = await import('happy-dom');
const window = new Window({ url: 'https://probe-it.local' });
const g = globalThis;
const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
for (const k of keys) {
  try {
    Object.defineProperty(g, k, { value: window[k], writable: true, configurable: true });
  } catch {}
}
g.IS_REACT_ACT_ENVIRONMENT = true;

// Now import the modules we need
const { runRenderCheck } = await import(resolve(GEN_RUNTIME_DIR, 'src/harness/check/runtime-render/render-check.ts'));
const { prepareMockupProps } = await import(resolve(GEN_RUNTIME_DIR, 'src/harness/check/runtime-render/prepare-mockup.ts'));
const { BENCHMARK_COMMITS } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/commits.ts'));

const commit = BENCHMARK_COMMITS.find(c => c.id === commitId);
if (!commit) {
  console.error(`Unknown commit id: ${commitId}`);
  console.error(`Available: ${BENCHMARK_COMMITS.map(c => c.id).join(', ')}`);
  process.exit(1);
}

const sourcePath = resolve(BENCHMARKS_DIR, benchmarkDir, 'source.tsx');
let sourceCode;
try {
  sourceCode = readFileSync(sourcePath, 'utf-8');
} catch (e) {
  console.error(`Could not read ${sourcePath}: ${e.message}`);
  process.exit(1);
}

console.log(`\n  Probing: ${benchmarkDir}`);
console.log(`  Contract: ${commitId} (${commit.contract.intent.slice(0, 60)})`);
console.log(`  Source size: ${sourceCode.length}B`);

const mockup = prepareMockupProps({
  contract: commit.contract,
  fixtureProps: commit.props,
});

console.log(`\n  Mockup props sources:`);
for (const [k, v] of Object.entries(mockup.source)) {
  console.log(`    ${k}: ${v}`);
}
if (mockup.warnings.length) {
  console.log(`  Mockup warnings:`);
  for (const w of mockup.warnings) console.log(`    ${w}`);
}

console.log(`\n  Running render check...`);
const result = await runRenderCheck({
  sourceCode,
  mockupProps: mockup.props,
  contract: commit.contract,
});

console.log(`\n  ── Result ──`);
console.log(`  ok: ${result.ok}`);
console.log(`  duration: ${result.stats.renderMs}ms`);
console.log(`  actions checked: ${result.stats.actionsChecked}`);
console.log(`  wiredTools checked: ${result.stats.wiredToolsChecked}`);
console.log(`  clientTools checked: ${result.stats.clientToolsChecked}`);
console.log(`  streams checked: ${result.stats.streamsChecked}`);

if (result.issues.length === 0) {
  console.log(`\n  ✓ No issues — every check passed!`);
} else {
  console.log(`\n  Issues (${result.issues.length}):`);
  for (const issue of result.issues) {
    const symbol = issue.outcome === 'fail' ? '✗' : '⚠';
    const subj = issue.subject ? ` [${issue.subject}]` : '';
    console.log(`\n  ${symbol} ${issue.check}${subj} (${issue.outcome})`);
    console.log(`     ${issue.reason}`);
    if (issue.elementHint) console.log(`     element: ${issue.elementHint}`);
  }
}

console.log('');
process.exit(result.ok ? 0 : 1);
