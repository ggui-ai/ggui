import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { describe, expect, it } from 'vitest';
import { computeRendererDigest, RENDERER_INPUTS } from '../scripts/renderer-digest.mjs';
import {
  isSocialCardKey,
  keyFor,
  SOCIAL_CARD_KEY_LENGTH,
  socialCardKey,
  socialCardKeyFromImage,
} from './card-key.js';
import { socialCardFonts } from './fonts.js';
import { SOCIAL_CARD_RENDERER_DIGEST } from './renderer-digest.js';
import { DEFAULT_EYEBROW, renderSocialCard, SOCIAL_CARD_SIZE, type SocialCardInput } from './social-card.js';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const input: SocialCardInput = {
  surface: 'DOCS',
  title: 'Agents describe.\nInterfaces appear.',
  description: 'An optional line.',
  footer: { url: 'docs.ggui.ai', fact: 'MCP-NATIVE · SELF-HOST OR HOSTED' },
};

describe('socialCardKey', () => {
  it('is a well-formed key, stable for the same input', () => {
    const key = socialCardKey(input);
    expect(key).toHaveLength(SOCIAL_CARD_KEY_LENGTH);
    expect(isSocialCardKey(key)).toBe(true);
    expect(socialCardKey({ ...input })).toBe(key);
  });

  it('does not depend on key order, and an omitted eyebrow keys like the default it renders as', () => {
    const reordered: SocialCardInput = {
      footer: { fact: input.footer.fact, url: input.footer.url },
      description: input.description,
      title: input.title,
      surface: input.surface,
    };
    expect(socialCardKey(reordered)).toBe(socialCardKey(input));
    expect(socialCardKey({ ...input, eyebrow: DEFAULT_EYEBROW })).toBe(socialCardKey(input));
  });

  it('moves when any field of the input moves', () => {
    const key = socialCardKey(input);
    const variants: SocialCardInput[] = [
      { ...input, surface: 'BLOG' },
      { ...input, surface: undefined },
      { ...input, eyebrow: 'ANOTHER EYEBROW' },
      { ...input, title: 'Agents describe. Interfaces appear.' },
      { ...input, description: undefined },
      { ...input, description: 'Another line.' },
      { ...input, footer: { ...input.footer, url: 'console.ggui.ai' } },
      { ...input, footer: { ...input.footer, fact: 'ANOTHER FACT' } },
    ];
    const keys = variants.map((v) => socialCardKey(v));
    for (const k of keys) expect(k).not.toBe(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('moves when the renderer digest or the engine moves', () => {
    expect(keyFor('another-digest', input, undefined)).not.toBe(socialCardKey(input));
    expect(socialCardKey(input, { engine: 'renderer-2.0.0' })).not.toBe(socialCardKey(input));
    expect(socialCardKey(input, { engine: 'renderer-2.0.0' })).toBe(socialCardKey(input, { engine: 'renderer-2.0.0' }));
  });

  it('rejects malformed keys', () => {
    for (const bad of ['', 'abc', 'ABCDEF0123456789', '0123456789abcdef0', '0123456789abcdeg', '../0123456789abcd']) {
      expect(isSocialCardKey(bad)).toBe(false);
    }
  });
});

describe('socialCardKeyFromImage', () => {
  it('is stable for the same bytes and moves when one byte changes', () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const key = socialCardKeyFromImage(bytes);
    expect(isSocialCardKey(key)).toBe(true);
    expect(socialCardKeyFromImage(Uint8Array.from(bytes))).toBe(key);
    const changed = Uint8Array.from(bytes);
    changed[10] = 4;
    expect(socialCardKeyFromImage(changed)).not.toBe(key);
  });
});

describe('the renderer digest', () => {
  it('matches the renderer as it is now: regenerate with `pnpm --filter @ggui-ai/brand generate:digest`', () => {
    expect(SOCIAL_CARD_RENDERER_DIGEST).toBe(computeRendererDigest(PACKAGE_DIR));
  });

  it('covers every module the renderer imports, and every face it loads', () => {
    const listed = new Set(RENDERER_INPUTS);
    const seen = new Set<string>();
    const visit = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      const source = readFileSync(join(PACKAGE_DIR, path), 'utf8');
      for (const [, spec] of source.matchAll(/from '(\.[^']+)'/g)) {
        const target = normalize(join(dirname(path), spec!.replace(/\.js$/, '.ts')));
        expect(listed, `${path} imports ${target}`).toContain(target);
        visit(target);
      }
      for (const [, face] of source.matchAll(/new URL\('\.\.\/(fonts\/[^']+)'/g)) {
        expect(listed, `${path} loads ${face}`).toContain(face);
      }
    };
    visit('src/social-card.ts');
    visit('src/fonts.ts');
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});

describe('the render a static card is keyed on', () => {
  it('is deterministic: the same card renders to the same SVG twice, and a changed title does not', async () => {
    const options = { ...SOCIAL_CARD_SIZE, fonts: socialCardFonts() };
    const first = await satori(renderSocialCard(input), options);
    const second = await satori(renderSocialCard(input), options);
    expect(second).toBe(first);
    const other = await satori(renderSocialCard({ ...input, title: 'Another title.' }), options);
    expect(other).not.toBe(first);
  });
});
