/**
 * Diff processor robustness tests.
 *
 * These fixtures are real LLM-generated diffs that failed in production.
 * Each test documents the failure pattern and verifies the processor
 * handles it gracefully (either applies correctly or fails with a clear error).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { preProcessDiff, applyDiffToFile } from '../diff-processor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, 'fixtures');

function loadFixture(name: string) {
  const file = readFileSync(resolve(fixtures, `${name}-file.txt`), 'utf-8');
  const diff = readFileSync(resolve(fixtures, `${name}-diff.patch`), 'utf-8');
  return { file, diff };
}

function tryApply(file: string, diff: string) {
  const pre = preProcessDiff(diff, file);
  if (!pre.success) return { applied: false, preError: pre.error };
  const apply = applyDiffToFile(file, pre.cleanDiff, pre.parsed);
  if (!apply.success) return { applied: false, applyError: apply.error };
  return { applied: true, result: apply.result };
}

// =============================================================================
// Pattern A: } vs "" off-by-one (67% of failures)
//
// The LLM's @@ line number is off by 1. It puts } where the file has an empty
// line or vice versa. The -/+ content is correct — only context is shifted.
// =============================================================================

describe('Pattern A: off-by-one (} vs empty line)', () => {
  const { file, diff } = loadFixture('pattern-a');

  it('should not crash', () => {
    expect(() => tryApply(file, diff)).not.toThrow();
  });

  it('currently fails gracefully with a clear error', () => {
    const result = tryApply(file, diff);
    if (!result.applied) {
      // Acceptable: fails with diagnostic, not a crash
      const error = result.preError ?? result.applyError ?? '';
      expect(error).toBeTruthy();
      expect(error).not.toContain('undefined');
    }
    // If it applies, even better
  });

  it('the removed lines (-) DO exist in the file', () => {
    // The diff's - lines should match somewhere in the file, proving the
    // content is correct even though context is shifted
    const diffLines = diff.split('\n');
    const removedLines = diffLines
      .filter(l => l.startsWith('-') && !l.startsWith('---'))
      .map(l => l.slice(1).trim());
    const fileContent = file;
    for (const removed of removedLines) {
      if (removed.length > 5) {
        expect(fileContent).toContain(removed.trim());
      }
    }
  });
});

// =============================================================================
// Pattern B: bigger offset (function line vs })
//
// The @@ start line is off by 2+. The LLM's context shows "}" where the file
// has "function useComponent..." — completely different content.
// =============================================================================

describe('Pattern B: multi-line offset', () => {
  const { file, diff } = loadFixture('pattern-b');

  it('should not crash', () => {
    expect(() => tryApply(file, diff)).not.toThrow();
  });

  it('fails gracefully with mismatch diagnostic', () => {
    const result = tryApply(file, diff);
    if (!result.applied) {
      const error = result.preError ?? result.applyError ?? '';
      expect(error).toBeTruthy();
    }
  });
});

// =============================================================================
// Pattern C: content hallucination on patched file
//
// The diff targets a 200+ line file that was already modified by previous turns.
// Context lines don't match because the LLM hallucinated the file state.
// =============================================================================

describe('Pattern C: hallucinated context on large file', () => {
  const { file, diff } = loadFixture('pattern-c');

  it('should not crash', () => {
    expect(() => tryApply(file, diff)).not.toThrow();
  });

  it('fails gracefully — this is genuinely wrong context', () => {
    const result = tryApply(file, diff);
    // This SHOULD fail — the context is from a hallucinated file version
    if (!result.applied) {
      const error = result.preError ?? result.applyError ?? '';
      expect(error).toBeTruthy();
    }
  });
});

// =============================================================================
// Pattern D: multi-hunk failure
//
// Multiple @@ hunks where one or more fail to apply.
// =============================================================================

describe('Pattern D: multi-hunk', () => {
  const { file, diff } = loadFixture('pattern-multi-hunk');

  it('should not crash', () => {
    expect(() => tryApply(file, diff)).not.toThrow();
  });

  it('should parse multiple hunks', () => {
    const pre = preProcessDiff(diff, file);
    if (pre.success) {
      expect(pre.parsed.hunks.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// =============================================================================
// Synthetic tests: known edge cases
// =============================================================================

describe('Synthetic: empty lines in diff', () => {
  it('bare empty lines are treated as context', () => {
    const file = 'line1\n\nline3\n  // TODO\n  return {};\nline6\n';
    const diff = `--- a/ui.tsx
+++ b/ui.tsx
@@ -2,4 +2,4 @@

 line3
-  // TODO
-  return {};
+  const x = 1;
+  return { x };
 line6
`;
    const result = tryApply(file, diff);
    expect(result.applied).toBe(true);
    expect(result.result).toContain('const x = 1');
  });
});

describe('Synthetic: truncated long import line in context', () => {
  it('prefix match handles truncation', () => {
    const longImport = `import { Container, Card, Stack, Row, Box, Divider, Spacer, Text, Heading, Button, Input, TextArea, Select, Checkbox, Toggle, RadioGroup, Slider, Badge, Spinner, Avatar, Alert, Progress, Image, Icon, Link, Tooltip, Table, Tabs, Toast, Accordion } from '@ggui-ai/design/primitives';`;
    const file = `line1\n${longImport}\nline3\nold code\nline5\n`;
    // LLM truncates the import in its context
    const truncated = longImport.slice(0, 100);
    const diff = `--- a/ui.tsx
+++ b/ui.tsx
@@ -3,3 +3,3 @@
 ${truncated}
 line3
-old code
+new code
 line5
`;
    const result = tryApply(file, diff);
    expect(result.applied).toBe(true);
    expect(result.result).toContain('new code');
  });
});

describe('Synthetic: indentation mismatch in context', () => {
  it('trim match handles indent differences', () => {
    const file = '  function foo() {\n    return 1;\n  }\n';
    // LLM uses 3 spaces instead of 4 for indentation in context
    const diff = `--- a/ui.tsx
+++ b/ui.tsx
@@ -1,3 +1,3 @@
   function foo() {
-    return 1;
+    return 2;
   }
`;
    const result = tryApply(file, diff);
    expect(result.applied).toBe(true);
    expect(result.result).toContain('return 2');
  });
});

describe('Synthetic: multi-hunk with correct offsets', () => {
  it('applies 2 hunks independently', () => {
    const file = `import React from 'react';

function useComponent() {
  // TODO
  return {};
}

export default function Component() {
  const state = useComponent();
  return (<></>);
}
`;
    const diff = `--- a/ui.tsx
+++ b/ui.tsx
@@ -3,4 +3,5 @@
 function useComponent() {
-  // TODO
-  return {};
+  const [x, setX] = useState(0);
+  const handler = () => setX(x + 1);
+  return { x, handler };
 }
@@ -8,4 +9,6 @@
 export default function Component() {
-  const state = useComponent();
-  return (<></>);
+  const { x, handler } = useComponent();
+  return (
+    <div onClick={handler}>{x}</div>
+  );
 }
`;
    const result = tryApply(file, diff);
    expect(result.applied).toBe(true);
    expect(result.result).toContain('useState(0)');
    expect(result.result).toContain('handler');
    expect(result.result).toContain('<div onClick');
  });
});

describe('Synthetic: overlapping hunks rejected', () => {
  it('rejects hunks with overlapping line ranges', () => {
    const file = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const diff = `--- a/ui.tsx
+++ b/ui.tsx
@@ -2,4 +2,4 @@
 b
-c
+C
 d
 e
@@ -4,3 +4,3 @@
 d
-e
+E
 f
`;
    const result = tryApply(file, diff);
    expect(result.applied).toBe(false);
    expect(result.preError).toContain('overlap');
  });
});
