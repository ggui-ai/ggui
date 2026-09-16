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
// Re-recorded 2026-09-12 for ggui#1047: the surface span says `inverted` and `hero` OWN their ground — never a
// `background` in their `style` (tier-0 `universal.scoped_surface_owns_ground` fails it) — constrained only.
// Re-recorded 2026-09-14 for ggui#1075 Track A/B (receipted on #1096): the shared HARD section
// `FRAME_SIZING` (the frame owns the height — never `100vh` / `100dvh` as a height) lands after
// DATA_PARAMETERIZATION in BOTH arms, the constrained shell sentence says the frame stretches the
// root (size to content, never to the viewport), the free canvas sentence says the host owns the
// height, and DATA_PARAMETERIZATION's duplicated rule number is fixed (4, 4 → 4, 5) — both prompt
// digests move together (constrained 9f0fd697… → 8e90aa7e…, free 6be6526c… → dc5a2f4d…); the
// boilerplate digests are untouched. INVARIANT 1 holds across the re-record; the eval leg gained
// tier-0 `universal.viewport_sized` in the same cut.
// Re-recorded 2026-09-15 for ggui#1108's MITIGATION (the triad leg; protocol's contract +
// runtime halves are the fix): a shared HARD section `TERMINAL_ACTIONS` — an action the user
// means once disables its control after it fires, with a word that says so, and an action they
// can mean repeatedly stays armed — moves BOTH prompt digests together (constrained 8e90aa7e…
// → 3ea37864…, free dc5a2f4d… → 66667f5f…). BOTH BOILERPLATE digests move too, which is rarer
// and deliberate: the action-hook scaffold's inline comment gains the reminder at the exact
// site the model writes the handler (`— if this is meant ONCE, disable its control after it
// fires`). INVARIANT 1 holds across the re-record; the eval leg gained the WARN-level
// `universal.terminal_action_unguarded` in the same cut.
// Re-recorded 2026-09-15 for ggui#1113, the CONSTRAINED BOILERPLATE too — and that is the
// load-bearing half. The prompt rule alone measured ZERO: an A/B on the `lg` canvas (haiku,
// n=4 per arm) produced a width-capped ROOT in 4/4 takes both before and after, because the
// fullscreen LAYOUT SCAFFOLD the model fills in was literally `<Container maxWidth="xl"
// padding="lg">`. The prompt said "never cap the root" while the boilerplate handed it a
// capped root — the two legs disagreeing, which is the thing the triad rule exists to catch.
// The three fullscreen scaffolds now open `<Box padding="…">` with the measure-cap advice at
// the site. Free-arm boilerplate unmoved (it ships no layout scaffold).
// Re-recorded 2026-09-15 for ggui#1113: `FRAME_SIZING` gains the WIDTH half — the frame owns
// the width too, so the outermost element FILLS it and a width cap belongs INSIDE, on the column
// that holds text (60–70 characters), never on the root. Both prompt digests move together
// (constrained 3ea37864… → 8ba350be…, free 66667f5f… → 8b963ccb…); the boilerplates are
// untouched. Bought by a served take: a hello whose root was `<Container maxWidth="sm">` read as
// a centred 480 px column on the 768 px canvas and flush-left at 400 — one composition, two
// pictures, chosen by a preset the model reached for with nothing telling it what the canvas was
// for. INVARIANT 1 holds across the re-record.
// Re-recorded 2026-09-15 for ggui#1108 (the NARROWING): `TERMINAL_ACTIONS` stops handing the model
// the judgement and gives it a test — a second press is a mistake only when it would make a SECOND
// THING HAPPEN IN THE WORLD; writing the same state again (save, update, rename, toggle) is
// idempotent and stays armed — plus evidence (the request names a commitment, or the action's line
// carries the author's `confirm` flag) and a default of ARM WHEN IN DOUBT. Both prompt digests move
// together (constrained 5a9e5f57… → 199ccb14…, free 733b4916… → 2c70eb64…); the boilerplates are
// untouched. Bought by a measured false positive: the canonical `save` contract came back guarded
// 4/4 under the first wording against 0/4 before it (`a2b4575ca` vs `e952dc617`, n=4/arm, Fisher
// one-sided p ≈ 0.014), and the guarded control — `{submitted ? 'Saved' : 'Save'}` — is what turned
// three OSS wire-scenarios red. The error asymmetry is the reason for the new default: a terminal
// action left armed is the behaviour we have always had; a repeatable control guarded TAKES AWAY
// something that worked. The section does NOT cite the contract's `confirm` flag: citing it
// MEASURED ZERO — two wordings, n=4 each, a `save` action carrying `confirm: true` came back armed
// 0/4 and 0/4, because the field's own doc says "whether to show confirmation BEFORE triggering",
// which is gravity and not one-shot-ness, and the model reads it that way. The flag is still
// rendered into the contract context as INFORMATION (it was the one declared action field the
// renderer dropped), never as a rule. INVARIANT 1 holds across the re-record.
// Re-recorded 2026-09-17 for ggui#1093 (the harvest half — radius by ROLE): the primitive catalog's
// four control docblocks (Button / Input / Select / TextArea) now name `--ggui-shape-radius-control`
// — the host's button/field radius, falling to the `md` stop — instead of `--ggui-shape-radius-md`.
// Bought by a measurement (guuey-team-landing, guuey#1320): on real host pages cards sit at 2–12px
// while buttons are pills on two of eight, and one ladder cannot say that. The catalog is generated
// from `design/src/primitives/types.ts` on every design build, so the four lines are the WHOLE prompt
// delta (2530 lines → 2530, 4 changed); both prompt digests move together (constrained 199ccb14… →
// 65e0ae7e…, free 2c70eb64… → e3a42df1…); the boilerplates are untouched. INVARIANT 1 holds across the re-record.
// Re-recorded 2026-09-17 for ggui#1108 (the runtime one-shot half): the wire
// docblock `WireConfig.onDispatchSuppressed` now documents BOTH suppression
// invariants (task-scoped duplicate + render-lifetime one-shot). The wire
// catalog `get-wire.ts` is generated from that JSDoc and rides the prompt as
// `wireDoc` (harness/runtime.ts), a HARD section both arms carry — so BOTH
// prompt digests move together (constrained 65e0ae7e… → 10000dbe…, free
// e3a42df1… → 4480e86b…); the boilerplates are untouched. INVARIANT 1 holds.
export const CONSTRAINED_PROMPT_SHA256 =
  '10000dbe2ab23fc633d5f6d3419783ca4042911152b0df334dc274c67f37f561';
