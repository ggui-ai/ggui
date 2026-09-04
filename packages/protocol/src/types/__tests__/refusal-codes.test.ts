/**
 * `PRE_GENERATION_REFUSAL_CODES` — the closed refusal registry (ggui#786,
 * rulings v2–v6). The exact twin of `MODEL_REGISTRY`'s posture in
 * `types/llm.ts`: one file owns the `code` namespace, `code === key` is
 * enforced at the type level by a const-generic definer, and every derived
 * list (the render-gate subset, the owner-api projection) is DERIVED from
 * the rows rather than written down a second time.
 *
 * ## Why this suite imports the package BARREL, not `../refusal-codes.js`
 *
 * The registry's contract is not "a module exists" — it is that
 * `@ggui-ai/protocol` EXPORTS the rows, because the whole anti-drift
 * mechanism is other packages importing them instead of minting code
 * literals (the landed mirror at
 * `backend/amplify/functions/shared/owner-api-refusals.ts` promises to
 * become one import line of this export). Pinning the barrel pins that
 * obligation; pinning the sibling module would not.
 *
 * ## Row contract as a schema, not a parallel TS interface
 *
 * Each row's shape is asserted with {@link refusalRowContract} — a zod
 * schema authored from the ruling — so this suite reads typed rows with
 * no hand-written type def shadowing the registry's own (Strict Typing
 * First). The schema IS the readable statement of the obligation.
 *
 * ## Split of the completeness pins
 *
 * The four PORTABLE pins a third-party adopter can run (surfaces
 * non-empty, `code === key`, `fixBy` on every `after-fix` row, `retry` in
 * the four-value set) also live in the conformance kit's
 * `registry-completeness` catalog. The two pins below that read repo
 * source — the docstring rule and the "no code literal outside this file
 * within oss/packages" grep — live HERE, where the invariant is owned and
 * the path is stable: the kit ships only `dist`, so a source walk could
 * never run for an npm adopter.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PRE_GENERATION_REFUSAL_CODES,
  RENDER_GATE_REFUSAL_CODES,
} from '../../index.js';

/** The three surfaces a refusal code may be emitted on (registry v6). */
const REFUSAL_SURFACES = [
  'render-gate',
  'owner-api',
  'provisioning-api',
] as const;

/** `retry` is defined from the CALLER's side (registry v2, v4 added `later`). */
const REFUSAL_RETRIES = [
  'after-fix',
  'next-period',
  'later',
  'never',
] as const;

/** WHO acts on an `after-fix` refusal (registry v3). */
const REFUSAL_FIX_BY = ['caller', 'owner', 'tenant', 'operator'] as const;

/**
 * The row contract every registry entry MUST satisfy. Authored from the
 * ruling: `{ code, surfaces (non-empty), retry, fixBy?, emitter,
 * description }`. `emitter` and `description` are non-empty because a row
 * whose emitter is unnamed is exactly the drift the registry exists to
 * prevent (R4: "adding a code = a kit scenario + the emitter named").
 */
const refusalRowContract = z.object({
  code: z.string().min(1),
  surfaces: z.array(z.enum(REFUSAL_SURFACES)).nonempty(),
  retry: z.enum(REFUSAL_RETRIES),
  fixBy: z.enum(REFUSAL_FIX_BY).optional(),
  emitter: z.string().min(1),
  description: z.string().min(1),
});

type RefusalRow = z.infer<typeof refusalRowContract>;

/** Every row, parsed through the contract — the typed reader this suite uses. */
function rows(): ReadonlyArray<readonly [string, RefusalRow]> {
  return Object.entries(PRE_GENERATION_REFUSAL_CODES).map(([key, row]) => [
    key,
    refusalRowContract.parse(row),
  ]);
}

/** The codes whose `surfaces` include `surface`, sorted. */
function codesOn(surface: (typeof REFUSAL_SURFACES)[number]): string[] {
  return rows()
    .filter(([, row]) => row.surfaces.includes(surface))
    .map(([key]) => key)
    .sort();
}

/**
 * The registry's source file. The ruling's "one file" rule names a single
 * home; this suite pins the path so the grep-based pins below (and the
 * kit's future reference to it) have an unambiguous target.
 */
