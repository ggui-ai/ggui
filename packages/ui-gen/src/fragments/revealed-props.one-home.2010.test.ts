// Pin (ggui#2010): a prop tagged `@revealedBy <axis>=<value>` in @ggui-ai/design has exactly one home in the prompt.
// - The generated REVEALED_PROPS is the design source's JSDoc: every tagged prop, once, with its whole docblock (read
//   here with the TypeScript compiler, independently of the generator), and nothing the source does not tag.
// - Neither component reference (the TS form the bench and the cloud send, nor the markdown form) declares it.
// - Exactly one fragment carries it: the one for its axis value.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PRIMITIVES_DOCUMENTATION_TS } from '../tools/get-primitives-ts.js';
import { PRIMITIVES_DOCUMENTATION } from '../validation/primitives.js';
import { FRAGMENT_REGISTRY, REVEALED_PROPS, revealedPropLine } from './index.js';

const DESIGN_SOURCES = ['../../../design/src/primitives/types.ts', '../../../design/src/components/types.ts'].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
);

interface Tagged {
  readonly key: string;
  readonly prop: string;
  readonly description: string;
}

/** Every `@revealedBy` prop on a `*Props` interface, read with the compiler API. */
function taggedInSource(): Tagged[] {
  const out = new Map<string, Tagged>();
  for (const file of DESIGN_SOURCES) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sf.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node) || !node.name.text.endsWith('Props')) return;
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue;
        const tag = ts.getJSDocTags(member).find((t) => t.tagName.text === 'revealedBy');
        if (tag === undefined) continue;
        const target = ts.getTextOfJSDocComment(tag.comment)?.trim() ?? '';
        const doc = ts.getJSDocCommentsAndTags(member).find(ts.isJSDoc);
        const description = (ts.getTextOfJSDocComment(doc?.comment) ?? '').replace(/\s+/g, ' ').trim();
        const name = member.name.getText(sf);
        const prop = `${name}${member.questionToken ? '?' : ''}`;
        out.set(`${target}:${name}`, { key: `${target}:${name}`, prop, description });
      }
    });
  }
  return [...out.values()];
}

const nameOf = (prop: string) => prop.replace(/\?$/, '');
const declaredInTs = (name: string) => PRIMITIVES_DOCUMENTATION_TS.includes(`\n  ${name}?: `) || PRIMITIVES_DOCUMENTATION_TS.includes(`\n  ${name}: `);
const declaredInMd = (name: string) => PRIMITIVES_DOCUMENTATION.includes(`| ${name} |`);

describe('a revealed prop has exactly one home (ggui#2010)', () => {
  it('REVEALED_PROPS is the design source: every tagged prop once, whole docblock, nothing untagged', () => {
    const source = taggedInSource();
    expect(source.length).toBeGreaterThan(0);
    const generated = REVEALED_PROPS.map((p) => ({ key: `${p.axis}=${p.value}:${nameOf(p.prop)}`, prop: p.prop, description: p.description }));
    expect([...generated].sort((a, b) => a.key.localeCompare(b.key))).toEqual([...source].sort((a, b) => a.key.localeCompare(b.key)));
  });

  it('control: the reference forms are read right (an untagged Row prop is declared in both)', () => {
    expect(declaredInTs('wrap')).toBe(true);
    expect(declaredInMd('wrap')).toBe(true);
  });

  it('neither component reference declares a revealed prop', () => {
    for (const p of REVEALED_PROPS) {
      expect(declaredInTs(nameOf(p.prop)), `${p.prop} in the TS reference`).toBe(false);
      expect(declaredInMd(nameOf(p.prop)), `${p.prop} in the markdown reference`).toBe(false);
    }
  });

  it('exactly one fragment carries each revealed prop: its own axis value', () => {
    for (const p of REVEALED_PROPS) {
      const line = revealedPropLine(p);
      const homes = Object.values(FRAGMENT_REGISTRY).flatMap((values) => Object.values(values)).filter((f) => (f.promptText ?? '').includes(line));
      expect(homes.map((f) => `${f.axis}=${f.value}`)).toEqual([`${p.axis}=${p.value}`]);
    }
  });
});
