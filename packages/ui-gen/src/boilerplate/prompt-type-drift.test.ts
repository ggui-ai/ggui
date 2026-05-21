/**
 * Prompt ↔ type drift guard.
 *
 * The coding-agent system prompt teaches primitive prop vocabularies
 * in TWO places: the hand-written `DESIGN_SYSTEM_GUIDANCE` prose and
 * the auto-generated primitive catalog (`PRIMITIVES_DOCUMENTATION_TS`,
 * regenerated from the real `@ggui-ai/design` `.d.ts` on every design
 * build). When the prose teaches an enum value the type rejects — or
 * the type gains a value the prose never teaches — the model burns
 * turns or silently misses a capability.
 *
 * This is exactly the bug this slice fixed: the prose taught
 * `gap="sm"` / `padding="lg"` while the design types had `gap` /
 * `padding` as raw `number | string` passthrough, so `gap="sm"`
 * emitted invalid CSS and the gap collapsed to 0.
 *
 * `PROMPT_ENUM_CLAIMS` mirrors the enum vocabulary `DESIGN_SYSTEM_
 * GUIDANCE` teaches. The tests assert that set EXACTLY equals the
 * catalog's type for that prop, and that the prose actually contains
 * each value. If a design type changes, this test fails — update the
 * claims table AND the `DESIGN_SYSTEM_GUIDANCE` prose together.
 */
import { describe, it, expect } from 'vitest';
import { DESIGN_SYSTEM_GUIDANCE } from './system-prompt.js';
import { PRIMITIVES_DOCUMENTATION_TS } from '../tools/get-primitives-ts.js';

interface EnumClaim {
  /** Catalog interface name, minus the `Props` suffix. */
  component: string;
  prop: string;
  /** The exact string-literal values the prompt teaches. */
  values: readonly string[];
}

const TONE = [
  'default', 'muted', 'subtle', 'emphasized', 'loud',
  'success', 'warning', 'error', 'info', 'inverse', 'inherit',
] as const;
const SURFACE = [
  'default', 'elevated', 'sunken', 'accent', 'inverted', 'transparent',
] as const;
const SPACING_SCALE = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const;
const RADIUS_SCALE = ['none', 'sm', 'md', 'lg', 'xl'] as const;

/**
 * Every enum vocabulary `DESIGN_SYSTEM_GUIDANCE` teaches, by prop.
 * Numeric props (`Heading.level`) are out of scope — string enums only.
 */
