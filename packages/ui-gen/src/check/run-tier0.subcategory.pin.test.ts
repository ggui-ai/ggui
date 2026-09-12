// Pin: every tier-0 issue names its rule in `subcategory`. The field is what a
// served cell's eval.json is legible by — `category` alone ("compile", "imports",
// "mode") does not say which check fired. Two literals in this file shipped
// without it (the esbuild build-error issue and the disallowed-import issue);
// the source walk below holds the rule for the next builder as well.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTier0Checks } from './run-tier0.js';

const BARE = `import React from 'react';
export default function Component() {
  return <div>hello</div>;
}
`;

const DISALLOWED_IMPORT = `import React from 'react';
import leftPad from 'left-pad';
export default function Component() {
  return <div>{leftPad('x', 3)}</div>;
}
`;

describe('tier-0 issues carry a subcategory', () => {
  it('a build error is `compile` / `build-error`', async () => {
    const issues = await runTier0Checks(BARE, undefined, ['<stdin>:3:10: ERROR: Unexpected token']);
    const compile = issues.filter((i) => i.tier === 0 && i.category === 'compile');
    expect(compile.map((i) => i.subcategory)).toEqual(['build-error']);
    for (const i of issues.filter((i) => i.tier === 0)) expect(typeof i.subcategory).toBe('string');
  }, 60_000);

  it('a disallowed import is `imports` / `disallowed-package`', async () => {
    const issues = await runTier0Checks(DISALLOWED_IMPORT);
    const imports = issues.filter((i) => i.tier === 0 && i.category === 'imports');
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i.subcategory).toBe('disallowed-package');
    for (const i of issues.filter((i) => i.tier === 0)) expect(typeof i.subcategory).toBe('string');
  }, 60_000);

  it('source walk: every `tier: 0` issue literal under src/ names a subcategory', () => {
    const root = join(import.meta.dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(root);
    const indent = (l: string): number => l.length - l.trimStart().length;
    const missing: string[] = [];
    let literals = 0;
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      for (let n = 0; n < lines.length; n++) {
        const l = lines[n]!;
        const t = l.trim();
        if (!/\btier:\s*0\b/.test(l) || t.startsWith('//') || t.startsWith('*')) continue;
        let body = l;
        if (!(l.includes('{') && l.includes('}'))) {
          const ind = indent(l);
          let a = n;
          while (a - 1 >= 0 && indent(lines[a - 1]!) >= ind && lines[a - 1]!.trim() !== '') a--;
          let b = n;
          while (b + 1 < lines.length && indent(lines[b + 1]!) >= ind && lines[b + 1]!.trim() !== '') b++;
          body = lines.slice(a, b + 1).join('\n');
        }
        if (!body.includes('result') && !body.includes('category')) continue; // a type or a predicate, not an issue literal
        literals++;
        if (!body.includes('subcategory')) missing.push(`${f.slice(root.length + 1)}:${n + 1}`);
      }
    }
    expect(literals).toBeGreaterThanOrEqual(45);
    expect(missing).toEqual([]);
  });
});
