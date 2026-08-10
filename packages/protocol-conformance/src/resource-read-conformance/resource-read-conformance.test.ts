/**
 * Meta-test for the `resources/read` catalog — grades the CATALOG and
 * the RUNNER, not any shipping server.
 *
 * Same posture as `../registration-conformance` and
 * `../resolution-conformance`: the kit stays vendor-neutral, so the
 * reference binding here is a faithful in-test server written from the
 * obligations the catalog freezes rather than copied from an
 * implementation. Grading a *shipping* server is an implementation-side
 * test that drives {@link runResourceReadConformance} with its own
 * scenario driver.
 *
 * The interesting half is the REJECTION half. A conformance runner that
 * is only ever driven by a correct implementation proves nothing about
 * its own grading — every assertion could be vacuous and the suite would
 * stay green. So each obligation the catalog claims is paired with a
 * server that breaks exactly that one, and the test asserts the runner
 * fails the case BY NAME. Those are positive assertions: they name what
 * must go red, not merely that something did.
 */
import { describe, expect, it } from 'vitest';
import { isRecord } from '@ggui-ai/protocol';
import {
  declaresDeliveryChannel,
  parseCase,
  renderLocatorUri,
  resourceReadCases,
  runResourceReadConformance,
  type JsonRpcErrorFrame,
  type PreparedResourceReadScenario,
  type ResourceReadConformanceCase,
  type ResourceReadOutcome,
  type ResourceReadScenario,
  type ResourceReadScenarioDriver,
  type ResourceReadSeed,
} from './index.js';

// The wire numbers, spelled as literals — the catalog's JSON pins them
// too, and a rename that silently moved the wire would pass in a module
// that imports the constant and fail here.
const NOT_FOUND_CODE = -32002;
const MOUNT_UNAVAILABLE_CODE = -32006;
const INVALID_PARAMS_CODE = -32602;
const INTERNAL_ERROR_CODE = -32603;

const NOT_FOUND_MESSAGE = 'Resource not found.';

// =============================================================================
// A faithful in-test server, plus one deviation at a time
// =============================================================================

/**
 * The single obligation a given server run breaks. `'none'` is the
 * conformant server every positive expectation is graded against.
 */
type Flaw =
  | 'none'
  /** Reports the three MOUNT_UNAVAILABLE classes as internal errors. */
  | 'internal-error-for-mount-unavailable'
  /** Puts NOT_FOUND on the internal-error number. */
  | 'wrong-number-for-not-found'
  /** Lets the NOT_FOUND message name the locator it refused. */
  | 'not-found-message-names-the-locator'
  /** Attaches a refusal diagnostic to NOT_FOUND's body. */
  | 'not-found-carries-a-detail'
  /** Runs the access check late, so a refused read gets a resolution verdict. */
  | 'refusal-answers-a-resolution-code'
  /** Answers a URI that names no locator as though it named one. */
  | 'malformed-uri-answers-not-found'
  /** Returns a success-shaped result declaring no delivery channel. */
  | 'dead-shell-on-success'
  /** A substrate-less server that answers a miss with NOT_FOUND. */
  | 'substrate-less-answers-not-found'
  /**
   * The one flaw only the byte-identity check can see: correct number,
   * correct classification, nothing disclosed — but one field differs
   * between the two fused reads.
   */
  | 'varies-one-field-between-reads';

interface SeededState {
  readonly identityRecords: Map<string, { readonly key: string; readonly named: boolean }>;
  readonly durableBlueprint: { readonly componentRef: boolean; readonly body: boolean } | null;
  readonly committedRenders: ReadonlyMap<string, 'under-inline-cap' | 'over-inline-cap'>;
  readonly uncommittedRenders: ReadonlySet<string>;
  readonly registeredKeys: ReadonlyMap<string, string>;
}

/** The key the in-test registry assigns to a published blueprint. */
const REGISTRY_KEY = 'aaaabbbbccccdddd';

