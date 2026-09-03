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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
    // v5's kit pin, verbatim: "every `after-fix` entry carries `fixBy`".
    // NOT an "iff": the LANDED owner-api mirror carries `fixBy: operator`
    // on its three `later` rows and `fixBy: tenant` on its three `never`
    // rows, so `fixBy` is REQUIRED on after-fix and PERMITTED elsewhere.
    for (const [key, row] of rows()) {
      if (row.retry === 'after-fix') {
        expect(row.fixBy, `row ${key}`).toBeDefined();
        expect(REFUSAL_FIX_BY, `row ${key}`).toContain(row.fixBy);
      }
    }
  });

  it('`next-period` rows carry no `fixBy` — time restores them, no party acts', () => {
    // Registry v3: "`next-period`/`never` entries carry no `fixBy`". Only
    // the next-period half is pinned — v4 shipped `never` rows WITH a
    // `fixBy` (`managed_app_no_*` → tenant) and the landed mirror proves it.
    for (const [key, row] of rows()) {
      if (row.retry === 'next-period') {
        expect(row.fixBy, `row ${key}`).toBeUndefined();
      }
    }
  });

  it('two codes never share a name — one state, one code', () => {
    const codes = rows().map(([, row]) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('PRE_GENERATION_REFUSAL_CODES — surface membership', () => {
  it('ships exactly the fourteen render-gate codes (v2 + v5 + v6)', () => {
    expect(codesOn('render-gate')).toEqual(
      [
        'app_canceled',
        'app_policy_missing',
        'billing_mode_anomaly',
        'free_allowance_exceeded',
        'hard_cap_exceeded',
        'insufficient_credit',
        'issuer_rate_limited',
        'managed_default_cap_exceeded',
        'model_not_in_tier',
        'tier_unrecognized',
        'trial_elsewhere',
        'trial_exhausted',
        'trial_expired',
        'unsupported_provider',
      ].sort(),
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

  it('ships the provisioning-api codes (v6 + #785)', () => {
    expect(codesOn('provisioning-api')).toEqual(
      [
        'app_deprovisioned',
        'billing_mode_anomaly',
        'owner_ref_mismatch',
        'policy_version_stale',
      ].sort(),
    );
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
    const renderGate = new Set(RENDER_GATE_REFUSAL_CODES);
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

  it('carries the deletion trigger on `free_allowance_exceeded`', () => {
    // The ruling keeps the row and requires the note: it is deleted in
    // the same slice as #770 D6 (pre-launch, no shim).
    const src = registrySource();
    expect(src).toContain('free_allowance_exceeded');
    expect(src).toMatch(/#770/);
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

  it('no registry code appears as a string literal outside the registry file within oss/packages', () => {
    // Ruling 5b. The registry is the anti-drift mechanism only while no
    // seat mints a code in a handler; a literal elsewhere is that drift.
    const codes = rows().map(([, row]) => row.code);
    expect(codes.length).toBeGreaterThan(0);
    const packagesDir = join(dirname(REGISTRY_FILE), '..', '..', '..');
    const offenders = findCodeLiterals(packagesDir, codes, REGISTRY_FILE);
    expect(offenders).toEqual([]);
  });
});

/**
 * Walk `root` for `.ts` sources (skipping `dist`, `node_modules` and this
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
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
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
