/**
 * The free prompt must never name a token that does not exist. The color
 * rule renders its ramps + roles FROM the consumed-token manifest (the
 * set `tokens:off-manifest-token` checks against), so the prose and the
 * runtime cannot drift; this pins that derivation and sweeps the whole
 * rendered free prompt for off-manifest `--ggui-*` mentions.
 */
import { describe, expect, it } from 'vitest';
import { consumedTokenManifest } from '@ggui-ai/design/themes';
import {
  colorVocabularyFromManifest,
  renderFreeColorRule,
  FREE_COLOR_RULE,
} from './free-design-prompt.js';
import { buildSystemPrompt as buildProductionPrompt } from '../harness/runtime.js';
import { PIN_FIXTURES } from '../design-mode.pin.test.js';

const manifest = new Set(consumedTokenManifest);
/** Concrete `--ggui-*` mentions — a trailing `-` is a prefix pattern (`--ggui-color-*`), not a name. */
const mentionedTokens = (text: string): string[] =>
  [...new Set(text.match(/--ggui-[A-Za-z0-9-]+/g) ?? [])].filter((t) => !t.endsWith('-'));

describe('renderFreeColorRule — ramps and roles come from the manifest', () => {
  it('names only tokens the manifest defines (full `--ggui-color-*` mentions AND bare ramp steps)', () => {
    for (const t of mentionedTokens(FREE_COLOR_RULE)) expect(manifest.has(t), t).toBe(true);
    const bareSteps = FREE_COLOR_RULE.match(/\b(primary|neutral|success|warning|error|info)-\d+\b/g) ?? [];
    expect(bareSteps.length).toBeGreaterThan(0);
    for (const s of bareSteps) expect(manifest.has(`--ggui-color-${s}`), s).toBe(true);
  });

  it('renders every ramp with EXACTLY the steps the manifest carries, in ascending order', () => {
    const { ramps } = colorVocabularyFromManifest(consumedTokenManifest);
    expect(ramps.map((r) => r.family)).toEqual(['primary', 'neutral', 'success', 'warning', 'error', 'info']);
    for (const r of ramps) {
      const expected = consumedTokenManifest
        .map((t) => new RegExp(`^--ggui-color-${r.family}-(\\d+)$`).exec(t)?.[1])
        .filter((s): s is string => s !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
      expect(r.steps, r.family).toEqual(expected);
      expect(FREE_COLOR_RULE).toContain(`\`${r.family}-${expected.join('/')}\``);
    }
    // The old prose implied contiguous `50…800` state ramps — the manifest has gaps, and the rule says so.
    expect(FREE_COLOR_RULE).not.toMatch(/50…\d+/);
    expect(FREE_COLOR_RULE).toContain('A step not listed does not exist and renders unset');
  });

  it('covers every semantic (non-ramp) color role the manifest carries', () => {
    const { roles } = colorVocabularyFromManifest(consumedTokenManifest);
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) expect(FREE_COLOR_RULE).toContain(`\`${role}\``);
  });

  it('follows a different manifest: absent groups drop out, present steps render as-is', () => {
    const rule = renderFreeColorRule([
      '--ggui-color-primary-500',
      '--ggui-color-primary-900',
      '--ggui-color-ground',
      '--ggui-color-onGround',
      '--ggui-color-brandAccent',
      '--ggui-spacing-4',
    ]);
    expect(rule).toContain('`primary-500/900`');
    expect(rule).not.toContain('(plus bare `primary`)');
    expect(rule).not.toContain('State ramps');
    expect(rule).toContain('`ground` / `onGround` (the page / chat canvas behind everything + its text)');
    expect(rule).toContain('other roles: `brandAccent`');
    expect(rule).not.toContain('`neutral-');
  });
});

describe('the whole free prompt names only manifest tokens', () => {
  it('every concrete `--ggui-*` mention in both pin fixtures exists on the manifest', () => {
    for (const f of PIN_FIXTURES) {
      const prompt = buildProductionPrompt(f.userRequest, f.shellType, f.screen, undefined, undefined, undefined, 'free');
      const mentions = mentionedTokens(prompt);
      expect(mentions.length).toBeGreaterThan(50);
      for (const t of mentions) expect(manifest.has(t), t).toBe(true);
    }
  });
});
