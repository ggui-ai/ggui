/**
 * Read-plane-only conformance catalog (ggui#1304) — grades a server's
 * tool RESULT under the read-plane-only posture (SPEC §7.10.6), the half
 * of the read-plane door the resource-read catalog does not see.
 *
 * ## The obligation this catalog grades
 *
 * A server running the posture publishes a committed render's IDENTITY
 * and nothing else: the render locator on `structuredContent.resourceUri`
 * and the same value on the MCP Apps pointer `_meta.ui.resourceUri`
 * (and on the legacy flat `_meta["ui/resourceUri"]` when it emits one).
 * The result carries neither the `ai.ggui/render` slice nor a live
 * channel token, anywhere. A host then mounts only through an
 * authenticated `resources/read` of that locator, and that read returns
 * a live mount (SPEC §7.10.2, graded in full by the resource-read
 * catalog; here, once, on the locator the result published).
 *
 * The two halves fail differently, which is why both are graded. A
 * result carrying the slice or a token has sent mount material across a
 * chat transcript the posture exists to keep it out of. A result missing
 * the pointer, or carrying two different locators, leaves a
 * spec-canonical host nothing to mount, or the wrong thing (the prod
 * "Waiting for tool result…" of 2026-08-16→17, ggui#537).
 *
 * ## What an adopter implements
 *
 * {@link runReadPlaneOnlyConformance} takes a
 * {@link ReadPlaneOnlyScenarioDriver}: bring a server up with the
 * posture ON and hand back two operations. `render()` performs ONE
 * committed render by the adopter's own means (priming, handshake,
 * generator: none of it is graded) and returns the raw `tools/call`
 * result the MCP client received. `read(uri)` performs one
 * `resources/read` and reports the outcome in the resource-read
 * catalog's shape. The kit imports no server.
 *
 * Grade rules, as in the resource-read catalog:
 *
 *   - A driver that cannot bring the posture up throws from the driver
 *     function. Every case records a SKIP with that reason, never a pass.
 *   - A `render()` that throws, or returns anything but a committed
 *     result, FAILS `render-committed`: the render is under test, and
 *     nothing after it can be graded.
 *
 * ## What this catalog deliberately does NOT grade
 *
 *   - **How the render was produced.** Priming, cache or fresh
 *     generation, the handshake: the posture governs the result, not
 *     the path to it.
 *   - **`_meta` keys beyond the named ones.** An MCP result may carry
 *     other `_meta` members; the catalog grades the absence of the slice
 *     and of the token, and the presence and equality of the pointer.
 *   - **The host.** Whether a host takes the door is graded by the
 *     host-helper catalog's H2 (an advertised `serverResources` answers
 *     `resources/read`) and by the reference e2e, not here.
 *   - **`ggui_update`.** The posture binds every handler's result; this
 *     catalog grades the render, the one every mount starts from.
 */
import type { RawToolCallResult } from '../domain-error-conformance/index.js';
import {
  declaresDeliveryChannel,
  type ResourceReadOutcome,
} from '../resource-read-conformance/index.js';
import withheldRenderMounts from './cases/withheld-render-mounts-through-the-read.json' with { type: 'json' };

// =============================================================================
// Authored vocabulary
// =============================================================================

/** What a case pins, as literals in its JSON. */
export interface ReadPlaneOnlyExpectation {
  /** The prefix every render locator carries. */
  readonly locatorPrefix: string;
  /** `_meta` members the result MUST NOT carry: the slice. */
  readonly withheldMetaKeys: readonly string[];
  /** Keys that MUST NOT appear at any depth of the result: live credentials. */
  readonly withheldCredentialKeys: readonly string[];
  /** What the read of the published locator MUST produce. */
  readonly read: 'live-mount';
}

/**
 * One read-plane-only case. Authored as JSON under `./cases/`, consumed
 * via {@link readPlaneOnlyCases}. The shape IS the public API — additive
 * changes only.
 */
export interface ReadPlaneOnlyConformanceCase {
  /** Unique case name. MUST match the JSON filename without `.json`. */
  readonly name: string;
  readonly description: string;
  readonly expect: ReadPlaneOnlyExpectation;
}

