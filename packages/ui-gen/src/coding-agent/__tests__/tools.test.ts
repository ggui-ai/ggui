import { describe, it, expect, beforeEach } from 'vitest';
import { AgentWorkspace } from '../workspace';
import {
  executeTool,
  executeToolBatch,
  initialToolSchemas,
  fullToolSchemas,
} from '../tools';

describe('Tool Schemas', () => {
  it('initialToolSchemas has only write', () => {
    const names = Object.keys(initialToolSchemas);
    expect(names).toEqual(['write']);
  });

  it('fullToolSchemas has 9 tools (no separate commit)', () => {
    const names = Object.keys(fullToolSchemas);
    expect(names).toHaveLength(9);
    expect(names).toContain('write');
    expect(names).toContain('apply_diff');
    expect(names).toContain('cat');
    expect(names).toContain('grep');
    expect(names).toContain('diff');
    expect(names).toContain('log');
    expect(names).toContain('show');
    expect(names).toContain('revert');
    expect(names).not.toContain('commit');
  });
});

describe('executeTool', () => {
  let ws: AgentWorkspace;
  const commitMeta = new Map();

  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
    commitMeta.clear();
  });

  // ── write (auto-commits) ────────────────────

  it('write: valid code → auto-commit → PASS → done:true', async () => {
    const code = `interface Props { name: string; }
export default function Hello(props: Props) {
  return <div style={{ color: 'var(--ggui-color-primary-600)' }} aria-label="c">{props.name}</div>;
}`;
    const result = await executeTool(ws, 'write', { code, commit_message: 'feat: hello' }, commitMeta);
    expect(result.done).toBe(true);
    expect(result.compiledCode).toBeDefined();
    expect(result.compiledCode!.length).toBeGreaterThan(0);
    expect(commitMeta.size).toBe(1);
  });

  it('write: invalid code → auto-commit → FAIL → violations returned', async () => {
    const result = await executeTool(
      ws,
      'write',
      { code: 'this is not valid jsx {{{', commit_message: 'bad' },
      commitMeta,
    );
    expect(result.done).toBeUndefined();
    expect(result.result).toContain('bad');
    // Still committed (for history)
    expect(commitMeta.size).toBe(1);
  });

  it('write: no code field → error', async () => {
    const result = await executeTool(ws, 'write', { commit_message: 'oops' }, commitMeta);
    expect(result.error).toBe(true);
    expect(result.result).toContain('FAILED');
  });

  // ── apply_diff (auto-commits) ────────────────

  it('apply_diff: valid diff → auto-commit', async () => {
    ws.write('line 1\nline 2\nline 3\n');
    await ws.commit('initial');

    const diff = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -2,1 +2,1 @@',
      '-line 2',
      '+LINE TWO',
    ].join('\n');

    await executeTool(
      ws,
      'apply_diff',
      { diff, commit_message: 'fix line 2' },
      commitMeta,
    );
    // Commit happened (even if self-check fails on non-component code)
    expect(commitMeta.size).toBe(1);
    expect(ws.read()).toContain('LINE TWO');
  });

  it('apply_diff: no file → error', async () => {
    const result = await executeTool(
      ws,
      'apply_diff',
      { diff: '@@ bad', commit_message: 'x' },
      commitMeta,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('No file');
  });

  // ── cat ──────────────────────────────────────

  it('cat: returns file with line numbers', async () => {
    ws.write('aaa\nbbb\nccc');
    const result = await executeTool(ws, 'cat', {}, commitMeta);
    expect(result.result).toContain('1│ aaa');
    expect(result.result).toContain('3│ ccc');
  });

  // ── grep ─────────────────────────────────────

  it('grep: returns matching lines', async () => {
    ws.write('const foo = 1;\nconst bar = 2;\nconst foobar = 3;');
    const result = await executeTool(ws, 'grep', { pattern: 'foo' }, commitMeta);
    expect(result.result).toContain('foo');
    expect(result.result).toContain('>');
  });

  it('grep: no match', async () => {
    ws.write('hello world');
    const result = await executeTool(ws, 'grep', { pattern: 'xyz' }, commitMeta);
    expect(result.result).toBe('(no matches)');
  });

  // ── diff ─────────────────────────────────────

  it('diff: shows uncommitted changes', async () => {
    ws.write('original\n');
    await ws.commit('initial');
    ws.write('modified\n');
    const result = await executeTool(ws, 'diff', {}, commitMeta);
    expect(result.result).toContain('-original');
    expect(result.result).toContain('+modified');
  });

  // ── log ──────────────────────────────────────

  it('log: shows commit history', async () => {
    ws.write('v1');
    await ws.commit('first');
    ws.write('v2');
    await ws.commit('second');
    const result = await executeTool(ws, 'log', {}, commitMeta);
    expect(result.result).toContain('second');
    expect(result.result).toContain('first');
  });

  // ── show ─────────────────────────────────────

  it('show: shows commit diff', async () => {
    ws.write('aaa\n');
    await ws.commit('first');
    ws.write('bbb\n');
    const oid2 = await ws.commit('second');
    const result = await executeTool(ws, 'show', { oid: oid2.slice(0, 7) }, commitMeta);
    expect(result.result).toContain('-aaa');
    expect(result.result).toContain('+bbb');
  });

  it('show: bad OID → error', async () => {
    ws.write('aaa\n');
    await ws.commit('first');
    const result = await executeTool(ws, 'show', { oid: 'nonexistent' }, commitMeta);
    expect(result.error).toBe(true);
  });

  // ── revert ───────────────────────────────────

  it('revert: restores previous commit', async () => {
    ws.write('original');
    const oid = await ws.commit('v1');
    ws.write('modified');
    const result = await executeTool(ws, 'revert', { oid: oid.slice(0, 7) }, commitMeta);
    expect(result.error).toBeUndefined();
    expect(ws.read()).toBe('original');
  });

  it('revert: bad OID → error with available', async () => {
    ws.write('aaa');
    await ws.commit('first');
    const result = await executeTool(ws, 'revert', { oid: 'badoid' }, commitMeta);
    expect(result.error).toBe(true);
    expect(result.result).toContain('Available');
  });
});

