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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIN_FIXTURES } from './pin-fixtures.js';
import { buildSystemPrompt as buildProductionPrompt } from './harness/runtime.js';
import { generateBoilerplate } from './boilerplate/generate.js';
import { buildSystemPrompt as buildSkeletonPrompt } from './boilerplate/system-prompt.js';
import {
  generatorBuild,
  renderBoilerplateTemplates,
  renderPromptTemplates,
  templateSha256 as sha256,
} from './generator-build.js';

// The canonical renders (and the hash) live with the runtime build identity
// (`generator-build.ts`, ggui#1280) — the pin hashes the SAME functions the
// generator stamps, so the recorded constants and the runtime key cannot drift.
const renderConstrainedPrompts = (): string => renderPromptTemplates('constrained');
const renderConstrainedBoilerplates = (): string => renderBoilerplateTemplates('constrained');
const renderFreePrompts = (): string => renderPromptTemplates('free');
const renderFreeBoilerplates = (): string => renderBoilerplateTemplates('free');

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
// Re-recorded 2026-09-17 for ggui#1122 (C — the prompt-alignment half of the
// axis-checks-at-auto-commit relocation): DATA_PARAMETERIZATION rule 4 names the
// caps eyebrow concretely ("Do NOT add a caps label above the heading") and the
// icon line carries an inline safe-list of curated-subset names + the traps
// (`edit-2`/`pencil` are NOT in the set) so a single-pass serve needs no tool
// call. Both are shared HARD sections, so BOTH prompt digests move together
// (constrained 10000dbe… → 32544073…, free 4480e86b… → 7f0a6964…); the
// boilerplates are untouched. INVARIANT 1 holds. Bought a measured drop: on the
// same haiku serve profile, caps-label fails 10 → 2 and icon fails 3 → 0, mean
// attempts 4.0 → 2.3, the two ≥6 runs gone.
// Re-recorded 2026-09-20 for ggui#1190 + ggui#1106 — two landings that shipped without this
// file being run, re-recorded together. ggui#1190 (an action's control copy is the contract's
// `label` VERBATIM): DATA_PARAMETERIZATION rule 4 gains the sentence — every character,
// including `&`, `/`, `–` and quotes; never paraphrased, shortened or re-cased — a shared HARD
// section, so BOTH prompt digests move together; and the action-hook scaffold's inline comment
// now carries `control copy: "<label>" VERBATIM` at the hook site for every action, so BOTH
// BOILERPLATE digests move too (fixture A's `toggleTodo` line is the whole boilerplate delta;
// fixture B declares no action). ggui#1106 (motion through variables): the primitive catalog,
// generated from `design/src/primitives/types.ts`, now states four transitions as
// `var(--ggui-motion-duration-*)` / `var(--ggui-motion-easing-*)` instead of literal ms and
// easing names (a chevron rotation, a ground transition, two hover transitions); both arms
// carry the catalog, so both prompt digests move for it as well. Constrained prompt
// 32544073… → 040bd0a3…, free prompt 7f0a6964… → 71ef8019…; constrained boilerplate
// cea6b88d… → 8f1dfd89…, free boilerplate 4e3cb232… → b9b86589…. INVARIANT 1 holds across
// the re-record: the shared hunks are byte-identical in both arms' dumps (eight prompt hunks,
// one boilerplate hunk, the same text in each); the free arm ALSO moves by the consumed-token
// manifest — see the free note.
// Re-recorded 2026-09-23 for ggui#1244 — BOTH BOILERPLATE digests, nothing else: ggui#1190's copy
// reminder (`— control copy: "<label>" VERBATIM`) moves OFF the action hook line and onto the action's
// payload-type doc comment, so the hook line is byte-identical to its pre-#1190 form again (fixture A's
// `toggleTodo` pair of lines is the whole delta, the same two lines in each arm). Bought by a measured
// false positive: beside ggui#1108's once-hint on the hook line, gemini-3.5-flash-lite guarded the wire
// scenarios' repeatable Save 8/8 (the nightly OSS E2E matrix red four nights); split, 5/24 — within noise
// of the rate before either hint moved (1/8) — with one-time commitments still guarded 40/40 across three
// providers and every label verbatim. Removing the once-hint instead cost the true positive (9/12), so it stays.
// Constrained boilerplate 8f1dfd89… → d030418c…, free boilerplate b9b86589… → a33e33a7…; both prompt
// digests are byte-stable. INVARIANT 1 holds: the two arms' boilerplate hunks are byte-identical.
// Re-recorded 2026-09-23 for ggui#1279 — the CONSTRAINED BOILERPLATE only (the variant B″ of
// reliability/010 → 011, accepted by the founder): the chat layouts (`chat-universal`, `chat-mobile`)
// stop drawing their own card chrome — they were `<Card padding="sm" shadow="sm">` while the chat shell
// hint says the parent bubble provides border + shadow — and become a `<Box padding="md">` inline card
// that says so, with the frame-sizing rule's line: the root fills the bubble, and PROSE takes the
// reading cap inside it (`<Container maxWidth="sm">`, inert at bubble width). Fixture A is chat×mobile,
// so its layout lines are the whole delta; fixture B (fullscreen×desktop) and the free arm are
// untouched, and both prompt digests are byte-stable. Constrained boilerplate d030418c… → 2afbb69a….
export const CONSTRAINED_PROMPT_SHA256 =
  '040bd0a3c00768e73df375b706e9b436537bf5efacbcd7b4f1ef5fd8b1a6a4ca';