/**
 * The criteria a case is graded on, in the order they are checked.
 * `render-committed` gates the rest: a render that did not commit has no
 * result to grade.
 */
export type ReadPlaneOnlyCriterion =
  | 'render-committed'
  | 'locator-on-structured-content'
  | 'locator-on-meta'
  | 'one-locator'
  | 'slice-withheld'
  | 'credential-withheld'
  | 'read-mounts';

// =============================================================================
// Driver seam
// =============================================================================

/** What the driver is asked to bring up. */
export interface ReadPlaneOnlyScenario {
  /** The case being prepared — for the driver's own diagnostics. */
  readonly caseName: string;
}

/** A server running the posture, ready to render and be read. */
export interface PreparedReadPlaneOnlyScenario {
  /**
   * Perform ONE committed render with the posture on, and return the raw
   * `tools/call` result exactly as the MCP client received it.
   */
  render(): Promise<RawToolCallResult>;
  /**
   * Read one locator. MUST resolve — a protocol-level failure is
   * `{kind: 'error'}` carrying the raw frame, as in the resource-read
   * catalog.
   */
  read(uri: string): Promise<ResourceReadOutcome>;
  /** Tear the scenario down. Invoked after every case, pass or fail. */
  dispose?(): Promise<void>;
}

/**
 * Bring a server up with the read-plane-only posture on. Throwing
 * signals "I cannot express this scenario": the runner records a SKIP
 * with the message.
 */
export type ReadPlaneOnlyScenarioDriver = (
  scenario: ReadPlaneOnlyScenario,
) => Promise<PreparedReadPlaneOnlyScenario>;

// =============================================================================
// Catalog
// =============================================================================

/** Every read-plane-only case the kit ships. */
export const readPlaneOnlyCases: readonly ReadPlaneOnlyConformanceCase[] = [
  withheldRenderMounts as ReadPlaneOnlyConformanceCase,
];

// =============================================================================
// Runner
// =============================================================================

export interface ReadPlaneOnlyMismatch {
  readonly name: string;
  readonly criterion: ReadPlaneOnlyCriterion;
  readonly detail: string;
}

export interface ReadPlaneOnlySkip {
  readonly name: string;
  readonly reason: string;
}

export interface ReadPlaneOnlyConformanceResult {
  readonly passed: readonly string[];
  readonly failed: readonly ReadPlaneOnlyMismatch[];
  readonly skipped: readonly ReadPlaneOnlySkip[];
}

export interface RunReadPlaneOnlyConformanceOptions {
  /** Override the shipped catalog (tests, subsets). */
  readonly cases?: readonly ReadPlaneOnlyConformanceCase[];
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function stringMember(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const member: unknown = Reflect.get(value, key);
  return typeof member === 'string' ? member : undefined;
}

/** Every path at which one of `keys` appears, at any depth. */
function pathsOfKeys(value: unknown, keys: ReadonlySet<string>, at: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => pathsOfKeys(item, keys, `${at}[${i}]`));
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, member]) => [
    ...(keys.has(key) ? [`${at}.${key}`] : []),
    ...pathsOfKeys(member, keys, `${at}.${key}`),
  ]);
}

function describeRead(outcome: ResourceReadOutcome): string {
  return outcome.kind === 'error'
    ? `an error (${outcome.error.code}${stringMember(outcome.error.data, 'code') !== undefined ? `, data.code ${stringMember(outcome.error.data, 'code')}` : ''})`
    : 'contents that declare no delivery channel';
}