const REGISTRY_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'refusal-codes.ts',
);

function registrySource(): string {
  return readFileSync(REGISTRY_FILE, 'utf8');
}

describe('PRE_GENERATION_REFUSAL_CODES — the registry exists and is exported', () => {
  it('is exported from the @ggui-ai/protocol barrel', () => {
    // The mirror swap (`backend/.../owner-api-refusals.ts` → one import
    // line) is only possible through the package's public surface.
    expect(PRE_GENERATION_REFUSAL_CODES).toBeDefined();
    expect(Object.keys(PRE_GENERATION_REFUSAL_CODES ?? {}).length).toBeGreaterThan(0);
  });

  it('lives in exactly one file — src/types/refusal-codes.ts', () => {
    expect(() => registrySource()).not.toThrow();
  });

  it('every row satisfies the row contract', () => {
    for (const [key, row] of rows()) {
      expect(row.code, `row ${key}`).toBeDefined();
    }
  });
});

describe('PRE_GENERATION_REFUSAL_CODES — the rules the ruling states', () => {
  it('code === key on every row (the const-generic definer enforces it)', () => {
    for (const [key, row] of rows()) {
      expect(row.code).toBe(key);
    }
  });

  it('every row carries a non-empty `surfaces` list (registry v6)', () => {
    for (const [key, row] of rows()) {
      expect(row.surfaces.length, `row ${key}`).toBeGreaterThan(0);
    }
  });

  it("every row's `retry` is one of the four values", () => {
    for (const [key, row] of rows()) {
      expect(REFUSAL_RETRIES, `row ${key}`).toContain(row.retry);
    }
  });

  it('every `after-fix` row carries `fixBy` — WHO acts', () => {
    for (const [key, row] of rows()) {
      if (row.retry === 'after-fix') {
        expect(row.fixBy, `row ${key}`).toBeDefined();
        expect(REFUSAL_FIX_BY, `row ${key}`).toContain(row.fixBy);
      }
    }
  });

  it('`next-period` and `never` rows carry no `fixBy` — no party can act', () => {
    // The ruled cardinality: REQUIRED on `after-fix`, PERMITTED on
    // `later` (the operator who restores a transiently unavailable
    // surface), FORBIDDEN on `next-period` and `never`. Time restores
    // the one and nothing restores the other, so naming a party would
    // be a lie about who can act. The LANDED owner-api mirror carries
    // `fixBy: 'tenant'` on its three `never` rows; the registry is the
    // authority and the mirror loses those at the swap.
    for (const [key, row] of rows()) {
      if (row.retry === 'next-period' || row.retry === 'never') {
        expect(row.fixBy, `row ${key}`).toBeUndefined();
      }
    }
  });

  it('only `later` rows may name a `fixBy` outside the after-fix class', () => {
    // The permitted middle. Asserted as a POSITIVE (at least one `later`
    // row names its operator) so the rule above cannot be satisfied by a
    // registry that simply carries no `fixBy` anywhere.
    const laterWithFixBy = rows().filter(
      ([, row]) => row.retry === 'later' && row.fixBy !== undefined,
    );
    expect(laterWithFixBy.length).toBeGreaterThan(0);
    for (const [key, row] of laterWithFixBy) {
      expect(REFUSAL_FIX_BY, `row ${key}`).toContain(row.fixBy);
    }
  });

  it('two codes never share a name — one state, one code', () => {
    const codes = rows().map(([, row]) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('PRE_GENERATION_REFUSAL_CODES — surface membership', () => {
  it('ships exactly the thirteen render-gate codes (v2 + v5 + v7 + v8 + v9)', () => {
    expect(codesOn('render-gate')).toEqual(
      [
        'app_canceled',
        // v8 — a record with no owner claim cannot be funded, so the
        // gate refuses it BEFORE any reservation or metering. It is a
        // render-gate state, not (only) a provisioning one.
        'app_deprovisioned',
        'app_policy_missing',
        // v7 — the per-APP rate cap. A separate state from the
        // per-issuer one below: one state, one code.
        'app_rate_limited',
        'billing_mode_anomaly',
        'hard_cap_exceeded',
        'insufficient_credit',
        'issuer_rate_limited',
        'managed_default_cap_exceeded',
        'model_not_in_tier',
        'trial_exhausted',
        'trial_expired',
        'unsupported_provider',
      ].sort(),
    );
  });

  it('the two rate-limit codes are distinct states, both render-gate/later', () => {
    // v7 minted `app_rate_limited` BESIDE `issuer_rate_limited` rather
    // than widening one code to two meanings — the namespace rule.
    for (const code of ['app_rate_limited', 'issuer_rate_limited'] as const) {
      const row = refusalRowContract.parse(PRE_GENERATION_REFUSAL_CODES?.[code]);
      expect(row.surfaces, code).toEqual(['render-gate']);
      expect(row.retry, code).toBe('later');
      expect(row.fixBy, code).toBeUndefined();
    }
    expect(PRE_GENERATION_REFUSAL_CODES?.app_rate_limited?.emitter).not.toBe(
      PRE_GENERATION_REFUSAL_CODES?.issuer_rate_limited?.emitter,
    );
  });

  it('ships exactly the nine owner-api codes (v4, as the landed mirror emits them)', () => {
    expect(codesOn('owner-api')).toEqual(
      [
        'already_on_tier',
        'card_update_unavailable',
        'checkout_unavailable',
        'managed_app_no_card_update',
        'managed_app_no_checkout',
        'managed_app_no_portal',
        'no_subscription',
        'portal_unavailable',
        'subscription_exists',
      ].sort(),
    );
  });

  it('ships exactly the three provisioning-api codes (v7 + v8)', () => {
    // `app_deprovisioned` moved to the render gate in v8 — it is the
    // gate's owner-claim check, not a provisioning-route guard.
    expect(codesOn('provisioning-api')).toEqual(
      ['billing_mode_anomaly', 'owner_ref_mismatch', 'policy_version_stale'].sort(),
    );
  });

  it('`policy_version_stale` is a provisioning-api after-fix state the tenant owns (v7)', () => {
    const row = refusalRowContract.parse(
      PRE_GENERATION_REFUSAL_CODES?.policy_version_stale,
    );
    expect(row.surfaces).toEqual(['provisioning-api']);
    expect(row.retry).toBe('after-fix');
    expect(row.fixBy).toBe('tenant');
  });

  it('`billing_mode_anomaly` is ONE code on TWO surfaces (v6 — the rule refined, not bent)', () => {
    const row = refusalRowContract.parse(
      PRE_GENERATION_REFUSAL_CODES?.billing_mode_anomaly,
    );
    expect([...row.surfaces].sort()).toEqual(['provisioning-api', 'render-gate']);
    expect(row.retry).toBe('never');
    expect(row.fixBy).toBeUndefined();
  });

  it('`subscription_exists` is owner-api ONLY — it never reaches a render wire', () => {
    const row = refusalRowContract.parse(
      PRE_GENERATION_REFUSAL_CODES?.subscription_exists,
    );
    expect(row.surfaces).toEqual(['owner-api']);
    expect(row.surfaces).not.toContain('render-gate');
    // One state, two actions (a second checkout AND deleting the app).
    expect(row.retry).toBe('after-fix');
    expect(row.fixBy).toBe('owner');
  });

  it('`checkout_unavailable` is not a render-gate code', () => {
    const row = refusalRowContract.parse(
      PRE_GENERATION_REFUSAL_CODES?.checkout_unavailable,
    );
    expect(row.surfaces).not.toContain('render-gate');
    expect(row.retry).toBe('later');
    expect(row.fixBy).toBe('operator');
  });

  it('`model_not_in_tier` is the one render-gate code an agent MAY act on itself', () => {
    const row = refusalRowContract.parse(
      PRE_GENERATION_REFUSAL_CODES?.model_not_in_tier,
    );
    expect(row.surfaces).toContain('render-gate');
    expect(row.retry).toBe('after-fix');
    expect(row.fixBy).toBe('caller');
  });
});

describe('RENDER_GATE_REFUSAL_CODES — derived, never a second list', () => {
  it('is a non-empty tuple (z.enum needs a literal tuple, not a filtered string[])', () => {
    expect(RENDER_GATE_REFUSAL_CODES).toBeDefined();
    expect(Array.isArray(RENDER_GATE_REFUSAL_CODES)).toBe(true);
    expect((RENDER_GATE_REFUSAL_CODES ?? []).length).toBeGreaterThan(0);
  });

  it('equals exactly the codes whose surfaces include render-gate', () => {
    // The derived-checked pin: an authored tuple that omitted a
    // render-gate code, or listed a non-render-gate one, fails HERE even
    // if the exhaustiveness helper were loosened.
    expect([...(RENDER_GATE_REFUSAL_CODES ?? [])].sort()).toEqual(
      codesOn('render-gate'),
    );
  });

  it('carries no owner-api-only or provisioning-api-only code', () => {
    // Asserted against the POPULATED tuple — an empty/absent list must
    // not satisfy "contains none of these" vacuously.
    const renderGate = new Set<string>(RENDER_GATE_REFUSAL_CODES);
    expect(renderGate.size).toBe(codesOn('render-gate').length);
    for (const code of ['subscription_exists', 'owner_ref_mismatch']) {
      expect(renderGate.has(code)).toBe(false);
    }
  });
});

describe('PRE_GENERATION_REFUSAL_CODES — the source-level obligations', () => {
  it('documents the no-auto-retry rule for an after-fix refusal whose fixBy is not caller', () => {
    // R5: "an agent MUST NOT auto-retry an `after-fix` refusal whose
    // `fixBy` is not `caller`" — the rule that keeps "retry after fix"
    // from meaning "perform the customer's billing decision". It must be
    // stated next to the truth, not only on the issue.
    const src = registrySource();
    expect(src).toContain('MUST NOT');
    expect(src.toLowerCase()).toContain('auto-retry');
    expect(src).toContain('caller');
  });

  it('the three v9-deleted codes are GONE from the registry source', () => {
    // v9 ruling: `free_allowance_exceeded`, `trial_elsewhere` and
    // `tier_unrecognized` leave the registry. Pre-launch means the row
    // goes with no shim and no `@deprecated` — so absence from the
    // SOURCE, not just from the derived enum, is what this pins: a
    // commented-out row would still be a half-migration.
    const src = registrySource();
    for (const gone of [
      'free_allowance_exceeded',
      'trial_elsewhere',
      'tier_unrecognized',
    ]) {
      expect(src, gone).not.toContain(gone);
    }
  });

  it('marks the rows side-effect-free so a bundler can drop them', () => {
    // The rows are SERVER-side data — all three surfaces' descriptions
    // and emitters, ~8 KB raw. They ride the root barrel, and the root
    // barrel is bundled into `@ggui-ai/iframe-runtime`, which is
    // size-gated. A browser never reads a refusal ROW: the only thing
    // that reaches it is the 13-string wire enum inside
    // `renderRefusalSchema`. Without the annotation a bundler must
    // assume the definer call is side-effectful and keeps every row —
    // which is what pushed the runtime over its budget. The build gate
    // (`check-bundle-size`) is the enforcement; this pin names the
    // reason so the annotation is not deleted as noise.
    expect(registrySource()).toContain(
      '/* @__PURE__ */ defineRefusalRegistry(',
    );
  });

  it('reads clean to a self-hoster — no cloud vocabulary in the registry file', () => {
    // OSS purity: every `description` here ships to npm, and the render-gate
    // subset reaches a self-hoster's LLM as JSON-Schema metadata via
    // tools/list. Wording is deployment-policy perspective, never operator.
    const src = registrySource();
    for (const banned of [
      '@ggui-cloud',
      'guuey',
      'platform pool',
      'platform-pool',
      'wallet',
      'Stripe',
    ]) {
      expect(src, `banned OSS-purity token: ${banned}`).not.toContain(banned);
    }
  });

  it("bans plan-tier vocabulary outside the three grandfathered code names", () => {
    // OSS purity, TYPE-LITERAL class — the one CLAUDE.md calls out by
    // name ("`keySource: 'platform'` carries tier semantics"). A refusal
    // code is not only prose: the render-gate subset is a `z.enum`, so
    // every value ships to npm AND reaches each self-hoster's LLM as
    // JSON-Schema metadata on `tools/list`. "tier" names a plan ladder a
    // self-hoster does not have; the rest of this file already says
    // "plan" for exactly that reason.
    //
    // The two names below already ride LIVE wires minted before this
    // registry existed — `already_on_tier` is thrown by the owner
    // checkout mutation and read by the console, and `model_not_in_tier`
    // is emitted by a deployment's generation gate and documented in the
    // federated-billing policy. Renaming one is a coordinated change
    // across the emitting surface and its consumers, not a
    // protocol-local edit, so they are exempted BY NAME and the token is
    // banned everywhere else: a NEW code, a description or an emitter
    // that reaches for it fails here rather than at review.
    //
    // v9 shrank this list by one: `tier_unrecognized` left the registry
    // entirely, so it no longer needs an exemption. `already_on_tier`
    // stays — its row is owner-api and is untouched by v9.
    const grandfathered = ['model_not_in_tier', 'already_on_tier'];
    const stripped = grandfathered.reduce(
      (src, name) => src.split(name).join(''),
      registrySource(),
    );
    expect(stripped).not.toMatch(/tier/i);
  });

  it('no registry code appears as a string literal outside the registry file within oss/packages', () => {
    // Ruling 5b. The registry is the anti-drift mechanism only while no
    // seat mints a code in a handler; a literal elsewhere is that drift.
    const codes = rows().map(([, row]) => row.code);
    expect(codes.length).toBeGreaterThan(0);
    const packagesDir = join(dirname(REGISTRY_FILE), '..', '..', '..');
    const offenders = findCodeLiterals(packagesDir, codes, REGISTRY_FILE);
    expect(offenders).toEqual([]);
  });

  it('the literal walk skips build output (dist and dist.staging-<pid>) but still catches a minted code in src', () => {
    // Every oss/packages/*/package.json#build stages into `dist.staging-$$`
    // and swaps it into `dist` when done; in CI that tree coexists with this
    // suite, and its generated `.d.ts` unions quote every registry code.
    // Those files are OUTPUT of the registry, not a second source of it —
    // walking them is a false offence (CI run 33832497812).
    const root = mkdtempSync(join(tmpdir(), 'refusal-codes-walk-'));
    mkdirSync(join(root, 'dist.staging-1', 'types'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'dist.staging-1', 'types', 'x.d.ts'), 'export type C = "unsupported_provider";\n');
    writeFileSync(join(root, 'dist', 'y.d.ts'), "export type C = 'unsupported_provider';\n");
    writeFileSync(join(root, 'src', 'clean.ts'), 'export const c = codeOf(1);\n');
    writeFileSync(join(root, 'src', 'mint.ts'), "export const c = 'unsupported_provider';\n");
    expect(findCodeLiterals(root, ['unsupported_provider'], '')).toEqual([
      `${join(root, 'src', 'mint.ts')}: unsupported_provider`,
    ]);
  });
});

/**
 * Walk `root` for `.ts` sources (skipping `dist*` build output, `node_modules` and this
 * suite's own tests) and report every file quoting one of `codes` as a
 * string literal. Deliberately narrow: it looks for the quoted form, so
 * prose in a docstring naming a code is not an offence — minting the code
 * as a value is.
 */
function findCodeLiterals(
  root: string,
  codes: readonly string[],
  registryFile: string,
): string[] {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      // `dist*` covers `dist` and the build's `dist.staging-<pid>` — output, never source.
      if (entry === 'node_modules' || entry.startsWith('dist') || entry.startsWith('.')) {
        continue;
      }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
      if (full === registryFile) continue;
      const src = readFileSync(full, 'utf8');
      for (const code of codes) {
        if (src.includes(`'${code}'`) || src.includes(`"${code}"`)) {
          offenders.push(`${full}: ${code}`);
          break;
        }
      }
    }
  };
  walk(root);
  return offenders.sort();
}
