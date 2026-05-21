import { describe, it, expect } from 'vitest';
import { preProcessDiff, applyDiffToFile } from '../diff-processor';

const SAMPLE_FILE = [
  'export default function App(props) {',
  '  const [count, setCount] = useState(0);',
  '  return (',
  '    <div>',
  '      <span>{count}</span>',
  '      <button onClick={() => setCount(count + 1)}>+</button>',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

describe('preProcessDiff', () => {
  it('passes through a valid diff', () => {
    // 3 old lines (1 context + 1 removed + 1 context), 3 new lines
    const diff = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -4,3 +4,3 @@',
      '     <div>',
      '-      <span>{count}</span>',
      '+      <span className="counter">{count}</span>',
      '       <button onClick={() => setCount(count + 1)}>+</button>',
    ].join('\n');

    const result = preProcessDiff(diff, SAMPLE_FILE);
    expect(result.success).toBe(true);
  });

  it('auto-prepends missing --- a/ +++ b/ headers', () => {
    const diff = [
      '@@ -4,3 +4,3 @@',
      '     <div>',
      '-      <span>{count}</span>',
      '+      <span className="counter">{count}</span>',
      '       <button onClick={() => setCount(count + 1)}>+</button>',
    ].join('\n');

    const result = preProcessDiff(diff, SAMPLE_FILE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.cleanDiff).toContain('---');
      expect(result.cleanDiff).toContain('+++');
    }
  });

  it('auto-appends missing trailing newline', () => {
    const diff =
      '--- a/ui.tsx\n+++ b/ui.tsx\n@@ -4,3 +4,3 @@\n     <div>\n-      <span>{count}</span>\n+      <span className="counter">{count}</span>\n       <button onClick={() => setCount(count + 1)}>+</button>';

    const result = preProcessDiff(diff, SAMPLE_FILE);
    expect(result.success).toBe(true);
  });

  it('fixes context lines missing space prefix', () => {
    // Use a file where context lines start with a non-space char
    const simpleFile = 'function foo() {\n  return 1;\n}\n';
    // "function foo() {" matches file content but has no space prefix
    const diff = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -1,3 +1,3 @@',
      'function foo() {', // missing space prefix — matches file line
      '-  return 1;',
      '+  return 42;',
      '}', // missing space prefix — matches file line
    ].join('\n');

    const result = preProcessDiff(diff, simpleFile);
    expect(result.success).toBe(true);
  });

  it('recalculates wrong @@ line counts', () => {
    // Actual content is 3 old, 3 new — but header says 99,99
    const diff = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -4,99 +4,99 @@',
      '     <div>',
      '-      <span>{count}</span>',
      '+      <span className="counter">{count}</span>',
      '       <button onClick={() => setCount(count + 1)}>+</button>',
    ].join('\n');

    const result = preProcessDiff(diff, SAMPLE_FILE);
    expect(result.success).toBe(true);
  });

  it('returns error for context line mismatch', () => {
    const diff = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -4,3 +4,3 @@',
      ' THIS LINE DOES NOT EXIST IN THE FILE',
      '-      <span>{count}</span>',
      '+      <span className="counter">{count}</span>',
      ' ANOTHER FAKE LINE',
    ].join('\n');

    // preProcessDiff is a pure preprocessing step — it succeeds
    const preResult = preProcessDiff(diff, SAMPLE_FILE);
    expect(preResult.success).toBe(true);

    // Context mismatch is detected when actually applying the diff
    const applyResult = applyDiffToFile(SAMPLE_FILE, diff);
    expect(applyResult.success).toBe(false);
  });

  it('handles multi-hunk diffs', () => {
    const diff = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -1,1 +1,1 @@',
      '-export default function App(props) {',
      '+export default function Counter(props) {',
      '@@ -6,1 +6,1 @@',
      '-      <button onClick={() => setCount(count + 1)}>+</button>',
      '+      <button onClick={() => setCount(count + 1)}>Increment</button>',
    ].join('\n');

    const result = preProcessDiff(diff, SAMPLE_FILE);
    expect(result.success).toBe(true);
  });

  it('returns error for completely malformed diff', () => {
    const result = preProcessDiff(
      'just some random text\nwith no diff syntax',
      SAMPLE_FILE,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it('returns error for empty diff', () => {
    const result = preProcessDiff('', SAMPLE_FILE);
    expect(result.success).toBe(false);
  });
});

describe('applyDiffToFile', () => {
  it('applies a valid diff and returns the result', () => {
    const diff = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -5,1 +5,1 @@',
      '-      <span>{count}</span>',
      '+      <span className="value">{count}</span>',
    ].join('\n');

    const result = applyDiffToFile(SAMPLE_FILE, diff);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toContain('className="value"');
    }
  });

  it('returns error when patch fails to apply', () => {
    const diff = [
      '--- a/ui.tsx',
      '+++ b/ui.tsx',
      '@@ -1,1 +1,1 @@',
      '-this line does not exist anywhere in the file at all',
      '+replacement',
    ].join('\n');

    const result = applyDiffToFile(SAMPLE_FILE, diff);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('failed');
    }
  });
});
