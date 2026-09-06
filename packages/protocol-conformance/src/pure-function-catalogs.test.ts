/**
 * The runner's PURE-FUNCTION catalog fold (ggui#786).
 *
 * `runConformance()` drives the WebSocket fixture catalog. The two
 * ggui#786 catalogs are not WS-observable — a refusal projection is a
 * pure function and a registry is data — so they were reachable only
 * through a direct import, which made them invisible to every CLI run.
 * A catalog the runner cannot report is a silent gate
 * (docs/principles/no-silent-block.md), so the runner now folds them
 * into the same verdict buckets as the fixtures.
 *
 * This suite pins the fold. Every case uses an `only` filter that
 * matches NO WebSocket fixture, so no transport is ever opened and the
 * assertions are about the fold alone — the runner never reaches
 * `config.serverUrl`.
 */
import { describe, expect, it } from 'vitest';

import {
  PURE_FUNCTION_CATALOG_SLUGS,
  runConformance,
  type ConformanceResult,
  type RunConformanceConfig,
} from './run-conformance.js';
import { formatScorecard } from './reporter.js';
import {
  refusalEnvelopeCases,
  type PreGenerationRefusalInput,
  type ProjectedRefusalResult,
} from './refusal-envelope-conformance/index.js';
import {
  registryCompletenessPins,
  type RefusalRegistryView,
} from './registry-completeness/index.js';
import {
  transportRefusalCases,
  type ProjectedTransportRefusal,
  type TransportRefusalInput,
} from './transport-refusal-conformance/index.js';
import {
  domainErrorCases,
  type RawToolCallResult,
  type ToolCallScenario,
} from './domain-error-conformance/index.js';
import * as kit from './index.js';

/**
 * A URL the runner must never dial. Every case below filters the WS
 * fixtures down to nothing, so reaching this would itself be the bug.
 */
const UNREACHABLE = 'ws://127.0.0.1:1/ws';

function run(
  overrides: Partial<RunConformanceConfig> & Pick<RunConformanceConfig, 'only'>,
): Promise<ConformanceResult> {
  return runConformance({
    serverUrl: UNREACHABLE,
    auth: { kind: 'bearer', token: 't' },
    ...overrides,
  });
}

/** Row names the refusal-envelope catalog contributes. */
const ENVELOPE_ROWS = refusalEnvelopeCases.map((c) => `refusal-envelope/${c.name}`);
/** Row names the registry-completeness catalog contributes. */
const REGISTRY_ROWS = registryCompletenessPins.map(
  (p) => `registry-completeness/${p.name}`,
);
const TRANSPORT_ROWS = transportRefusalCases.map((c) => `transport-refusal/${c.name}`);
/** Row names the domain-error catalog contributes (ggui#880). */
const DOMAIN_ROWS = domainErrorCases.map((c) => `domain-error/${c.name}`);

/** A conformant tools/call driver, built from the catalog's own cases. */
function catalogToolCallDriver(scenario: ToolCallScenario): RawToolCallResult | null {
  const match = domainErrorCases.find(
    (c) =>
      c.scenario.tool === scenario.tool &&
      JSON.stringify(c.scenario.args) === JSON.stringify(scenario.args),
  );
  return match === undefined
    ? null
    : { isError: true, content: [{ type: 'text', text: `${match.expect.code}: the id resolves to nothing` }] };
}

/** A conformant endpoint projector, built from the catalog's own `expect`. */
function catalogTransportProjector(
  refusal: TransportRefusalInput,
): ProjectedTransportRefusal | null {
  const match = transportRefusalCases.find((c) => c.refusal.code === refusal.code);
  return match?.expect ?? null;
}

/**
 * A conformant projector, built from the catalog's own `expect` — this
 * suite grades the RUNNER's fold, not the projection (the catalog's own
 * meta-test grades that against a reference built from SPEC).
 */
function catalogProjector(
  refusal: PreGenerationRefusalInput,
): ProjectedRefusalResult | null {
  const match = refusalEnvelopeCases.find((c) => c.refusal.code === refusal.code);
  return match?.expect ?? null;
}