function applySeeds(seeds: readonly ResourceReadSeed[]): SeededState {
  const identityRecords = new Map<string, { key: string; named: boolean }>();
  const committedRenders = new Map<string, 'under-inline-cap' | 'over-inline-cap'>();
  const uncommittedRenders = new Set<string>();
  const registeredKeys = new Map<string, string>();
  let durableBlueprint: { componentRef: boolean; body: boolean } | null = null;

  for (const seed of seeds) {
    switch (seed.kind) {
      case 'identity-record':
        identityRecords.set(seed.session, {
          key: seed.key,
          named: seed.blueprint === 'named',
        });
        break;
      case 'durable-blueprint':
        durableBlueprint = {
          componentRef: seed.componentRef === 'present',
          body: seed.body === 'stored',
        };
        break;
      case 'committed-render':
        committedRenders.set(seed.session, seed.size);
        break;
      case 'uncommitted-render':
        uncommittedRenders.add(seed.session);
        break;
      case 'registered-blueprint':
        registeredKeys.set(seed.as, REGISTRY_KEY);
        break;
    }
  }
  return {
    identityRecords,
    durableBlueprint,
    committedRenders,
    uncommittedRenders,
    registeredKeys,
  };
}

function errorOutcome(
  code: number,
  message: string,
  data?: unknown,
): { readonly kind: 'error'; readonly error: JsonRpcErrorFrame } {
  return {
    kind: 'error',
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function mountUnavailable(
  flaw: Flaw,
  dataCode: string,
  detail: string,
): { readonly kind: 'error'; readonly error: JsonRpcErrorFrame } {
  if (flaw === 'internal-error-for-mount-unavailable') {
    return errorOutcome(INTERNAL_ERROR_CODE, 'Internal error');
  }
  return errorOutcome(MOUNT_UNAVAILABLE_CODE, `Cannot mount: ${detail}`, {
    code: dataCode,
    detail,
  });
}

function notFound(
  flaw: Flaw,
  session: string,
): { readonly kind: 'error'; readonly error: JsonRpcErrorFrame } {
  return errorOutcome(
    flaw === 'wrong-number-for-not-found' ? INTERNAL_ERROR_CODE : NOT_FOUND_CODE,
    flaw === 'not-found-message-names-the-locator'
      ? `Resource ${session} not found.`
      : NOT_FOUND_MESSAGE,
    flaw === 'not-found-carries-a-detail'
      ? { code: 'NOT_FOUND', detail: 'the caller may not read this render' }
      : { code: 'NOT_FOUND' },
  );
}

function mounted(flaw: Flaw, scenario: ResourceReadScenario): ResourceReadOutcome {
  if (flaw === 'dead-shell-on-success') return { kind: 'mount', renderMeta: {} };
  if (scenario.server.staticDelivery === true) {
    return { kind: 'mount', renderMeta: { codeUrl: 'https://code.example/code/abc.js' } };
  }
  return {
    kind: 'mount',
    renderMeta: { wsUrl: 'wss://live.example/app', wsToken: 'token-abc' },
  };
}

/** Split `ui://ggui/render/{sessionId}[/{blueprintKey}]`; null names no locator. */
function parseLocator(uri: string): { readonly session: string; readonly key?: string } | null {
  const prefix = 'ui://ggui/render/';
  if (!uri.startsWith(prefix)) return null;
  const segments = uri.slice(prefix.length).split('/');
  const session = segments[0];
  if (session === undefined || session.length === 0) return null;
  if (segments.length === 1) return { session };
  const key = segments[1];
  if (segments.length > 2 || key === undefined || key.length === 0) return null;
  return { session, key };
}

/**
 * Build a scenario driver over the in-test server.
 *
 * Written as the obligations read: the substrate answer is
 * deployment-global, the access check precedes every branch that can
 * return something other than NOT_FOUND, and every read has exactly one
 * exit.
 */
function makeDriver(flaw: Flaw = 'none'): ResourceReadScenarioDriver {
  return async (scenario: ResourceReadScenario): Promise<PreparedResourceReadScenario> => {
    const state = applySeeds(scenario.seeds);
    const substrate = scenario.server.durableSubstrate === 'all';
    const staticDelivery = scenario.server.staticDelivery === true;
    const hasChannel = staticDelivery || scenario.server.liveChannel === true;
    const registryKey =
      scenario.server.blueprintRegistry === true && state.registeredKeys.size > 0
        ? REGISTRY_KEY
        : undefined;
    // The access gate. A caller with no claim to a render sees exactly
    // what a caller reading a locator that never existed sees, so
    // ownership is folded into visibility rather than branched on later.
    const owns = scenario.caller === 'owner' || flaw === 'refusal-answers-a-resolution-code';

    let readCount = 0;

    /**
     * Stamp a benign extra field onto every error after the first.
     *
     * Chosen to slip past every OTHER check: the number is untouched,
     * `data.code` is untouched, it is not `detail` (so `detailAbsent`
     * does not see it), and it names nothing a case declares as a
     * secret. The only thing left that can notice is the byte
     * comparison between the fused probes — which is the point.
     */
    const varyIfNotFirst = (outcome: ResourceReadOutcome): ResourceReadOutcome => {
      if (flaw !== 'varies-one-field-between-reads') return outcome;
      if (readCount <= 1 || outcome.kind !== 'error') return outcome;
      const data = outcome.error.data;
      return {
        kind: 'error',
        error: {
          ...outcome.error,
          data: isRecord(data) ? { ...data, attempt: readCount } : data,
        },
      };
    };

    const read = async (uri: string): Promise<ResourceReadOutcome> => {
      readCount += 1;
      return varyIfNotFirst(await readOnce(uri));
    };

    const readOnce = async (uri: string): Promise<ResourceReadOutcome> => {
      const parsed = parseLocator(uri);
      if (parsed === null) {
        if (flaw === 'malformed-uri-answers-not-found') return notFound(flaw, uri);
        return errorOutcome(INVALID_PARAMS_CODE, `Invalid resource URI: ${uri}`);
      }
      const { session, key } = parsed;

      if (owns && state.committedRenders.has(session)) {
        if (hasChannel) return mounted(flaw, scenario);
        // No wired channel: an under-cap component still mounts through
        // the inline codeB64 channel; only an over-cap one has nothing.
        if (state.committedRenders.get(session) === 'under-inline-cap') {
          if (flaw === 'dead-shell-on-success') return { kind: 'mount', renderMeta: {} };
          return { kind: 'mount', renderMeta: { codeB64: 'ZXhwb3J0IGRlZmF1bHQgKCkgPT4gbnVsbA==' } };
        }
        return mountUnavailable(
          flaw,
          'NOT_MOUNTABLE',
          'no static component URL and no live channel is wired',
        );
      }
      if (owns && state.uncommittedRenders.has(session)) {
        return mountUnavailable(
          flaw,
          'NOT_MOUNTABLE',
          'the render has not committed a component yet',
        );
      }

      // Nothing visible under that locator. The registry fallback is
      // keyed by the locator's own key, so it is row-independent — it
      // answers the same for a refused read and for a miss.
      if (registryKey !== undefined && key === registryKey) {
        return staticDelivery
          ? mounted(flaw, scenario)
          : mountUnavailable(
              flaw,
              'NOT_MOUNTABLE',
              'the matched blueprint has no delivery channel',
            );
      }
      if (!substrate) {
        if (flaw === 'substrate-less-answers-not-found') return notFound(flaw, session);
        return mountUnavailable(flaw, 'NOT_SUPPORTED', 'this server keeps no durable record');
      }

      const record = owns ? state.identityRecords.get(session) : undefined;
      if (record === undefined) return notFound(flaw, session);
      if (!record.named) {
        return mountUnavailable(flaw, 'BLUEPRINT_UNRESOLVABLE', 'the record names no blueprint');
      }
      if (state.durableBlueprint === null) {
        return mountUnavailable(
          flaw,
          'BLUEPRINT_UNRESOLVABLE',
          'the blueprint the record names is gone',
        );
      }
      if (!state.durableBlueprint.componentRef) {
        return mountUnavailable(
          flaw,
          'BLUEPRINT_UNRESOLVABLE',
          'the blueprint stores no component reference',
        );
      }
      if (!state.durableBlueprint.body) {
        return mountUnavailable(
          flaw,
          'BLUEPRINT_UNRESOLVABLE',
          'the component body behind the blueprint is gone',
        );
      }
      return hasChannel
        ? mounted(flaw, scenario)
        : mountUnavailable(
            flaw,
            'NOT_MOUNTABLE',
            'no static component URL and no live channel is wired',
          );
    };

    return { read, registeredKeys: Object.fromEntries(state.registeredKeys) };
  };
}

// =============================================================================
// Catalog coherence
// =============================================================================

describe('resources/read catalog', () => {
  it('grades all four typed classes', () => {
    const graded = new Set<string>();
    for (const testCase of resourceReadCases) {
      for (const probe of testCase.reads) {
        if (probe.expect.kind === 'typed-error') graded.add(probe.expect.dataCode);
      }
    }
    expect([...graded].sort()).toEqual([
      'BLUEPRINT_UNRESOLVABLE',
      'NOT_FOUND',
      'NOT_MOUNTABLE',
      'NOT_SUPPORTED',
    ]);
  });

  it('grades the mount half too, so no server passes by failing everything', () => {
    const mountCases = resourceReadCases.filter((c) =>
      c.reads.some((p) => p.expect.kind === 'live-mount'),
    );
    expect(mountCases.map((c) => c.name).sort()).toEqual([
      'channel-less-read-mounts-inline',
      'evicted-row-remints-from-the-durable-record',
      'live-row-read-returns-mount-material',
    ]);
  });

  it('names every case uniquely, and every probe uniquely within its case', () => {
    const names = resourceReadCases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const testCase of resourceReadCases) {
      const probes = testCase.reads.map((p) => p.as);
      expect(new Set(probes).size, `case '${testCase.name}' repeats a probe name`).toBe(
        probes.length,
      );
    }
  });

  it('pins EXACTLY which cases carry the byte-identity obligation', () => {
    // Deleting `indistinguishable` from a case JSON is otherwise silent:
    // the case keeps passing, having quietly stopped asserting the one
    // thing it exists for. Pinned as an exact set so both directions are
    // a deliberate act — losing it fails here, and adding it to a new
    // case has to be recorded here too.
    const fused = resourceReadCases
      .filter((c) => (c.indistinguishable ?? []).length > 0)
      .map((c) => c.name)
      .sort();
    expect(fused).toEqual([
      'all-ephemeral-substrate-fuses-like-none',
      'half-wired-blueprints-only-substrate-fuses-like-none',
      'half-wired-identity-only-substrate-fuses-like-none',
      'read-refusal-is-indistinguishable-from-a-miss',
      'registry-match-fuses-on-not-mountable',
      'substrate-less-fusion-of-refusal-and-miss',
    ]);
  });

  it('gives every fused case at least two probes to compare', () => {
    // A group naming one probe compares nothing; `parseCase` rejects
    // that shape, and this is the catalog-side half of the same rule.
    for (const testCase of resourceReadCases) {
      const group = testCase.indistinguishable ?? [];
      if (group.length === 0) continue;
      expect(group.length, `case '${testCase.name}'`).toBeGreaterThanOrEqual(2);
    }
  });

  it('resolves every `indistinguishable` reference to a probe of the same case', () => {
    for (const testCase of resourceReadCases) {
      const probes = new Set(testCase.reads.map((p) => p.as));
      expect(
        (testCase.indistinguishable ?? []).length,
        `case '${testCase.name}' declares a group of one`,
      ).not.toBe(1);
      for (const ref of testCase.indistinguishable ?? []) {
        expect(probes, `case '${testCase.name}' names unknown probe '${ref}'`).toContain(ref);
      }
    }
  });

  it('resolves every registered-key reference to a seed of the same case', () => {
    for (const testCase of resourceReadCases) {
      const seeded = new Set(
        testCase.seeds.flatMap((s) => (s.kind === 'registered-blueprint' ? [s.as] : [])),
      );
      for (const probe of testCase.reads) {
        if (probe.locator.kind === 'render' && probe.locator.key?.kind === 'registered') {
          expect(
            seeded,
            `case '${testCase.name}' probe '${probe.as}' names unseeded registry key '${probe.locator.key.seed}'`,
          ).toContain(probe.locator.key.seed);
        }
      }
    }
  });

  it('reads a seeded record under the key that record was stamped with', () => {
    // Otherwise a case could seed one key and read another, and the
    // resulting miss would look like a re-mint failure.
    for (const testCase of resourceReadCases) {
      for (const seed of testCase.seeds) {
        if (seed.kind !== 'identity-record') continue;
        const probe = testCase.reads.find(
          (p) => p.locator.kind === 'render' && p.locator.session === seed.session,
        );
        if (probe === undefined || probe.locator.kind !== 'render') continue;
        if (probe.locator.key === undefined) continue;
        expect(
          probe.locator.key,
          `case '${testCase.name}' seeds a record under '${seed.key}' but reads another key`,
        ).toEqual({ kind: 'literal', value: seed.key });
      }
    }
  });

  it('declares `disclosesNothing` on every case that reads a refused locator', () => {
    // The fusion check normalizes session segments away before
    // comparing, so a server echoing the refused session into BOTH
    // frames would compare equal. `disclosesNothing` is what closes
    // that, and a fusion case without it grades weaker than it reads.
    for (const testCase of resourceReadCases) {
      if (testCase.caller !== 'other') continue;
      expect(
        testCase.disclosesNothing ?? [],
        `case '${testCase.name}' reads as another caller but declares no disclosure bound`,
      ).not.toEqual([]);
    }
  });

  it('builds the locator URIs the protocol grammar defines', () => {
    expect(renderLocatorUri({ kind: 'render', session: 'sess-1' })).toBe(
      'ui://ggui/render/sess-1',
    );
    expect(
      renderLocatorUri({
        kind: 'render',
        session: 'sess-1',
        key: { kind: 'literal', value: 'fedcba9876543210' },
      }),
    ).toBe('ui://ggui/render/sess-1/fedcba9876543210');
    expect(
      renderLocatorUri(
        { kind: 'render', session: 'sess-1', key: { kind: 'registered', seed: 'fallback' } },
        { fallback: 'aaaabbbbccccdddd' },
      ),
    ).toBe('ui://ggui/render/sess-1/aaaabbbbccccdddd');
    expect(renderLocatorUri({ kind: 'raw', uri: 'ui://ggui/render//k' })).toBe(
      'ui://ggui/render//k',
    );
  });

  it('recognizes each of the three delivery channels, and nothing else', () => {
    expect(declaresDeliveryChannel({ codeUrl: 'https://code.example/x.js' })).toBe(true);
    expect(declaresDeliveryChannel({ wsUrl: 'wss://x', wsToken: 't' })).toBe(true);
    expect(declaresDeliveryChannel({ kind: 'error-card' })).toBe(true);
    expect(declaresDeliveryChannel({})).toBe(false);
    // A half-declared live channel is not a channel — an endpoint with
    // no token cannot be opened, a token with no endpoint has nowhere
    // to go.
    expect(declaresDeliveryChannel({ wsUrl: 'wss://x' })).toBe(false);
    expect(declaresDeliveryChannel({ wsToken: 't' })).toBe(false);
    expect(declaresDeliveryChannel({ codeUrl: '' })).toBe(false);
  });
});

// =============================================================================
// The case-authoring trust boundary
// =============================================================================

describe('parseCase — a malformed case aborts the run, never grades a server', () => {
  // Authored as plain values, deliberately un-annotated: `parseCase`
  // takes `unknown` because it IS the trust boundary, so these tests
  // hand it exactly what a mis-authored JSON file would — no type
  // assertion talking the compiler into a shape the value does not
  // have.
  const base = {
    name: 'probe-case',
    description: 'fixture for the parse tests',
    server: { durableSubstrate: 'all', liveChannel: true },
    caller: 'owner',
    seeds: [],
    reads: [
      {
        as: 'only',
        locator: { kind: 'render', session: 's' },
        expect: { kind: 'typed-error', jsonRpcCode: NOT_FOUND_CODE, dataCode: 'NOT_FOUND' },
      },
    ],
  };

  it('accepts a well-formed case', () => {
    const parsed: ResourceReadConformanceCase = parseCase(base);
    expect(parsed.name).toBe('probe-case');
    expect(parsed.reads[0]?.expect).toEqual({
      kind: 'typed-error',
      jsonRpcCode: NOT_FOUND_CODE,
      dataCode: 'NOT_FOUND',
    });
  });

  it('drops nothing the runner grades on', () => {
    // The parse CONSTRUCTS its result rather than passing the input
    // through, so a field it forgets to copy would silently stop being
    // graded. Looked up BY NAME: reordering the catalog must not
    // quietly move this assertion onto a case with fewer fields.
    const name = 'read-refusal-is-indistinguishable-from-a-miss';
    const original = resourceReadCases.find((c) => c.name === name);
    expect(original, `case '${name}' is missing from the catalog`).toBeDefined();
    // The richest case in the catalog — seeds of two kinds, two probes,
    // a fusion group and a disclosure list — so every optional field
    // the constructor could forget is present in this one.
    expect(original?.indistinguishable ?? []).not.toEqual([]);
    expect(original?.disclosesNothing ?? []).not.toEqual([]);
    expect(parseCase(original)).toEqual(original);
  });

  it('rejects an unknown key on the server shape', () => {
    // The expensive typo: `liveChanel` leaves the flag undefined, so the
    // case brings up a server with no live channel and grades THAT,
    // passing while asserting something other than what it reads as.
    expect(() =>
      parseCase({ ...base, server: { durableSubstrate: 'all', liveChanel: true } }),
    ).toThrow(/unknown key 'liveChanel'/);
  });

  it('rejects an unknown key on a case, a seed, a probe and an expectation', () => {
    expect(() => parseCase({ ...base, indistinguishible: ['only'] })).toThrow(
      /unknown key 'indistinguishible'/,
    );
    expect(() =>
      parseCase({
        ...base,
        seeds: [{ kind: 'committed-render', session: 's', appId: 'nope' }],
      }),
    ).toThrow(/unknown key 'appId'/);
    expect(() =>
      parseCase({
        ...base,
        reads: [{ ...base.reads[0], timeoutMs: 100 }],
      }),
    ).toThrow(/unknown key 'timeoutMs'/);
    expect(() =>
      parseCase({
        ...base,
        reads: [
          {
            as: 'only',
            locator: { kind: 'render', session: 's' },
            expect: {
              kind: 'typed-error',
              jsonRpcCode: NOT_FOUND_CODE,
              dataCode: 'NOT_FOUND',
              messageContains: 'not found',
            },
          },
        ],
      }),
    ).toThrow(/unknown key 'messageContains'/);
  });

  it('rejects a classification outside the closed set', () => {
    expect(() =>
      parseCase({
        ...base,
        reads: [
          {
            as: 'only',
            locator: { kind: 'render', session: 's' },
            expect: {
              kind: 'typed-error',
              jsonRpcCode: MOUNT_UNAVAILABLE_CODE,
              // A code from the tool-result surface, not this one.
              dataCode: 'PRODUCTION_FAILED',
            },
          },
        ],
      }),
    ).toThrow(/unknown classification 'PRODUCTION_FAILED'/);
  });

  it('rejects a classification pinned to the wrong number', () => {
    expect(() =>
      parseCase({
        ...base,
        reads: [
          {
            as: 'only',
            locator: { kind: 'render', session: 's' },
            expect: {
              kind: 'typed-error',
              jsonRpcCode: MOUNT_UNAVAILABLE_CODE,
              dataCode: 'NOT_FOUND',
            },
          },
        ],
      }),
    ).toThrow(/pins -32006 for 'NOT_FOUND', which rides on -32002/);
  });

  it('rejects an unknown expectation kind', () => {
    expect(() =>
      parseCase({
        ...base,
        reads: [
          {
            as: 'only',
            locator: { kind: 'render', session: 's' },
            expect: { kind: 'eventually-mounts' },
          },
        ],
      }),
    ).toThrow(/unknown expectation kind 'eventually-mounts'/);
  });

  it('rejects an unknown locator kind', () => {
    expect(() =>
      parseCase({
        ...base,
        reads: [
          { as: 'only', locator: { kind: 'short-code', code: 'abc' }, expect: { kind: 'live-mount' } },
        ],
      }),
    ).toThrow(/unknown locator kind 'short-code'/);
  });

  it('rejects an indistinguishability group naming a probe that does not exist', () => {
    expect(() => parseCase({ ...base, indistinguishable: ['only', 'ghost'] })).toThrow(
      /names unknown probe 'ghost'/,
    );
  });

  it('rejects an indistinguishability group of one', () => {
    // It would read as a graded obligation and assert nothing.
    expect(() => parseCase({ ...base, indistinguishable: ['only'] })).toThrow(
      /group of one asserts nothing|names a single probe/,
    );
  });

  it('rejects an unknown seed kind', () => {
    expect(() => parseCase({ ...base, seeds: [{ kind: 'purged-render' }] })).toThrow(
      /unknown seed kind 'purged-render'/,
    );
  });

  it('rejects an identity-record seed that names no key', () => {
    // Without the key there is nothing tying the record to the locator
    // a probe reads, and the resulting miss would look like a broken
    // re-mint.
    expect(() =>
      parseCase({ ...base, seeds: [{ kind: 'identity-record', session: 's', blueprint: 'named' }] }),
    ).toThrow(/'key' must be a non-empty string/);
  });

  it('rejects a case that reads nothing', () => {
    expect(() => parseCase({ ...base, reads: [] })).toThrow(/a case that reads nothing/);
  });

  it('parses every shipped case', () => {
    for (const testCase of resourceReadCases) {
      expect(() => parseCase(testCase), `case '${testCase.name}'`).not.toThrow();
    }
  });
});

// =============================================================================
// The runner, against a conformant server
// =============================================================================

describe('runResourceReadConformance — a conformant server', () => {
  it('passes every case, skips none, fails none', async () => {
    const result = await runResourceReadConformance(makeDriver());
    const diagnostic = JSON.stringify(
      { failed: result.failed, skipped: result.skipped },
      null,
      2,
    );
    expect(result.failed, diagnostic).toEqual([]);
    expect(result.skipped, diagnostic).toEqual([]);
    expect([...result.passed].sort()).toEqual(resourceReadCases.map((c) => c.name).sort());
  });
});

// =============================================================================
// The runner, against servers that break exactly one obligation
// =============================================================================

describe('runResourceReadConformance — rejection pins', () => {
  async function failedNames(flaw: Flaw): Promise<readonly string[]> {
    const result = await runResourceReadConformance(makeDriver(flaw));
    // A flaw must never turn a case into a SKIP — that would hide a
    // real defect behind "the kit could not observe it".
    expect(result.skipped, `flaw '${flaw}' produced skips`).toEqual([]);
    return result.failed.map((f) => f.name).sort();
  }

  it('fails the -32006 cases when a server reports them as internal errors', async () => {
    const failed = await failedNames('internal-error-for-mount-unavailable');
    expect(failed).toContain('read-record-with-purged-blueprint-answers-blueprint-unresolvable');
    expect(failed).toContain('read-on-a-substrate-less-server-answers-not-supported');
    expect(failed).toContain('read-without-a-delivery-channel-answers-not-mountable');
  });

  it('fails the miss case when NOT_FOUND rides on the wrong number', async () => {
    expect(await failedNames('wrong-number-for-not-found')).toContain(
      'read-miss-answers-not-found',
    );
  });

  it('fails the fusion case when the NOT_FOUND message names the locator', async () => {
    expect(await failedNames('not-found-message-names-the-locator')).toContain(
      'read-refusal-is-indistinguishable-from-a-miss',
    );
  });

  it('fails the miss case when NOT_FOUND carries a detail key', async () => {
    expect(await failedNames('not-found-carries-a-detail')).toContain(
      'read-miss-answers-not-found',
    );
  });

  it('fails the fusion case when a late access check leaks a resolution verdict', async () => {
    expect(await failedNames('refusal-answers-a-resolution-code')).toContain(
      'read-refusal-is-indistinguishable-from-a-miss',
    );
  });

  it('fails the malformed-locator case when a URI naming no locator answers NOT_FOUND', async () => {
    expect(await failedNames('malformed-uri-answers-not-found')).toContain(
      'malformed-locator-stays-outside-the-typed-set',
    );
  });

  it('fails both mount cases when a successful read carries no delivery channel', async () => {
    const failed = await failedNames('dead-shell-on-success');
    expect(failed).toContain('live-row-read-returns-mount-material');
    expect(failed).toContain('evicted-row-remints-from-the-durable-record');
  });

  it('fails the substrate-less cases when a miss answers NOT_FOUND instead', async () => {
    const failed = await failedNames('substrate-less-answers-not-found');
    expect(failed).toContain('read-on-a-substrate-less-server-answers-not-supported');
    expect(failed).toContain('substrate-less-fusion-of-refusal-and-miss');
    expect(failed).toContain('half-wired-identity-only-substrate-fuses-like-none');
    expect(failed).toContain('half-wired-blueprints-only-substrate-fuses-like-none');
  });

  it('fails the fused cases when ONE field varies between the two reads', async () => {
    // The byte-identity arm is the catalog's core obligation, and until
    // this flaw existed it was graded by nothing: every other flaw trips
    // a per-probe check or the disclosure check first, so
    // `gradeIndistinguishable` could have been `return null` with the
    // whole repo green.
    //
    // This server gets the number right, the classification right, and
    // discloses nothing — it just does not answer the same bytes twice.
    const failed = await failedNames('varies-one-field-between-reads');
    expect(failed).toContain('read-refusal-is-indistinguishable-from-a-miss');
    expect(failed).toContain('substrate-less-fusion-of-refusal-and-miss');
    expect(failed).toContain('half-wired-identity-only-substrate-fuses-like-none');
    expect(failed).toContain('half-wired-blueprints-only-substrate-fuses-like-none');
    expect(failed).toContain('registry-match-fuses-on-not-mountable');
  });

  it('attributes that failure to the byte-identity obligation, not another check', async () => {
    // Otherwise the case above could pass because some unrelated check
    // happened to fire, leaving the arm untested after all.
    const result = await runResourceReadConformance(
      makeDriver('varies-one-field-between-reads'),
    );
    const failure = result.failed.find(
      (f) => f.name === 'read-refusal-is-indistinguishable-from-a-miss',
    );
    expect(failure?.obligation).toBe(
      'a refused read and a read of a locator that never existed are the same bytes',
    );
  });

  it('leaves the single-probe cases alone under that flaw', async () => {
    // Non-vacuity for the flaw itself: it varies a field only BETWEEN
    // reads, so a case that reads once has nothing to differ from and
    // must stay green. If those failed too, the flaw would be tripping
    // some per-probe check and would prove nothing about fusion.
    const failed = await failedNames('varies-one-field-between-reads');
    expect(failed).not.toContain('read-miss-answers-not-found');
    expect(failed).not.toContain('read-on-a-substrate-less-server-answers-not-supported');
    expect(failed).not.toContain(
      'read-record-with-purged-blueprint-answers-blueprint-unresolvable',
    );
    expect(failed).not.toContain('read-without-a-delivery-channel-answers-not-mountable');
  });

  it('names the violated obligation, not just the case', async () => {
    const result = await runResourceReadConformance(makeDriver('dead-shell-on-success'));
    const failure = result.failed.find((f) => f.name === 'live-row-read-returns-mount-material');
    expect(failure?.obligation).toBe('any successful result IS a live mount');
    expect(failure?.probe).toBe('live');
  });
});

// =============================================================================
// Runner mechanics — how a gap is recorded
// =============================================================================

describe('runResourceReadConformance — gaps are skips, never passes', () => {
  it('skips a case whose scenario the driver refuses to prepare', async () => {
    const conformant = makeDriver();
    const driver: ResourceReadScenarioDriver = async (scenario) => {
      if (scenario.server.durableSubstrate === 'identity-only') {
        throw new Error('this server cannot be brought up with a half-wired substrate');
      }
      return conformant(scenario);
    };
    const result = await runResourceReadConformance(driver);
    const name = 'half-wired-identity-only-substrate-fuses-like-none';
    expect(result.skipped.map((s) => s.name)).toEqual([name]);
    expect(result.skipped[0]?.reason).toContain('half-wired substrate');
    expect(result.passed).not.toContain(name);
    expect(result.failed.map((f) => f.name)).not.toContain(name);
  });

  it('skips a case whose registry seed the driver did not resolve to a key', async () => {
    const conformant = makeDriver();
    const driver: ResourceReadScenarioDriver = async (scenario) => {
      const prepared = await conformant(scenario);
      return { read: prepared.read };
    };
    const result = await runResourceReadConformance(driver);
    expect(result.skipped.map((s) => s.name)).toEqual(['registry-match-fuses-on-not-mountable']);
    expect(result.skipped[0]?.reason).toContain('fallback');
  });

  it('FAILS — never skips — when the read itself throws', async () => {
    // A refused SCENARIO is a gap in what the driver can express. A
    // throwing READ is the thing under test misbehaving. Collapsing the
    // two would let a server hide every defect behind a skip.
    const driver: ResourceReadScenarioDriver = async (scenario) => ({
      // Registry seeds still resolve, so every case reaches its read
      // rather than skipping on an unresolved locator — the throw has
      // to be the ONLY thing this run exercises.
      registeredKeys: Object.fromEntries(
        scenario.seeds.flatMap((seed) =>
          seed.kind === 'registered-blueprint' ? [[seed.as, REGISTRY_KEY]] : [],
        ),
      ),
      read: async (): Promise<ResourceReadOutcome> => {
        throw new Error('connection reset');
      },
    });
    const result = await runResourceReadConformance(driver);
    expect(result.failed.length).toBe(resourceReadCases.length);
    expect(result.skipped).toEqual([]);
    expect(result.passed).toEqual([]);
    expect(result.failed[0]?.message).toContain('threw instead of resolving');
  });

  it('records at most one failure per case', async () => {
    const result = await runResourceReadConformance(makeDriver('dead-shell-on-success'));
    const names = result.failed.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('grades only the named cases when `only` is passed', async () => {
    const result = await runResourceReadConformance(makeDriver(), {
      only: ['read-miss-answers-not-found'],
    });
    expect(result.passed).toEqual(['read-miss-answers-not-found']);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('disposes every prepared scenario, including the ones that fail', async () => {
    let prepared = 0;
    let disposed = 0;
    const flawed = makeDriver('internal-error-for-mount-unavailable');
    const driver: ResourceReadScenarioDriver = async (scenario) => {
      prepared += 1;
      const inner = await flawed(scenario);
      return {
        read: inner.read,
        ...(inner.registeredKeys !== undefined ? { registeredKeys: inner.registeredKeys } : {}),
        dispose: async () => {
          disposed += 1;
        },
      };
    };
    const result = await runResourceReadConformance(driver);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(prepared).toBe(resourceReadCases.length);
    expect(disposed).toBe(prepared);
  });
});
