// ggui#1325 — the off-manifest-token hint names the real token. Exp 012's
// logs: the most-invented name on both models was `--ggui-color-surfaceVariant`
// (retired by ggui#987; the current role is `sunken`), and invented motion
// names (`--ggui-motion-duration-normal`, `--ggui-duration-slow`,
// `--ggui-motion-easing-easeOut`) sent stuck cells guessing another name.
// Code-property tests against the live manifest: the RULE, not a byte pin.
import { describe, expect, it } from 'vitest';
import { consumedTokenManifest } from '@ggui-ai/design/themes';
import { runTier0Checks, suggestManifestTokens } from './run-tier0.js';

const DURATIONS = ['--ggui-motion-duration-base', '--ggui-motion-duration-fast', '--ggui-motion-duration-slow'];
const EASINGS = ['--ggui-motion-easing-emphasized', '--ggui-motion-easing-exit', '--ggui-motion-easing-standard'];

describe('suggestManifestTokens (ggui#1325)', () => {
  it('names the successor of a role ggui#987 retired', () => {
    expect(suggestManifestTokens('--ggui-color-surfaceVariant')).toEqual(['--ggui-color-sunken']);
    expect(suggestManifestTokens('--ggui-color-onSurfaceVariant')).toEqual(['--ggui-color-onSunken']);
    expect(suggestManifestTokens('--ggui-color-surface')).toEqual(['--ggui-color-container']);
    expect(suggestManifestTokens('--ggui-color-onSurface')).toEqual(['--ggui-color-onContainer']);
  });

  it('every successor it names exists in the manifest', () => {
    for (const invented of ['--ggui-color-surfaceVariant', '--ggui-color-onSurfaceVariant', '--ggui-color-surface', '--ggui-color-onSurface']) {
      for (const token of suggestManifestTokens(invented)) expect(consumedTokenManifest).toContain(token);
    }
  });

  it('an invented motion name gets its family by the longest shared prefix at a segment boundary', () => {
    expect([...suggestManifestTokens('--ggui-motion-duration-normal')].sort()).toEqual(DURATIONS);
    expect([...suggestManifestTokens('--ggui-motion-duration-slower')].sort()).toEqual(DURATIONS);
    expect([...suggestManifestTokens('--ggui-motion-easing-easeOut')].sort()).toEqual(EASINGS);
  });

  it('a name with no family prefix in the manifest is matched by its words', () => {
    expect([...suggestManifestTokens('--ggui-duration-slow')].sort()).toEqual(DURATIONS);
  });

  it('an empty-suffix name (the model stopped mid-name) gets its own family, roles before ramp steps', () => {
    const colour = suggestManifestTokens('--ggui-color-');
    expect(colour.length).toBeGreaterThan(20);
    expect(colour.every((token) => token.startsWith('--ggui-color-'))).toBe(true);
    expect(colour.slice(0, 8).every((token) => !/^\d+$/.test(token.slice(token.lastIndexOf('-') + 1)))).toBe(true);
    expect(colour).toContain('--ggui-color-sunken');
    const spacing = suggestManifestTokens('--ggui-spacing-');
    expect(spacing.length).toBeGreaterThan(0);
    expect(spacing.every((token) => token.startsWith('--ggui-spacing-'))).toBe(true);
  });

  it('a name near nothing yields nothing, so the hint falls back to the manifest’s general shape', () => {
    expect(suggestManifestTokens('--ggui-zzzz-qqqq')).toEqual([]);
  });
});

describe("the off-manifest-token issue's fix names the real token (ggui#1325)", () => {
  const card = (token: string) => `
interface Props { x: string }
export default function C(props: Props) {
  return <div style={{ background: 'var(${token})' }}>{props.x}</div>;
}`;
  const offManifestFix = async (token: string): Promise<string> => {
    const issues = await runTier0Checks(card(token));
    const off = issues.filter((i) => i.category === 'tokens' && i.subcategory === 'off-manifest-token');
    expect(off).toHaveLength(1);
    return off[0]!.fix ?? '';
  };

  it('a retired role: the fix says it was retired and names the successor first', async () => {
    const fix = await offManifestFix('--ggui-color-surfaceVariant');
    expect(fix.startsWith('"--ggui-color-surfaceVariant" was retired')).toBe(true);
    expect(fix).toContain('var(--ggui-color-sunken)');
  }, 30_000);

  it('an invented motion name: the fix lists the family', async () => {
    const fix = await offManifestFix('--ggui-motion-duration-normal');
    for (const token of DURATIONS) expect(fix).toContain(`var(${token})`);
    expect(fix).not.toContain('was retired');
  }, 30_000);

  it('an empty-suffix colour name: the fix leads with roles and counts the rest', async () => {
    const fix = await offManifestFix('--ggui-color-');
    expect(fix.startsWith('Nearest names in the manifest: var(--ggui-color-')).toBe(true);
    expect(fix).toMatch(/and \d+ more in that family/);
    expect(fix.slice(0, fix.indexOf('more in that family'))).not.toMatch(/--ggui-color-\d+\)/);
  }, 30_000);

  it('a name near nothing: the fix keeps the manifest\'s general shape and still names no literal', async () => {
    const fix = await offManifestFix('--ggui-zzzz-qqqq');
    expect(fix).not.toContain('Nearest names');
    expect(fix).toContain('Choose a token that exists');
    expect(fix).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+px/);
  }, 30_000);
});
