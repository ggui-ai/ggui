/**
 * `ggui_ops_register_theme` — register (or update) a runtime theme for
 * an app the caller owns (ggui#598-C).
 *
 * Gate order — each wall is a distinct named refusal:
 *   1. tenancy   — the app must be the caller's (uniform not-found).
 *   2. identity  — the frozen id grammar, then collision with any
 *                  built-in theme id (`theme_identity`).
 *   3. coverage  — the injected validator vs the consumed-token
 *                  manifest (`theme_coverage`; uncovered lists ride
 *                  verbatim — never-quiet).
 *   4. policy    — the store may refuse the write (a deployment-policy
 *                  seam, e.g. a per-app registration cap; surfaced as
 *                  `theme_quota` with the store's own message).
 *
 * What gets stored: the `{light, dark}` registration serialized ONCE
 * here to CANONICAL JSON (RFC 8785) — those bytes are the identity
 * (`documentHash` = sha256) and the store returns them verbatim.
 * Identity is deliberately canonical: two key-orderings of one
 * semantic document are ONE registration version (the same
 * representation-independence rule the contract and props-schema
 * hashes obey).
 *
 * The output is never-quiet about inheritance: what the document
 * inherited (`inheritMatched`) and what the manifest excluded from
 * the obligation (`excluded`) are IN the result, not just implied.
 */
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { z } from 'zod';
import { isValidThemeId, type ThemeStore } from '@ggui-ai/mcp-server-core';
import { defineHandler, type HandlerContext, type ShapeOutput } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import { AppNotFoundError, type AppsSource } from '../ops-apps/types.js';
import {
  mapStorePutError,
  ThemeCoverageError,
  ThemeDocumentError,
  ThemeIdentityError,
  type ThemeCoverageValidator,
} from './types.js';

/**
 * Structural mirror of the coverage validator's result — the shape the
 * injected gate returns (kept here so `types.ts` and the composer can
 * reference one definition without a design-package import).
 */
export interface ThemeCoverageResultLike {
  readonly covered: boolean;
  readonly uncovered: {
    readonly light: readonly string[];
    readonly dark: readonly string[];
  };
  readonly inheritMatched: readonly string[];
  readonly excluded: readonly string[];
}

const dtcgDocSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'A DTCG design-token document for one mode. Validated for token coverage at registration — the response names every uncovered token.',
  );

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe(
      'Target app — must be one the calling user owns. Discover via `ggui_ops_list_apps`.',
    ),
  themeId: z
    .string()
    .min(3)
    .max(64)
    .describe(
      'Theme id: lowercase kebab, alphanumeric-bounded, 3-64 chars. Must not collide with a built-in theme id. Re-registering an existing id replaces its document.',
    ),
  registration: z
    .object({ light: dtcgDocSchema, dark: dtcgDocSchema })
    .describe(
      'Both modes, required. Register what dark IS, even when identical to light — silent mode fallback is not part of runtime registration.',
    ),
} as const;

const outputSchema = {
  themeId: z.string(),
  documentHash: z
    .string()
    .describe('sha256 over the stored registration bytes — the identity join key.'),
  updated: z
    .boolean()
    .describe('True when an existing registration was replaced; false on first registration.'),
  coverage: z.object({
    inheritMatched: z
      .array(z.string())
      .describe('Obligated tokens satisfied via explicit inherit patterns.'),
    excluded: z
      .array(z.string())
      .describe('Manifest tokens excluded from the coverage obligation.'),
  }),
} as const;

/** The wire shape — derived from `outputSchema`, the one source of truth (#817). */
export type RegisterThemeOutput = ShapeOutput<typeof outputSchema>;

export interface RegisterThemeDeps {
  readonly apps: AppsSource;
  readonly themeStore: ThemeStore;
  readonly coverageValidator: ThemeCoverageValidator;
  /** The consumed-token manifest (`consumed-tokens.manifest.json` tokens). */
  readonly manifestTokens: readonly string[];
  /** Built-in theme ids — registration refuses collisions outright. */
  readonly staticThemeIds: readonly string[];
}

const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

export function createRegisterThemeHandler(deps: RegisterThemeDeps) {
  return defineHandler({
    name: 'ggui_ops_register_theme',
    title: 'Register theme',
    audience: ['ops'],
    description:
      'Register (or update) a runtime theme for an app the caller owns. The document must cover the consumed-token manifest — refusals name every uncovered token, per mode. The theme id obeys a fixed grammar and must not collide with a built-in id. Returns the stored documentHash (the identity join key) and the coverage detail (inherited + excluded tokens).',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<RegisterThemeOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_register_theme', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);

      // 1. Tenancy — uniform not-found, no existence leak.
      const app = await deps.apps.get({ appId: parsed.appId, ownerSub });
      if (!app) throw new AppNotFoundError(parsed.appId);

      // 2. Identity — grammar first, then built-in collision.
      if (!isValidThemeId(parsed.themeId)) {
        throw new ThemeIdentityError('grammar', parsed.themeId);
      }
      if (deps.staticThemeIds.includes(parsed.themeId)) {
        throw new ThemeIdentityError('collision', parsed.themeId);
      }

      // 3. Document — the validator's parser owns DTCG shape; a throw
      // here means the document itself does not parse. Named wall,
      // never a bare 500 (a fat-fingered document is user error).
      // 4. Coverage — the registration gate.
      let coverage: ThemeCoverageResultLike;
      try {
        coverage = deps.coverageValidator(
          parsed.registration,
          deps.manifestTokens,
        );
      } catch (err) {
        throw new ThemeDocumentError(
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!coverage.covered) {
        throw new ThemeCoverageError(coverage.uncovered);
      }

      // 5. Persist — CANONICAL bytes are the identity (RFC 8785, the
      // contractHash/propsSchemaHash precedent): two key-orderings of
      // one semantic document are ONE registration version. Raw
      // stringify here would re-open the #579 representation class at
      // the front door.
      const document = canonicalize(parsed.registration);
      if (document === undefined) {
        throw new ThemeDocumentError('registration is not canonicalizable JSON');
      }
      const documentHash = sha256(document);
      const existing = await deps.themeStore.get(parsed.appId, parsed.themeId);
      const now = Date.now();
      try {
        await deps.themeStore.put({
          appId: parsed.appId,
          themeId: parsed.themeId,
          document,
          documentHash,
          registeredAt: existing?.registeredAt ?? now,
          updatedAt: now,
        });
      } catch (err) {
        mapStorePutError(err);
      }

      return {
        themeId: parsed.themeId,
        documentHash,
        updated: existing !== null,
        coverage: {
          // The validator's arrays are immutable seam values; the wire
          // carries fresh mutable copies.
          inheritMatched: [...coverage.inheritMatched],
          excluded: [...coverage.excluded],
        },
      };
    },
  });
}