export const CONSTRAINED_BOILERPLATE_SHA256 =
  '2afbb69a4c07a98058d56148718068bf00be63b172a609397da20d78bc12cb22';

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
// Re-recorded 2026-09-17 for ggui#1122 C (the caps + icon prompt rules are shared, see the constrained note above).
// Re-recorded 2026-09-20 for ggui#1190 + ggui#1106 (the shared text — see the constrained note
// above). The free arm moves by ONE thing more: it renders the consumed-token manifest, which
// ggui#1106 grew by the six `--ggui-motion-{duration-fast,duration-base,duration-slow,
// easing-standard,easing-emphasized,easing-exit}` entries (123 → 129); the constrained arm does
// not render the manifest. Receipt: with `ui-gen/src` + `design/src` swapped back to the previous
// re-record (4edc964a9) against the current design build, the other three digests returned to
// their constants and this one alone did not (3ac8c035…) — the manifest is read from the built
// package, and that residue is the manifest.
// Re-recorded 2026-09-20 for ggui#1083 (cut 1 — the scrim reaches the card's own pages): the
// consumed-token manifest gains `--ggui-scrim-tint` + `--ggui-scrim-opacity` (129 → 131), which the
// free prompt renders; constrained does not render the manifest, and no HARD section, catalog or
// scaffold moved, so the other three digests are byte-stable. Free prompt 71ef8019… → 5f8196ac…
// (read against a REBUILT design dist — the pin reads the manifest from the built package, so a
// stale dist reports no move where CI's fresh build does).
export const FREE_PROMPT_SHA256 =
  '5f8196acd8223abd3004e6a010a0da3e8e62d88fafb75bf3d5f6e44138db8429';
// Re-recorded 2026-09-23 for ggui#1244 (the copy reminder moves from the hook line to the payload-type
// doc comment — see the constrained note above); the free prompt is byte-stable.
export const FREE_BOILERPLATE_SHA256 =
  'a33e33a71580fd493e12e1e3c87b4af943a588e2800eb2da8f7049af6fca61cb';

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

describe('the runtime build identity IS the pinned digest (ggui#1280)', () => {
  it('under the default env, generatorBuild() stamps exactly the four recorded constants', () => {
    const constrained = generatorBuild('constrained');
    const free = generatorBuild('free');
    expect(constrained.digests.promptTemplateSha256).toBe(CONSTRAINED_PROMPT_SHA256);
    expect(constrained.digests.boilerplateTemplateSha256).toBe(CONSTRAINED_BOILERPLATE_SHA256);
    expect(free.digests.promptTemplateSha256).toBe(FREE_PROMPT_SHA256);
    expect(free.digests.boilerplateTemplateSha256).toBe(FREE_BOILERPLATE_SHA256);
  });
});