// R3 C1: ContextPolicy.labeledPreflight plumbing. Default leaves retry
// feedback byte-identical; the override lights up [P0-compile] prefix so
// the LLM can rank the failure against its P0/P1/P2 priority schema.
describe('executeTool — apply_changes preflight + ContextPolicy', () => {
  let ws: AgentWorkspace;
  const commitMeta = new Map();

  const validCode = `interface Props { x: number; }
export default function C(props: Props) {
  return <div aria-label="c">{props.x}</div>;
}`;

  // Introduce a bad JSX tag mismatch on line 3 to force preflight failure.
  const badPatchInput = {
    changes: [
      {
        startLine: 3,
        endLine: 3,
        code: ['  return <div><span>oops</div>;'],
        description: 'bad jsx',
      },
    ],
    commit_message: 'break it',
  };

  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
    commitMeta.clear();
    await executeTool(ws, 'write', { code: validCode, commit_message: 'seed' }, commitMeta);
  });

  it('defaults to unlabeled retry text when no contextPolicy is passed', async () => {
    const result = await executeTool(ws, 'apply_changes', badPatchInput, commitMeta);
    expect(result.error).toBe(false); // apply-and-warn: patch applied, LLM sees error
    expect(result.result).toContain('PATCH_APPLIED_BROKEN');
    expect(result.result).not.toContain('[P0-compile]');
  });

  it('still defaults to unlabeled when passed explicit labeledPreflight=false', async () => {
    const result = await executeTool(
      ws,
      'apply_changes',
      badPatchInput,
      commitMeta,
      undefined,
      undefined,
      { labeledPreflight: false, labeledTier0: false, breakDuplicatePatch: false },
    );
    expect(result.error).toBe(false); // apply-and-warn: patch applied, LLM sees error
    expect(result.result).toContain('PATCH_APPLIED_BROKEN');
    expect(result.result).not.toContain('[P0-compile]');
  });

  it('prefixes [P0-compile] when labeledPreflight=true', async () => {
    const result = await executeTool(
      ws,
      'apply_changes',
      badPatchInput,
      commitMeta,
      undefined,
      undefined,
      { labeledPreflight: true, labeledTier0: false, breakDuplicatePatch: false },
    );
    expect(result.error).toBe(false);
    expect(result.result).toContain('[P0-compile] PATCH_APPLIED_BROKEN');
  });

  it('labeledTier0 does not affect preflight retry text (preflight is its own site)', async () => {
    // Flipping labeledTier0 alone must not label the preflight message.
    // Preflight labeling belongs to labeledPreflight exclusively — these
    // are two distinct feedback sites (per Experiment #39 decomposition).
    const result = await executeTool(
      ws,
      'apply_changes',
      badPatchInput,
      commitMeta,
      undefined,
      undefined,
      { labeledPreflight: false, labeledTier0: true, breakDuplicatePatch: false },
    );
    expect(result.error).toBe(false);
    expect(result.result).not.toContain('[P0-compile]');
  });
});

