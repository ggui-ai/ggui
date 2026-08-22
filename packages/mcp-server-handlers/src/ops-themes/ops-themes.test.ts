/**
 * ops-themes handler suite (ggui#598-C) — driven against the REAL
 * InMemoryThemeStore reference (the frozen port's conformance
 * authority) with a stub AppsSource + stub coverage validator (the
 * validator is an injected seam; its real implementation is pinned in
 * the design package's own suite).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryThemeStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { ThemeStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext } from '../types.js';
import {
  AppNotFoundError,
  type AppRecord,
  type AppsSource,
} from '../ops-apps/types.js';
import {
  createDeleteThemeHandler,
  createListThemesHandler,
  createRegisterThemeHandler,
  ThemeCoverageError,
  ThemeDocumentError,
  ThemeIdentityError,
  ThemeQuotaError,
  type ThemeCoverageValidator,
} from './index.js';

const OWNER = 'sub-owner-1';
const CTX: HandlerContext = {
  appId: 'ctx-app',
  requestId: 'r',
  userId: OWNER, // resolveOwnerSub reads ctx.userId ?? ctx.appId
} as HandlerContext;

const LIGHT = { color: { brand: { $value: '#123456' } } };
const DARK = { color: { brand: { $value: '#654321' } } };
const REGISTRATION = { light: LIGHT, dark: DARK };

import canonicalize from 'canonicalize';

const sha = (v: unknown): string =>
  createHash('sha256').update(canonicalize(v) as string, 'utf8').digest('hex');

const COVERED: ReturnType<ThemeCoverageValidator> = {
  covered: true,
  uncovered: { light: [], dark: [] },
  inheritMatched: ['--ggui-color-outline'],
  excluded: ['--ggui-motion-duration'],
};

/**
 * Honest AppsSource stub — the ONE exercised method behaves; every
 * other throws loudly (no cast laundering; the compiler checks the
 * full surface, the runtime catches accidental use).
 */
const notExercised = (method: string) => async (): Promise<never> => {
  throw new Error(`AppsSource.${method} is not exercised by this suite`);
};
function stubApps(ownedAppIds: readonly string[]): AppsSource {
  return {
    get: async ({ appId, ownerSub }) =>
      ownerSub === OWNER && ownedAppIds.includes(appId)
        ? ({ appId } as AppRecord)
        : null,
    list: notExercised('list'),
    create: notExercised('create'),
    update: notExercised('update'),
    delete: notExercised('delete'),
    setTheme: notExercised('setTheme'),
  };
}

function deps(over: {
  store?: ThemeStore;
  validator?: ThemeCoverageValidator;
  staticIds?: readonly string[];
} = {}) {
  return {
    apps: stubApps(['app-1']),
    themeStore: over.store ?? new InMemoryThemeStore(),
    coverageValidator: over.validator ?? ((() => COVERED) as ThemeCoverageValidator),
    manifestTokens: ['--ggui-color-primary-500'],
    staticThemeIds: over.staticIds ?? ['ggui-default'],
  };
}

