/**
 * INVARIANT-1 pin — `designMode: 'constrained'` (the default) is
 * byte-identical to the pre-`designMode` triad.
 *
 * The sha256 constants below were recorded from the UNMODIFIED code
 * (before the `designMode` option existed) by running this very file
 * with `GGUI_PIN_PRINT=1`, which logs the current digests:
 *
 *   GGUI_PIN_PRINT=1 pnpm --filter @ggui-ai/ui-gen exec vitest run \
 *     src/design-mode.pin.test.ts
 *
 * Two fixed fixtures — one action-bearing `chat`×`mobile` shell, one
 * `fullscreen`×`desktop` with a `contextSpec` — are rendered through
 * (a) the production system-prompt stack (`harness/runtime.ts`
 * `buildSystemPrompt`, which pre-fills pitfalls + design docs +
 * primitives + wire docs) and (b) `generateBoilerplate`. The digest is
 * over BOTH fixtures' outputs joined, so any drift in either shows.
 *
 * A second pin covers the `free` prompt + boilerplate so drift in the
 * experimental arm is visible too (that constant is expected to move
 * whenever the free-design prompt is deliberately edited — update it in
 * the same commit).
 *
 * The pitfalls block is env-gated (`GGUI_PITFALLS`); the digests assume
 * both env vars are unset, which the `beforeAll` enforces.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIN_FIXTURES } from './pin-fixtures.js';
import { buildSystemPrompt as buildProductionPrompt } from './harness/runtime.js';
import { generateBoilerplate } from './boilerplate/generate.js';
import { buildSystemPrompt as buildSkeletonPrompt } from './boilerplate/system-prompt.js';

const JOIN = '\n<<<pin-fixture-boundary>>>\n';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Render the production prompt stack for every fixture (positional wrapper — the pre-`designMode` signature). */
function renderConstrainedPrompts(): string {
  return PIN_FIXTURES.map((f) =>
    buildProductionPrompt(f.userRequest, f.shellType, f.screen),
  ).join(JOIN);
}

function renderConstrainedBoilerplates(): string {
  return PIN_FIXTURES.map((f) =>
    generateBoilerplate(f.userRequest, f.contract, f.shellType, f.screen),
  ).join(JOIN);
}

/** Free-mode prompt for every fixture — designMode threaded positionally; canvas derived from shell × screen. */
function renderFreePrompts(): string {
  return PIN_FIXTURES.map((f) =>
    buildProductionPrompt(
      f.userRequest,
      f.shellType,
      f.screen,
      undefined,
      undefined,
      undefined,
      'free',
    ),
  ).join(JOIN);
}

function renderFreeBoilerplates(): string {
  return PIN_FIXTURES.map((f) =>
    generateBoilerplate(
      f.userRequest,
      f.contract,
      f.shellType,
      f.screen,
      undefined,
      undefined,
      'free',
    ),
  ).join(JOIN);
}

// ── Recorded from the UNMODIFIED code (see header) ──────────────────────
// Re-recorded 2026-09-10 for ggui#989: the prompts' colour vocabulary
// moved to the surface-layering roles (ggui#987 §2.1 — ground /
// container / elevated / sunken + their on* inks) in the SAME slice for
// both arms, so INVARIANT 1 (constrained ≡ free's shared text) holds
// across the re-record; the boilerplate digests did not move.
// Re-recorded 2026-09-12 for ggui#1015: the Icon line now says only the
// curated Lucide subset renders (call `get_available_icons`; an unknown
// name renders an empty box and fails `universal.icon_name_known`), and
// the primitives doc's Icon blurb moved with the design JSDoc — both arms
// moved in the SAME slice (the free prompt carries the doc as its optional
// catalog reference), so INVARIANT 1 holds across the re-record; the
// boilerplate digests did not move.
// Re-recorded 2026-09-12 for ggui#1024: the primitives doc's `surface`
// bullet now says an inverted surface owns ALL its inks (no
// `tone="inverse"`) — doc text only, both arms again, boilerplates unchanged.
// Re-recorded 2026-09-12 for ggui#1034: the Button `outline` variant's doc line (label in the
// surface's on-colour, brand on the border) — doc text only, both arms, boilerplates unchanged.
// Re-recorded 2026-09-12 for ggui#1035: the `loud` tone doc line (the theme's readable accent ink) — doc text only, both arms.
// Re-recorded 2026-09-12 for ggui#1031 L2 (the hero ground): the Hero recipe names `surface="hero"`
// (the one prompt line the pre-registration allows), the token docs gain the heroGround pair, the
// primitives reference gains the `hero` surface — both arms, boilerplates unchanged.
// Re-recorded 2026-09-12 for ggui#1039: the token docs name `link` as the accent-TEXT role (eyebrows,
// taglines, links, labels, inline arrows) and primary-500/600 as fills; the Branded Color Strategy table
// splits its accent row; the stale duplicate container rows leave — doc text only, both arms, boilerplates unchanged.
// Re-recorded 2026-09-12 for ggui#1031 L2's drift-guard follower: the guidance's `surface` span teaches
// `hero` (the catalog union already carried it; `prompt-type-drift.test.ts` was red on that) — constrained only.
export const CONSTRAINED_PROMPT_SHA256 =
  'c2c500248e2d6ef45c28ff8f8c4a94be3cf7984dfd476df34b6f8d85dbaaed36';
