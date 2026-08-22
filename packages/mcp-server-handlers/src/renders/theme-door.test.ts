/**
 * assertKnownThemeId (ggui#598 slice 3 — door-refusal): an explicit
 * `ggui_render({themeId})` naming an id that matches neither a
 * built-in preset nor the app's registered themes REFUSES at the door
 * — the typo is caught where it was typed (the schema-precise
 * precedent: reject bad vocabulary at the door, visible to the party
 * who authored it), instead of silently painting the default ladder.
 */
import { describe, expect, it } from 'vitest';
import { ContractViolationError } from '@ggui-ai/protocol';
import { assertKnownThemeId } from './render.js';

const BASE = {
  documentHash: 'e'.repeat(64),
  light: {},
  dark: {},
};

describe('assertKnownThemeId — the themeId door', () => {
  it('a built-in preset id passes', async () => {
    await expect(
      assertKnownThemeId('midnight', 'app-1', {
        staticThemeIds: ['ggui', 'midnight'],
      }),
    ).resolves.toBeUndefined();
  });

  it('a runtime-registered id passes via the theme-base provider', async () => {
    await expect(
      assertKnownThemeId('acme-brand-v1', 'app-1', {
        staticThemeIds: ['ggui'],
        themeBaseProvider: async (appId, name) =>
          appId === 'app-1' && name === 'acme-brand-v1' ? BASE : null,
      }),
    ).resolves.toBeUndefined();
  });

  it('an unknown id REFUSES with a violation naming the field and the id', async () => {
    let caught: unknown;
    try {
      await assertKnownThemeId('midnihgt', 'app-1', {
        staticThemeIds: ['ggui', 'midnight'],
        themeBaseProvider: async () => null,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContractViolationError);
    const cv = caught as ContractViolationError;
    expect(cv.tool).toBe('ggui_render');
    expect(cv.violations[0]?.field).toBe('themeId');
    expect(cv.violations[0]?.message).toContain('midnihgt');
  });

  it('a composition with NO theme surfaces performs no check — today\'s behavior preserved', async () => {
    await expect(
      assertKnownThemeId('anything-goes', 'app-1', {}),
    ).resolves.toBeUndefined();
  });

  it('static-only composition still refuses unknowns (the provider is optional, the door is not)', async () => {
    await expect(
      assertKnownThemeId('nope', 'app-1', { staticThemeIds: ['ggui'] }),
    ).rejects.toThrow(ContractViolationError);
  });
});