describe('ggui_ops_register_theme', () => {
  it('happy path: stores the serialized registration, returns hash + coverage detail, updated:false', async () => {
    const store = new InMemoryThemeStore();
    const h = createRegisterThemeHandler(deps({ store }));
    const out = await h.handler(
      { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
      CTX,
    );
    expect(out).toEqual({
      themeId: 'brand-x',
      documentHash: sha(REGISTRATION),
      updated: false,
      coverage: {
        inheritMatched: ['--ggui-color-outline'],
        excluded: ['--ggui-motion-duration'],
      },
    });
    const stored = await store.get('app-1', 'brand-x');
    // Stored bytes are the RFC 8785 canonical form (MF1: identity is
    // canonical, never representation-dependent).
    expect(stored!.document).toBe(canonicalize(REGISTRATION));
    expect(stored!.documentHash).toBe(sha(REGISTRATION));
  });

  it('identity is CANONICAL: two key-orderings of one semantic document yield ONE documentHash (the #579 class, closed at registration)', async () => {
    const store = new InMemoryThemeStore();
    const h = createRegisterThemeHandler(deps({ store }));
    const first = await h.handler(
      { appId: 'app-1', themeId: 'brand-x', registration: { light: { b: 2, a: 1 }, dark: DARK } },
      CTX,
    );
    const second = await h.handler(
      { appId: 'app-1', themeId: 'brand-x', registration: { dark: DARK, light: { a: 1, b: 2 } } },
      CTX,
    );
    expect(second.documentHash).toBe(first.documentHash);
    const stored = await store.get('app-1', 'brand-x');
    expect(stored!.document).toBe(canonicalize({ light: { a: 1, b: 2 }, dark: DARK }));
  });

  it("document wall: a validator THROW maps to theme_document (a fat-fingered document is a named refusal, never a 500)", async () => {
    const validator: ThemeCoverageValidator = () => {
      throw new TypeError('Cannot convert undefined or null to object');
    };
    const h = createRegisterThemeHandler(deps({ validator }));
    const err = await h
      .handler(
        { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
        CTX,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThemeDocumentError);
    expect((err as Error).message).toMatch(/theme_document/);
    expect((err as Error).message).toContain('Cannot convert undefined or null to object');
  });

  it('re-registration reports updated:true, preserves registeredAt, changes the hash with the bytes', async () => {
    const store = new InMemoryThemeStore();
    const h = createRegisterThemeHandler(deps({ store }));
    await h.handler(
      { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
      CTX,
    );
    const first = await store.get('app-1', 'brand-x');
    const second = await h.handler(
      {
        appId: 'app-1',
        themeId: 'brand-x',
        registration: { light: DARK, dark: LIGHT },
      },
      CTX,
    );
    expect(second.updated).toBe(true);
    expect(second.documentHash).not.toBe(sha(REGISTRATION));
    const stored = await store.get('app-1', 'brand-x');
    expect(stored!.registeredAt).toBe(first!.registeredAt);
  });

  it('tenancy: an app the caller does not own is a uniform not-found', async () => {
    const h = createRegisterThemeHandler(deps());
    await expect(
      h.handler(
        { appId: 'app-other', themeId: 'brand-x', registration: REGISTRATION },
        CTX,
      ),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it("identity wall — grammar: 'Bad_Id' refuses with reason 'grammar' and nothing is stored", async () => {
    const store = new InMemoryThemeStore();
    const h = createRegisterThemeHandler(deps({ store }));
    const err = await h
      .handler(
        { appId: 'app-1', themeId: 'Bad_Id', registration: REGISTRATION },
        CTX,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThemeIdentityError);
    expect((err as ThemeIdentityError).reason).toBe('grammar');
    expect(await store.list('app-1')).toEqual([]);
  });

  it("identity wall — collision with a built-in id refuses with reason 'collision'", async () => {
    const h = createRegisterThemeHandler(deps({ staticIds: ['brand-x'] }));
    const err = await h
      .handler(
        { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
        CTX,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThemeIdentityError);
    expect((err as ThemeIdentityError).reason).toBe('collision');
  });

  it('coverage wall: uncovered tokens ride VERBATIM on the refusal, per mode; nothing is stored', async () => {
    const store = new InMemoryThemeStore();
    const validator: ThemeCoverageValidator = () => ({
      covered: false,
      uncovered: {
        light: ['--ggui-color-primary-500'],
        dark: ['--ggui-color-primary-500', '--ggui-color-surface'],
      },
      inheritMatched: [],
      excluded: [],
    });
    const h = createRegisterThemeHandler(deps({ store, validator }));
    const err = await h
      .handler(
        { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
        CTX,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThemeCoverageError);
    expect((err as ThemeCoverageError).uncovered).toEqual({
      light: ['--ggui-color-primary-500'],
      dark: ['--ggui-color-primary-500', '--ggui-color-surface'],
    });
    expect((err as Error).message).toContain('--ggui-color-surface');
    expect(await store.list('app-1')).toEqual([]);
  });

  it("policy wall: a store refusal named 'ThemeQuotaExceededError' maps to theme_quota; anything else bubbles untouched", async () => {
    const quotaStore: ThemeStore = {
      get: async () => null,
      list: async () => [],
      delete: async () => false,
      put: async () => {
        const e = new Error('app app-1 already has 2 registered themes (the per-app cap)');
        e.name = 'ThemeQuotaExceededError';
        throw e;
      },
    };
    const h = createRegisterThemeHandler(deps({ store: quotaStore }));
    const err = await h
      .handler(
        { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
        CTX,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThemeQuotaError);
    expect((err as Error).message).toContain('per-app cap');

    const corruptStore: ThemeStore = {
      ...quotaStore,
      put: async () => {
        const e = new Error('integrity fault');
        e.name = 'ThemeStoreCorruptionError';
        throw e;
      },
    };
    const h2 = createRegisterThemeHandler(deps({ store: corruptStore }));
    const bubbled = await h2
      .handler(
        { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
        CTX,
      )
      .catch((e: unknown) => e);
    expect((bubbled as Error).name).toBe('ThemeStoreCorruptionError');
  });
});

describe('ggui_ops_list_themes', () => {
  it('returns metadata only, themeId-sorted, tenancy-gated', async () => {
    const store = new InMemoryThemeStore();
    const reg = createRegisterThemeHandler(deps({ store }));
    await reg.handler(
      { appId: 'app-1', themeId: 'zeta-brand', registration: REGISTRATION },
      CTX,
    );
    await reg.handler(
      { appId: 'app-1', themeId: 'alpha-brand', registration: REGISTRATION },
      CTX,
    );
    const h = createListThemesHandler(deps({ store }));
    const out = await h.handler({ appId: 'app-1' }, CTX);
    expect(out.themes.map((t) => t.themeId)).toEqual(['alpha-brand', 'zeta-brand']);
    for (const t of out.themes) {
      expect('document' in t).toBe(false);
      expect(t.documentHash).toBe(sha(REGISTRATION));
    }
    await expect(h.handler({ appId: 'app-other' }, CTX)).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });
});

describe('ggui_ops_delete_theme', () => {
  it('idempotent-with-report; the id becomes registerable again; tenancy-gated', async () => {
    const store = new InMemoryThemeStore();
    const reg = createRegisterThemeHandler(deps({ store }));
    await reg.handler(
      { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
      CTX,
    );
    const h = createDeleteThemeHandler(deps({ store }));
    expect(await h.handler({ appId: 'app-1', themeId: 'brand-x' }, CTX)).toEqual(
      { themeId: 'brand-x', deleted: true },
    );
    expect(await h.handler({ appId: 'app-1', themeId: 'brand-x' }, CTX)).toEqual(
      { themeId: 'brand-x', deleted: false },
    );
    const again = await reg.handler(
      { appId: 'app-1', themeId: 'brand-x', registration: REGISTRATION },
      CTX,
    );
    expect(again.updated).toBe(false);
    await expect(
      h.handler({ appId: 'app-other', themeId: 'brand-x' }, CTX),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });
});