export const CONSTRAINED_BOILERPLATE_SHA256 =
  '1e381757a28da471fcc3ba0b380da852d9955733b71c6ced72110444a079a9f1';

// ── Free-mode pins — drift detectors, updated deliberately with the arm ──
// Re-recorded 2026-09-10 (#987 wave, design half: manifest v2 + surface-layering token
// roles) — the free color rule renders the consumed-token manifest, so the free prompt
// moved with it; the constrained digest was re-recorded for the same change by #989 and
// is untouched here (INVARIANT 1 holds across the re-record).
// Re-recorded 2026-09-12 for ggui#1015 (see the constrained note above):
// the optional component-catalog reference carries the Icon blurb.
// Re-recorded 2026-09-12 for ggui#1024 (the `surface` bullet, see above).
// Re-recorded 2026-09-12 for ggui#1034 (the Button `outline` doc line, see above).
// Re-recorded 2026-09-12 for ggui#1035 (the `loud` doc line, see above).
// Re-recorded 2026-09-12 for ggui#1036: the free prompt renders the consumed-token manifest, which grew by the tone container pairs Tag now reads.
// Re-recorded 2026-09-12 for ggui#1031 L2 (the hero ground pair in the token docs + manifest).
// Re-recorded 2026-09-12 for ggui#1039: the free roles prose gains the `link` row (accent TEXT), see above.
// Re-recorded 2026-09-12 for ggui#1043: the consumed-token manifest grew by `heroLink` + `inverseLink` (the accents the hero /
// inverted scopes walk against their own ground); the free colour vocabulary renders the manifest — constrained unmoved.
export const FREE_PROMPT_SHA256 =
  '6ede4a7559f69ea767aae4dab4a3708765fae5c35d515b1a7ce4b3693fd9517d';
export const FREE_BOILERPLATE_SHA256 =
  '193dc2bed1cb963ad2e9eb30005d6402ba9cfe5d8fa0184e93cbe2594b0c0743';

/** `## ` / `### ` headings, in order, of the free prompt (fixture A). */
export const FREE_PROMPT_SECTIONS: readonly string[] = [
  '## Your Task',
  '## Rendering canvas',
  '## How It Works',
  '## Priority (P0 first, then P1, then P2)',
  '## Protocol Notes',
  '## Contract surface — four specs + two catalogs',
  '## Defensive coding for absent / late-arriving data',
  '## Picking the right primitive for user gestures',
  '## One gesture surface per action binding',
  '## Anti-patterns — DO NOT WRITE',
  '## Cross-reference rules',
  '## clientCapabilities — registered catalog',
  '## Observable state via `contextSpec`',
  '## Reference: Wire Hooks',
  '## Design freedom',
  '## Color stays tokenized (the one hard styling rule)',
  '## Where this renders',
  '## Budgets (deterministic caps)',
  '## Imports & security (what you may import, what you may not call)',
  '## Data Parameterization (CRITICAL)',
  '## Component Structure',
  '## Responsive invariant',
  '## Accessibility (REQUIRED)',
  '## Quality Checklist (verify before returning)',
  '### Reference (optional): theme token vocabulary',
  '### Reference (optional): `@ggui-ai/design` component catalog',
];