const PROMPT_ENUM_CLAIMS: readonly EnumClaim[] = [
  { component: 'Text', prop: 'variant', values: ['body', 'bodySmall', 'bodyLarge', 'caption', 'label', 'overline'] },
  { component: 'Text', prop: 'size', values: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'] },
  { component: 'Text', prop: 'weight', values: ['normal', 'medium', 'semibold', 'bold'] },
  { component: 'Text', prop: 'tone', values: TONE },
  { component: 'Heading', prop: 'tone', values: TONE },
  { component: 'Button', prop: 'variant', values: ['primary', 'secondary', 'outline', 'ghost', 'danger'] },
  { component: 'Button', prop: 'size', values: ['xs', 'sm', 'md', 'lg'] },
  { component: 'Card', prop: 'shadow', values: ['none', 'sm', 'md', 'lg', 'xl'] },
  { component: 'Card', prop: 'radius', values: RADIUS_SCALE },
  { component: 'Box', prop: 'radius', values: RADIUS_SCALE },
  { component: 'Image', prop: 'radius', values: RADIUS_SCALE },
  { component: 'Card', prop: 'surface', values: SURFACE },
  { component: 'Box', prop: 'surface', values: SURFACE },
  { component: 'Stack', prop: 'align', values: ['start', 'center', 'end', 'stretch'] },
  { component: 'Stack', prop: 'justify', values: ['start', 'center', 'end', 'between', 'around', 'evenly'] },
  { component: 'Row', prop: 'align', values: ['start', 'center', 'end', 'stretch'] },
  { component: 'Row', prop: 'justify', values: ['start', 'center', 'end', 'between', 'around', 'evenly'] },
  { component: 'Badge', prop: 'variant', values: ['default', 'primary', 'secondary', 'success', 'warning', 'error', 'info'] },
  { component: 'Stat', prop: 'trend', values: ['up', 'down', 'neutral'] },
  // Spacing scale — gap (Stack / Row / Grid), padding (Card / Box / Container).
  { component: 'Stack', prop: 'gap', values: SPACING_SCALE },
  { component: 'Row', prop: 'gap', values: SPACING_SCALE },
  { component: 'Grid', prop: 'gap', values: SPACING_SCALE },
  { component: 'Card', prop: 'padding', values: SPACING_SCALE },
  { component: 'Box', prop: 'padding', values: SPACING_SCALE },
  { component: 'Container', prop: 'padding', values: SPACING_SCALE },
];

/**
 * Extract the string-literal enum values of `prop` on `interface
 * ${component}Props` from the auto-generated catalog. Returns the
 * sorted `'literal'` tokens; `number` / `string` escape hatches in
 * the union are ignored.
 */
function catalogEnumLiterals(component: string, prop: string): string[] {
  const blockMatch = PRIMITIVES_DOCUMENTATION_TS.match(
    new RegExp(`interface ${component}Props \\{([\\s\\S]*?)\\n\\}`),
  );
  if (blockMatch === null) {
    throw new Error(`catalog has no interface ${component}Props`);
  }
  const propMatch = blockMatch[1].match(
    new RegExp(`\\n\\s*${prop}\\?:\\s*([^\\n]+?);`),
  );
  if (propMatch === null) {
    throw new Error(`catalog ${component}Props has no prop "${prop}"`);
  }
  return [...propMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** All backtick-delimited spans in the prose, split into value sets. */
const PROSE_VALUE_SETS: ReadonlySet<string>[] = [
  ...DESIGN_SYSTEM_GUIDANCE.matchAll(/`([^`]+)`/g),
].map((m) => new Set(m[1].split('|').map((v) => v.trim())));

describe('prompt ↔ type drift guard', () => {
  it.each(PROMPT_ENUM_CLAIMS)(
    '$component.$prop — prompt claims exactly match the catalog type',
    ({ component, prop, values }) => {
      const claimed = [...values].sort();
      const catalog = catalogEnumLiterals(component, prop);
      // Bidirectional: prompt teaches nothing the type rejects, and
      // the type has no enum value the prompt fails to teach.
      expect(catalog).toEqual(claimed);
    },
  );

  it.each(PROMPT_ENUM_CLAIMS)(
    '$component.$prop — every claimed value appears in DESIGN_SYSTEM_GUIDANCE prose',
    ({ component, prop, values }) => {
      const want = new Set(values);
      const taught = PROSE_VALUE_SETS.some((span) =>
        [...want].every((v) => span.has(v)),
      );
      expect(
        taught,
        `DESIGN_SYSTEM_GUIDANCE has no backtick span teaching ${component}.${prop} ` +
          `vocabulary {${values.join(', ')}}`,
      ).toBe(true);
    },
  );

  it('spacing-scale regression pin — gap/padding accept the t-shirt scale, not raw passthrough', () => {
    // The specific bug: gap/padding were `number | string` with no
    // name→token map, so `gap="sm"` emitted invalid CSS `gap: sm`.
    for (const [component, prop] of [
      ['Stack', 'gap'], ['Row', 'gap'],
      ['Card', 'padding'], ['Box', 'padding'], ['Container', 'padding'],
    ] as const) {
      const literals = catalogEnumLiterals(component, prop);
      for (const name of SPACING_SCALE) {
        expect(
          literals.includes(name),
          `${component}.${prop} no longer accepts the spacing-scale name "${name}"`,
        ).toBe(true);
      }
    }
  });
});