export const CONSTRAINED_BOILERPLATE_SHA256 =
  'cea6b88db0a4491816d21c9fc51718555bd6627c55fde5aac68116fd52e0e6b6';

// ── Free-mode pins — drift detectors, updated deliberately with the arm ──
// Re-recorded 2026-09-10 (#987 wave, design half: manifest v2 + surface-layering token
// roles) — the free color rule renders the consumed-token manifest, so the free prompt
// moved with it; the constrained digest was re-recorded for the same change by #989 and
// is untouched here (INVARIANT 1 holds across the re-record).
// 2026-09-14 (ggui#1075 Track A): DATA_PARAMETERIZATION gained rule 4 — copy
// comes from the props; no invented eyebrow / kicker / helper / status text
// — a HARD section both arms share, so BOTH prompt digests move together
// (constrained 1e081ec5… → 9f0fd697…, free da780d39… → 6be6526c…); the
// boilerplate digests are untouched. INVARIANT 1 (constrained ≡ free's
// shared text) holds across the re-record; the eval leg gained
// `universal.caps_label_invented` in the same cut.
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
// Re-recorded 2026-09-12 for ggui#1047: the manifest gains `onInverted` (the ink `tone="inverse"` reads — the page's
// container, re-declared on every inverted / hero scope root as that surface's ink) — constrained unmoved.
// Re-recorded 2026-09-12 for ggui#1051: the manifest gains `inverseOutline` + `heroOutline` (the outline a scoped surface
// draws on its own ground, derived to clear 3:1) — constrained unmoved.
// Re-recorded 2026-09-15 for ggui#1108 (the NARROWING) — see the constrained note above; both arms share the section.
// Re-recorded 2026-09-17 for ggui#1093 (radius by ROLE — the four control docblocks in the catalog, see the constrained note above); both arms carry the catalog.
// Re-recorded 2026-09-17 for ggui#1108 (the wire catalog rides the prompt, see the constrained note above).
export const FREE_PROMPT_SHA256 =
  '4480e86bb407d32c0ccc75a3310877d21e7d87fe003c5fb28009efee47af78e6';
export const FREE_BOILERPLATE_SHA256 =
  '4e3cb2321931c95336be251623906ef866aa1a0a83bee6a0c2b3ada756210ef7';

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