async function gradeCase(
  c: ReadPlaneOnlyConformanceCase,
  prepared: PreparedReadPlaneOnlyScenario,
): Promise<ReadPlaneOnlyMismatch[]> {
  const fail = (criterion: ReadPlaneOnlyCriterion, detail: string): ReadPlaneOnlyMismatch => ({
    name: c.name,
    criterion,
    detail,
  });

  let result: RawToolCallResult;
  try {
    result = await prepared.render();
  } catch (err) {
    return [fail('render-committed', `render() threw: ${err instanceof Error ? err.message : String(err)}`)];
  }
  if (result.isError === true || !isObject(result.structuredContent)) {
    return [
      fail(
        'render-committed',
        result.isError === true
          ? 'the render result is isError — the posture is graded on a committed render'
          : 'the render result carries no structuredContent',
      ),
    ];
  }

  const mismatches: ReadPlaneOnlyMismatch[] = [];
  const { locatorPrefix } = c.expect;
  const onContent = stringMember(result.structuredContent, 'resourceUri');
  if (onContent === undefined || !onContent.startsWith(locatorPrefix)) {
    mismatches.push(
      fail(
        'locator-on-structured-content',
        onContent === undefined
          ? 'structuredContent.resourceUri is absent — a client that strips _meta has no identity to hold'
          : `structuredContent.resourceUri '${onContent}' is not a render locator (${locatorPrefix}…)`,
      ),
    );
  }

  const meta = result._meta;
  const onMeta = stringMember(isObject(meta) ? Reflect.get(meta, 'ui') : undefined, 'resourceUri');
  if (onMeta === undefined) {
    mismatches.push(
      fail(
        'locator-on-meta',
        '_meta.ui.resourceUri is absent — a spec-canonical host has no pointer to mount, and falls back to the declaration-level shell',
      ),
    );
  }

  const legacy = stringMember(meta, 'ui/resourceUri');
  const published = [onContent, onMeta, legacy].filter((v): v is string => v !== undefined);
  if (new Set(published).size > 1) {
    mismatches.push(
      fail(
        'one-locator',
        `the result publishes more than one locator: ${[...new Set(published)].join(' ≠ ')}`,
      ),
    );
  }

  const presentSlices = c.expect.withheldMetaKeys.filter(
    (key) => isObject(meta) && Reflect.get(meta, key) !== undefined,
  );
  if (presentSlices.length > 0) {
    mismatches.push(
      fail('slice-withheld', `_meta carries ${presentSlices.join(', ')} — the posture withholds the mount material`),
    );
  }

  const credentialKeys = new Set(c.expect.withheldCredentialKeys);
  const credentialPaths = [
    ...pathsOfKeys(meta, credentialKeys, '_meta'),
    ...pathsOfKeys(result.structuredContent, credentialKeys, 'structuredContent'),
  ];
  if (credentialPaths.length > 0) {
    mismatches.push(
      fail(
        'credential-withheld',
        `a live credential crosses the transcript at ${credentialPaths.join(', ')} — the posture mints credentials only on the read`,
      ),
    );
  }

  const target = onContent ?? onMeta;
  if (target !== undefined && target.startsWith(locatorPrefix)) {
    let outcome: ResourceReadOutcome;
    try {
      outcome = await prepared.read(target);
    } catch (err) {
      mismatches.push(
        fail(
          'read-mounts',
          `read('${target}') threw: ${err instanceof Error ? err.message : String(err)} — a protocol failure resolves as {kind: 'error'}; a throw is graded as a failed read`,
        ),
      );
      return mismatches;
    }
    if (outcome.kind !== 'mount' || !declaresDeliveryChannel(outcome.renderMeta)) {
      mismatches.push(
        fail(
          'read-mounts',
          `reading the published locator '${target}' returned ${describeRead(outcome)} — under the posture the read is the only way to mount`,
        ),
      );
    }
  }

  return mismatches;
}

/**
 * Grade a server's read-plane-only posture. Vendor-neutral: the driver
 * binds the adopter's own server; the kit owns every assertion.
 */
export async function runReadPlaneOnlyConformance(
  driver: ReadPlaneOnlyScenarioDriver,
  options: RunReadPlaneOnlyConformanceOptions = {},
): Promise<ReadPlaneOnlyConformanceResult> {
  const passed: string[] = [];
  const failed: ReadPlaneOnlyMismatch[] = [];
  const skipped: ReadPlaneOnlySkip[] = [];

  for (const c of options.cases ?? readPlaneOnlyCases) {
    let prepared: PreparedReadPlaneOnlyScenario;
    try {
      prepared = await driver({ caseName: c.name });
    } catch (err) {
      skipped.push({ name: c.name, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      const mismatches = await gradeCase(c, prepared);
      if (mismatches.length === 0) passed.push(c.name);
      else failed.push(...mismatches);
    } finally {
      await prepared.dispose?.();
    }
  }

  return { passed, failed, skipped };
}