/** Top-level headings of a prompt, skipping fenced code blocks and the injected doc blocks' own headings. */
function skeletonHeadings(prompt: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of prompt.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    if (/^##?#? /.test(line) && FREE_PROMPT_SECTIONS.includes(line)) out.push(line);
  }
  return out;
}

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['GGUI_PITFALLS', 'GGUI_NEW_PITFALLS']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('free-design pin — drift in the experimental arm is visible', () => {
  it('prompt digest matches the recorded constant', () => {
    const rendered = renderFreePrompts();
    const digest = sha256(rendered);
    if (process.env.GGUI_PIN_PRINT === '1') {
      console.log(`FREE_PROMPT_SHA256=${digest}`);
    }
    // Review aid: GGUI_PIN_DUMP_DIR=<dir> writes both arms' fixture-A prompts + boilerplates.
    const dumpDir = process.env.GGUI_PIN_DUMP_DIR;
    if (dumpDir) {
      mkdirSync(dumpDir, { recursive: true });
      writeFileSync(join(dumpDir, 'free-prompts.md'), rendered);
      writeFileSync(join(dumpDir, 'constrained-prompts.md'), renderConstrainedPrompts());
      writeFileSync(join(dumpDir, 'free-boilerplates.tsx'), renderFreeBoilerplates());
      writeFileSync(join(dumpDir, 'constrained-boilerplates.tsx'), renderConstrainedBoilerplates());
    }
    expect(digest).toBe(FREE_PROMPT_SHA256);
  });

  it('boilerplate digest matches the recorded constant', () => {
    const digest = sha256(renderFreeBoilerplates());
    if (process.env.GGUI_PIN_PRINT === '1') {
      console.log(`FREE_BOILERPLATE_SHA256=${digest}`);
    }
    expect(digest).toBe(FREE_BOILERPLATE_SHA256);
  });

  it('renders exactly the documented sections, in order (INVARIANT 2 — the hard sections stay, the design-only blocks go)', () => {
    const f = PIN_FIXTURES[0]!;
    const prompt = buildProductionPrompt(
      f.userRequest, f.shellType, f.screen, undefined, undefined, undefined, 'free',
    );
    expect(skeletonHeadings(prompt)).toEqual([...FREE_PROMPT_SECTIONS]);
    // Design-only blocks are gone …
    for (const gone of [
      '## Design System Usage (CRITICAL)',
      '### Branded Color Strategy',
      '## Aesthetic Guidance',
      '## Making a primitive interactive',
      '## Common Pitfalls',
      'DO NOT use raw HTML elements',
      'EXACT primitive prop values',
    ]) {
      expect(prompt).not.toContain(gone);
    }
    // … the canvas is stated explicitly (chat × mobile → xs-chat-card) …
    expect(prompt).toContain('renders on the `xs-chat-card` canvas');
    // … and the hard sections are byte-identical to the constrained prompt.
    const constrained = buildProductionPrompt(f.userRequest, f.shellType, f.screen);
    for (const marker of ['## Protocol Notes', '## Contract surface', '## Defensive coding', '## Observable state via']) {
      const grab = (p: string): string => {
        const i = p.indexOf(marker);
        return p.slice(i, p.indexOf('\n\n## ', i + marker.length));
      };
      expect(grab(prompt)).toBe(grab(constrained));
    }
  });

  it('constrained prompt ignores `canvas` (INVARIANT 1 holds with the new input present)', () => {
    const f = PIN_FIXTURES[1]!;
    const withoutCanvas = buildSkeletonPrompt({ userRequest: f.userRequest, shellType: f.shellType, screen: f.screen });
    const withCanvas = buildSkeletonPrompt({ userRequest: f.userRequest, shellType: f.shellType, screen: f.screen, canvas: 'xl', designMode: 'constrained' });
    expect(withCanvas).toBe(withoutCanvas);
  });

  it('free boilerplate keeps the wire hooks / Props / stream / context blocks EXACTLY and drops only the design import + layout scaffold', () => {
    for (const f of PIN_FIXTURES) {
      const constrained = generateBoilerplate(f.userRequest, f.contract, f.shellType, f.screen);
      const free = generateBoilerplate(f.userRequest, f.contract, f.shellType, f.screen, undefined, undefined, 'free');
      expect(free).not.toMatch(/^import .* from '@ggui-ai\/design'/m);
      expect(free).not.toMatch(/<(Card|Container) /);
      // Every DO-NOT-EDIT block of the constrained boilerplate appears verbatim in the free one.
      const blocks = constrained.match(/\/\/ DO NOT EDIT — [^\n]*\n[\s\S]*?(?=\n\/\* eslint-enable|\n\n)/g) ?? [];
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(free).toContain(block);
      const hookLines = constrained.split('\n').filter((l) => /useAction<|useStream<|useGguiContext</.test(l));
      expect(hookLines.length).toBeGreaterThan(0);
      for (const line of hookLines) expect(free).toContain(line);
      expect(free).toContain("from '@ggui-ai/wire'");
      expect(free).toContain('export default function Component(props: Props)');
    }
  });
});

describe('INVARIANT 1 — constrained triad is byte-identical to the pre-designMode code', () => {
  it('prompt digest matches the recorded constant', () => {
    const digest = sha256(renderConstrainedPrompts());
    if (process.env.GGUI_PIN_PRINT === '1') {
      console.log(`CONSTRAINED_PROMPT_SHA256=${digest}`);
    }
    expect(digest).toBe(CONSTRAINED_PROMPT_SHA256);
  });

  it('boilerplate digest matches the recorded constant', () => {
    const digest = sha256(renderConstrainedBoilerplates());
    if (process.env.GGUI_PIN_PRINT === '1') {
      console.log(`CONSTRAINED_BOILERPLATE_SHA256=${digest}`);
    }
    expect(digest).toBe(CONSTRAINED_BOILERPLATE_SHA256);
  });
});