/** A registry that satisfies every pin. */
const CLEAN_REGISTRY: RefusalRegistryView = {
  hard_cap_exceeded: {
    code: 'hard_cap_exceeded',
    surfaces: ['render-gate'],
    retry: 'next-period',
    emitter: 'the cap check',
    description: 'the period ceiling was reached',
  },
};

describe('runConformance — pure-function catalog fold', () => {
  it('reports every catalog row as SKIPPED when neither input is supplied', async () => {
    const result = await run({ only: [...ENVELOPE_ROWS, ...REGISTRY_ROWS] });
    expect(result.passed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((s) => s.name).sort()).toEqual(
      [...ENVELOPE_ROWS, ...REGISTRY_ROWS].sort(),
    );
    // The reason must NAME what to supply — a bare "skipped" would be
    // the silent gate this fold exists to remove.
    for (const skipped of result.skipped) {
      expect(skipped.reason).toMatch(/refusalProjector|refusalRegistry/);
    }
  });

  it('grades the refusal-envelope catalog when a projector is supplied', async () => {
    const result = await run({ only: ENVELOPE_ROWS, refusalProjector: catalogProjector });
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect([...result.passed].sort()).toEqual([...ENVELOPE_ROWS].sort());
  });

  it('reports a FAILED row for a projector that leaks an identity field', async () => {
    // The exact regression the catalog exists to guard — and proof the
    // fold reports failures rather than swallowing them.
    const result = await run({
      only: ENVELOPE_ROWS,
      refusalProjector: (refusal) => {
        const clean = catalogProjector(refusal);
        return clean === null ? null : { ...clean, identityFields: ['sessionId'] };
      },
    });
    // The "no envelope on this surface" cases still pass — the leak
    // cannot reach a case whose expectation is `null`. Everything else
    // must fail, which is why the count is derived rather than typed in.
    const nullExpectationRows = refusalEnvelopeCases
      .filter((c) => c.expect === null)
      .map((c) => `refusal-envelope/${c.name}`);
    expect(nullExpectationRows.length).toBeGreaterThan(0);
    expect([...result.passed].sort()).toEqual([...nullExpectationRows].sort());
    expect(result.failed.length).toBe(
      ENVELOPE_ROWS.length - nullExpectationRows.length,
    );
    for (const failure of result.failed) {
      expect(failure.name.startsWith('refusal-envelope/')).toBe(true);
      expect(failure.criterion).toContain('refusal envelope');
    }
  });

  it('grades the registry-completeness pins when a registry is supplied', async () => {
    const result = await run({ only: REGISTRY_ROWS, refusalRegistry: CLEAN_REGISTRY });
    expect(result.failed).toEqual([]);
    expect([...result.passed].sort()).toEqual([...REGISTRY_ROWS].sort());
  });

  it('reports FAILED rows for a registry whose code does not equal its key', async () => {
    const result = await run({
      only: REGISTRY_ROWS,
      refusalRegistry: {
        hard_cap_exceeded: { ...CLEAN_REGISTRY['hard_cap_exceeded']!, code: 'other' },
      },
    });
    expect(result.failed.map((f) => f.name)).toEqual([
      'registry-completeness/code-equals-key',
    ]);
    expect(result.failed[0]?.received).toEqual(["hard_cap_exceeded: code 'other' does not equal key 'hard_cap_exceeded'"]);
  });

  it('honours `only` across catalog rows, exactly as it does for fixtures', async () => {
    const one = ENVELOPE_ROWS[0];
    const result = await run({ only: [one!], refusalProjector: catalogProjector });
    expect(result.passed).toEqual([one]);
    expect(result.skipped).toEqual([]);
  });

  it('prints every pure-function catalog on the scorecard, skipped rows included', async () => {
    const result = await run({
      only: [...ENVELOPE_ROWS, ...REGISTRY_ROWS, ...TRANSPORT_ROWS, ...DOMAIN_ROWS],
    });
    const scorecard = formatScorecard(result);
    for (const slug of PURE_FUNCTION_CATALOG_SLUGS) {
      expect(scorecard).toContain(slug);
    }
  });
});