// C2 / Experiment #40: labeledTier0 plumbing. Triggered by `write` with
// code that passes syntax but fails tier-0 (forbidden imports, hardcoded
// colors, etc.). autoCommit's violation formatter is the site under test.
describe('executeTool — autoCommit tier-0 violations + ContextPolicy', () => {
  let ws: AgentWorkspace;
  const commitMeta = new Map();

  // Parses fine (tier-0 compile PASSES) but violates the imports allowlist
  // (triggers a tier-0 `imports` fail with priority P0) AND hardcodes a
  // hex color (triggers a tier-0 `tokens` warn with priority P1 — warn,
  // not fail, so it won't appear in the violation formatter; we only
  // check P0 here).
  const invalidImportsCode = `import axios from 'axios';
interface Props { x: number; }
export default function C(props: Props) {
  return <div aria-label="c">{props.x}</div>;
}`;

  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
    commitMeta.clear();
  });

  it('defaults to unlabeled violations when no contextPolicy passed', async () => {
    const result = await executeTool(
      ws,
      'write',
      { code: invalidImportsCode, commit_message: 'bad imports' },
      commitMeta,
    );
    expect(result.done).toBeUndefined();
    // Unlabeled format: `[imports] Import from ... is not allowed`
    expect(result.result).toContain('[imports]');
    expect(result.result).not.toContain('[P0-imports]');
  });

  it('still defaults to unlabeled when labeledTier0=false explicitly', async () => {
    const result = await executeTool(
      ws,
      'write',
      { code: invalidImportsCode, commit_message: 'bad imports' },
      commitMeta,
      undefined,
      undefined,
      { labeledPreflight: false, labeledTier0: false, breakDuplicatePatch: false },
    );
    expect(result.result).toContain('[imports]');
    expect(result.result).not.toContain('[P0-imports]');
  });

  it('prefixes [P0-imports] when labeledTier0=true', async () => {
    const result = await executeTool(
      ws,
      'write',
      { code: invalidImportsCode, commit_message: 'bad imports' },
      commitMeta,
      undefined,
      undefined,
      { labeledPreflight: false, labeledTier0: true, breakDuplicatePatch: false },
    );
    expect(result.result).toContain('[P0-imports]');
    // And NOT the unlabeled form.
    expect(result.result).not.toMatch(/\[imports\][^-]/);
  });
});

describe('executeToolBatch', () => {
  let ws: AgentWorkspace;
  const commitMeta = new Map();

  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
    commitMeta.clear();
  });

  it('write with valid code → done in one call', async () => {
    const code = `interface Props { x: number; }
export default function C(props: Props) {
  return <div style={{ color: 'var(--ggui-color-primary-600)' }} aria-label="c">{props.x}</div>;
}`;
    const calls = [
      { tool: 'write', input: { code, commit_message: 'test' } },
    ];

    const result = await executeToolBatch(calls, ws, commitMeta);
    expect(result.done).toBe(true);
    expect(result.compiledCode).toBeDefined();
  });

  it('error in tool → stops batch', async () => {
    const calls = [
      { tool: 'apply_diff', input: { diff: '@@ bad', commit_message: 'x' } },
      { tool: 'write', input: { code: 'should not reach', commit_message: 'x' } },
    ];

    const result = await executeToolBatch(calls, ws, commitMeta);
    expect(result.results.length).toBe(1);
    expect(result.done).toBe(false);
  });
});
