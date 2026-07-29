import { describe, it, expect, beforeEach } from 'vitest';
import { AgentWorkspace } from '../workspace';
import { executeTool } from '../tools';

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
    // Heaviest path in this file: real esbuild compile + tsc self-check + isolated
    // git commit. Sub-second when run alone, but starves on the 2-core CI runner
    // under full-suite contention (49 files concurrent) and crossed the default
    // 5000ms there. Same reason runtime-render.test.ts pins its render tests to 30000ms.
  }, 30000);

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

// ── ggui Exp 49 (P3) — patch-geometry diagnostics ──────────────────────────

import { buildRangeContextAddendum } from '../tools';

describe('buildRangeContextAddendum (Exp 49 P3.1)', () => {
  const original = [
    'interface Props { title: string; }',           // 1
    'export default function Component(props: Props) {', // 2
    '  const [step, setStep] = useState(0);',        // 3
    '',                                              // 4
    '  return (',                                    // 5
    '    <div>',                                     // 6
    '      <p>{props.title}</p>',                    // 7
    '    </div>',                                    // 8
    '  );',                                          // 9
    '}',                                             // 10
  ];

  it('names shape (a): declaration payload with range starting inside returned JSX', () => {
    const addendum = buildRangeContextAddendum(
      6,
      [{ startLine: 6, code: ['  const items = [];', '  return ('] }],
      original,
    );
    expect(addendum).toContain('line 5 is `return (`');
    expect(addendum).toContain('begins with a declaration (`const`)');
  });

  it('names shape (b): payload re-emits export default function below the existing one', () => {
    const addendum = buildRangeContextAddendum(
      6,
      [{ startLine: 6, code: ['export default function Component() {', '  return null;', '}'] }],
      original,
    );
    expect(addendum).toContain('second `export default function`');
    expect(addendum).toContain('opens at line 2');
  });

  it('stays silent when the error is not at a range start', () => {
    expect(
      buildRangeContextAddendum(7, [{ startLine: 6, code: ['const x = 1;'] }], original),
    ).toBe('');
  });

  it('stays silent when the preceding line is not `return (`', () => {
    expect(
      buildRangeContextAddendum(3, [{ startLine: 3, code: ['const x = 1;'] }], original),
    ).toBe('');
  });

  it('stays silent with no error line', () => {
    expect(buildRangeContextAddendum(undefined, [], original)).toBe('');
  });
});

describe('apply_changes gutter-transcription reject (Exp 49 P3.3)', () => {
  it('rejects a payload carrying the N│ gutter without touching the workspace', async () => {
    const ws = new AgentWorkspace();
    await ws.init();
    const meta = new Map();
    const good = `interface Props { name: string; }
export default function Hello(props: Props) {
  return <div aria-label="c">{props.name}</div>;
}`;
    await executeTool(ws, 'write', { code: good, commit_message: 'seed' }, meta);
    const before = ws.read();

    const result = await executeTool(
      ws,
      'apply_changes',
      {
        changes: [
          {
            startLine: 3,
            endLine: 3,
            code: ['3│  return <div aria-label="c">{props.name}</div>;'],
            description: 'transcribed gutter',
          },
        ],
        commit_message: 'broken',
      },
      meta,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('line-number gutter');
    expect(ws.read()).toBe(before);
  });

  it('never fires on legitimate code', async () => {
    const ws = new AgentWorkspace();
    await ws.init();
    const meta = new Map();
    const good = `interface Props { name: string; }
export default function Hello(props: Props) {
  return <div aria-label="c">{props.name}</div>;
}`;
    await executeTool(ws, 'write', { code: good, commit_message: 'seed' }, meta);
    const result = await executeTool(
      ws,
      'apply_changes',
      {
        changes: [
          {
            startLine: 3,
            endLine: 3,
            code: ['  return <div aria-label="x">{props.name}</div>;'],
            description: 'fine',
          },
        ],
        commit_message: 'ok',
      },
      meta,
    );
    expect(result.result).not.toContain('line-number gutter');
  }, 30000);
});