describe('runConformance — transport-refusal catalog fold (ggui#825)', () => {
  it('reports every transport-refusal row as SKIPPED, naming transportRefusalProjector, when it is not supplied', async () => {
    const result = await run({ only: TRANSPORT_ROWS });
    expect(result.passed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((s) => s.name).sort()).toEqual([...TRANSPORT_ROWS].sort());
    for (const skipped of result.skipped) {
      expect(skipped.reason).toMatch(/transportRefusalProjector/);
    }
  });

  it('grades the transport-refusal catalog when a projector is supplied', async () => {
    const result = await run({ only: TRANSPORT_ROWS, transportRefusalProjector: catalogTransportProjector });
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect([...result.passed].sort()).toEqual([...TRANSPORT_ROWS].sort());
  });

  it('a bare-403 projector fails the deprovisioned row with the catalog criterion named', async () => {
    const result = await run({ only: TRANSPORT_ROWS, transportRefusalProjector: () => null });
    expect(result.failed.map((f) => f.name)).toEqual(['transport-refusal/refuse-deprovisioned-endpoint']);
    expect(result.failed[0]?.criterion).toMatch(/mcp-endpoint/);
  });
});

describe('runConformance — domain-error catalog fold (ggui#880)', () => {
  it('reports every domain-error row as SKIPPED, naming toolCallDriver, when it is not supplied', async () => {
    const result = await run({ only: DOMAIN_ROWS });
    expect(result.passed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((s) => s.name)).toEqual(DOMAIN_ROWS);
    for (const skipped of result.skipped) {
      expect(skipped.reason).toMatch(/toolCallDriver/);
    }
  });

  it('grades the domain-error catalog when a driver is supplied', async () => {
    const result = await run({ only: DOMAIN_ROWS, toolCallDriver: catalogToolCallDriver });
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.passed).toEqual(DOMAIN_ROWS);
  });

  it("a prose-only driver — today's wire — fails every row with `slug-leads` named in the criterion", async () => {
    const result = await run({
      only: DOMAIN_ROWS,
      toolCallDriver: (scenario) => ({
        isError: true,
        content: [{ type: 'text', text: `${scenario.tool}: not found` }],
      }),
    });
    expect(result.passed).toEqual([]);
    expect(result.failed.map((f) => f.name)).toEqual(DOMAIN_ROWS);
    for (const failure of result.failed) {
      expect(failure.criterion).toMatch(/slug-leads/);
      expect(failure.criterion).toMatch(/7\.9/);
    }
  });

  it('a driver that returns null skips the row with the tool named', async () => {
    const result = await run({
      only: DOMAIN_ROWS,
      toolCallDriver: (scenario) => (scenario.tool === 'ggui_emit' ? null : catalogToolCallDriver(scenario)),
    });
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.reason).toContain('ggui_emit');
    expect(result.passed.length).toBe(DOMAIN_ROWS.length - 1);
  });
});

describe('runConformance — domain-error catalog: `only` gates the DRIVE, and the root barrel carries the catalog (ggui#880)', () => {
  it('does not invoke a supplied driver when `only` selects no domain-error row — a live driver is real calls', async () => {
    let calls = 0;
    const result = await run({
      only: [ENVELOPE_ROWS[0]!],
      refusalProjector: catalogProjector,
      toolCallDriver: (scenario) => {
        calls += 1;
        return catalogToolCallDriver(scenario);
      },
    });
    expect(result.passed).toEqual([ENVELOPE_ROWS[0]]);
    expect(calls).toBe(0);
  });

  it('drives only the selected rows', async () => {
    const seen: string[] = [];
    const one = DOMAIN_ROWS[2]!;
    const result = await run({
      only: [one],
      toolCallDriver: (scenario) => {
        seen.push(scenario.tool);
        return catalogToolCallDriver(scenario);
      },
    });
    expect(result.passed).toEqual([one]);
    expect(seen.length).toBe(1);
  });

  it('exports the catalog from the root barrel like every sibling catalog', () => {
    expect(typeof kit.runDomainErrorConformance).toBe('function');
    expect(typeof kit.isRawToolCallResult).toBe('function');
    expect(kit.domainErrorCases.length).toBe(6);
  });
});
