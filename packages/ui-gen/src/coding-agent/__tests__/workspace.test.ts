import { describe, it, expect, beforeEach } from 'vitest';
import { AgentWorkspace } from '../workspace';

describe('AgentWorkspace', () => {
  let ws: AgentWorkspace;

  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
  });

  // ── File Operations ──────────────────────────────

  it('read() returns null on empty workspace', () => {
    expect(ws.read()).toBeNull();
  });

  it('write() + read() round-trips content', () => {
    ws.write('const x = 1;');
    expect(ws.read()).toBe('const x = 1;');
  });

  it('cat() returns content with right-aligned line numbers', () => {
    ws.write('line one\nline two\nline three');
    const result = ws.cat();
    expect(result).toContain('1│ line one');
    expect(result).toContain('2│ line two');
    expect(result).toContain('3│ line three');
  });

  it('cat(start, end) returns a line range', () => {
    ws.write('a\nb\nc\nd\ne');
    const result = ws.cat(2, 4);
    expect(result).toContain('2│ b');
    expect(result).toContain('3│ c');
    expect(result).toContain('4│ d');
    expect(result).not.toContain('1│');
    expect(result).not.toContain('5│');
  });

  it('cat() on empty workspace returns no-file message', () => {
    const result = ws.cat();
    expect(result).toContain('no file');
  });

  // ── Grep ─────────────────────────────────────────

  it('grep() returns matching lines with > prefix', () => {
    ws.write('const foo = 1;\nconst bar = 2;\nconst foobar = 3;');
    const result = ws.grep('foo');
    expect(result).toContain('>');
    expect(result).toContain('foo');
    // Should match line 1 and line 3
    expect(result).toContain('1');
    expect(result).toContain('3');
  });

  it('grep() with context includes surrounding lines', () => {
    ws.write('a\nb\nc\nd\ne');
    const result = ws.grep('c', 1);
    // Should include line 2 (before), 3 (match), 4 (after)
    expect(result).toContain('2');
    expect(result).toContain('3');
    expect(result).toContain('4');
  });

  it('grep() with no match returns (no matches)', () => {
    ws.write('hello world');
    const result = ws.grep('xyz');
    expect(result).toBe('(no matches)');
  });

  // ── Git Operations ───────────────────────────────

  it('stage() + commit() returns an OID string', async () => {
    ws.write('const x = 1;');
    await ws.stage();
    const oid = await ws.commit('initial commit');
    expect(typeof oid).toBe('string');
    expect(oid.length).toBe(40); // SHA-1 hex
  });

  it('log() returns commits in reverse chronological order', async () => {
    ws.write('v1');
    await ws.stage();
    await ws.commit('first');

    ws.write('v2');
    await ws.stage();
    await ws.commit('second');

    const commits = await ws.log();
    expect(commits.length).toBe(2);
    expect(commits[0].commit.message.trim()).toBe('second');
    expect(commits[1].commit.message.trim()).toBe('first');
  });

  it('readFileAtCommit() reads file at a specific commit', async () => {
    ws.write('version 1');
    await ws.stage();
    const oid1 = await ws.commit('v1');

    ws.write('version 2');
    await ws.stage();
    await ws.commit('v2');

    const content = await ws.readFileAtCommit(oid1);
    expect(content).toBe('version 1');
  });

  it('checkout() restores working copy to a previous commit', async () => {
    ws.write('original');
    await ws.stage();
    const oid = await ws.commit('original');

    ws.write('modified');
    expect(ws.read()).toBe('modified');

    await ws.checkout(oid);
    expect(ws.read()).toBe('original');
  });

  // ── Diff Operations ──────────────────────────────

  it('diffWorking() returns unified diff between HEAD and working copy', async () => {
    ws.write('line 1\nline 2\nline 3');
    await ws.stage();
    await ws.commit('initial');

    ws.write('line 1\nmodified\nline 3');
    const diff = await ws.diffWorking();
    expect(diff).toContain('-line 2');
    expect(diff).toContain('+modified');
  });

  it('diffWorking() with no commits returns new-file message', async () => {
    ws.write('hello');
    const diff = await ws.diffWorking();
    expect(diff).toContain('no commits');
  });

  it('diffBetween() returns unified diff between two commits', async () => {
    ws.write('aaa');
    await ws.stage();
    const oid1 = await ws.commit('first');

    ws.write('bbb');
    await ws.stage();
    const oid2 = await ws.commit('second');

    const diff = await ws.diffBetween(oid1, oid2);
    expect(diff).toContain('-aaa');
    expect(diff).toContain('+bbb');
  });

  it('applyDiff() applies a valid unified diff', async () => {
    const original = 'line 1\nline 2\nline 3\n';
    ws.write(original);
    await ws.stage();
    await ws.commit('initial');

    const patch = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+LINE TWO',
      ' line 3',
      '',
    ].join('\n');

    const result = ws.applyDiff(patch);
    expect(result.success).toBe(true);
    expect(ws.read()).toContain('LINE TWO');
  });

  it('applyDiff() returns error for invalid patch', () => {
    ws.write('hello world\n');
    const result = ws.applyDiff('this is not a valid diff');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── Log with no commits ──────────────────────────

  it('log() returns empty array when no commits exist', async () => {
    const commits = await ws.log();
    expect(commits).toEqual([]);
  });
});
