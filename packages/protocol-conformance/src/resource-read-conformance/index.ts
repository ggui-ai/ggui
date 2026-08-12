/**
 * Resource-read conformance catalog — the kit's first MCP-binding
 * driver.
 *
 * ## The obligation this catalog grades
 *
 * A read of a render locator (`ui://ggui/render/{sessionId}` or
 * `ui://ggui/render/{sessionId}/{blueprintKey}`) has exactly TWO exits:
 * a result whose contents declare a delivery channel — a live mount —
 * or one typed JSON-RPC error. There is no third outcome. In
 * particular there is no successful result carrying a shell that can
 * never paint anything, which is what a loading placeholder returned on
 * a failure branch amounts to.
 *
 * That invariant is what makes the read host-checkable: a host that
 * gets `contents` back can mount them without inspecting anything, and
 * a host that gets an error can route on `error.data.code` — "come back
 * never" versus "come back with a fresh render" — without parsing prose.
 *
 * ## Why this is not a fixture in `../fixtures`
 *
 * `../fixtures` is the Path-A catalog: WebSocket-observable behaviors,
 * driven by `runConformance()` over a live channel with a runner-owned
 * subscribe frame and an observation window. A `resources/read` has no
 * WebSocket envelope, no subscribe and no frames to observe — it is a
 * request/response on the MCP binding. Registering these cases in the
 * Path-A catalog would make every WebSocket run carry a permanent skip
 * that could never become a pass on that transport, which is the false
 * gate the kit's skip-set pinning exists to prevent.
 *
 * So this catalog gets the treatment the gadget obligations already
 * get (`../schema-conformance`, `../registration-conformance`,
 * `../resolution-conformance`): its own case shape, its own runner, and
 * its cases shipped as raw JSON under `./cases/` so a non-TypeScript
 * implementer can grade their own server against the same catalog. The
 * difference is that those three grade a pure function while this one
 * drives a live server — hence the scenario driver below, which is the
 * seam an adopter implements.
 *
 * ## What an adopter implements
 *
 * {@link runResourceReadConformance} takes a
 * {@link ResourceReadScenarioDriver}: given a declared server shape,
 * caller identity and seed set, bring a server up that way and return
 * something that can read a URI. The kit never imports a concrete
 * server — adopters drive their OWN. The kit owns the locator grammar,
 * the wire numbers, and every assertion; the driver owns nothing but
 * "make my server look like this".
 *
 * Two rules make the grade honest:
 *
 *   - A driver that CANNOT express a scenario throws from the driver
 *     function. The runner records a SKIP with that reason — never a
 *     pass. A server that cannot be brought up half-wired cannot be
 *     graded on what a half-wired server answers.
 *   - A driver's {@link PreparedResourceReadScenario.read} MUST NOT
 *     throw for a protocol-level failure — it resolves with
 *     `{kind: 'error'}` carrying the RAW JSON-RPC error frame the
 *     server put on the wire. A throw from `read` is a FAIL, because
 *     the read is the thing under test. The raw frame matters: an MCP
 *     client's reconstructed error object rewrites `message`, and the
 *     indistinguishability obligation below is graded on bytes.
 *
 * ## What this catalog deliberately does NOT grade
 *
 *   - **The order in which a substrate-less server answers.**
 *     `NOT_SUPPORTED` describes the deployment, not the locator, so a
 *     server that keeps no durable record MAY answer it immediately —
 *     before any per-locator work, including the access check. Grading
 *     "the access check comes first" against such a server would fail a
 *     correct implementation. What IS graded is that its answer does
 *     not vary with the row (see `indistinguishable`), which is the
 *     property the ordering rule exists to produce.
 *   - **`detail` wording, on any code.** `detail` is optional operator
 *     context; two conformant servers word it differently. What is
 *     graded is its ABSENCE on `NOT_FOUND`, which is normative.
 *   - **The `NOT_FOUND` message literal.** What is normative is that
 *     the message is CONSTANT — identical for a refused read and a
 *     read of a locator that never existed. A server whose constant
 *     message reads differently is conformant; one whose message varies
 *     with the locator is not, and the fusion cases catch exactly that.
 *   - **Internal-error message text.** A `-32603` carries whatever the
 *     operator's own store or runtime produced. No case asserts its
 *     content, and none should — it is not protocol surface.
 *   - **The number a URI naming no locator receives — including
 *     negatively.** MCP assigns the resource-missing number to a
 *     `resources/read` of a URI the server does not serve, so a
 *     framework that maps every unrecognized URI onto it is behaving
 *     correctly; a catalog that banned that number would fail it
 *     forever. What IS graded is the classification: such a URI MUST
 *     NOT carry one of the four resource-read codes on
 *     `error.data.code`, because the four classify reads that name a
 *     locator and this names none. The two stay distinguishable on
 *     that alone.
 *   - **The shell's markup.** Success is graded on the projected render
 *     meta — the delivery channel it declares — never on DOM or HTML
 *     shape, which is a server's own presentation concern.
 */
import { isRecord } from '@ggui-ai/protocol';

import notFoundOnAMiss from './cases/read-miss-answers-not-found.json' with { type: 'json' };
import refusalIsAMiss from './cases/read-refusal-is-indistinguishable-from-a-miss.json' with { type: 'json' };
import purgedBlueprint from './cases/read-record-with-purged-blueprint-answers-blueprint-unresolvable.json' with { type: 'json' };
import substrateLess from './cases/read-on-a-substrate-less-server-answers-not-supported.json' with { type: 'json' };
import noDeliveryChannel from './cases/read-without-a-delivery-channel-answers-not-mountable.json' with { type: 'json' };
import substrateLessFusion from './cases/substrate-less-fusion-of-refusal-and-miss.json' with { type: 'json' };
import halfWiredIdentityOnly from './cases/half-wired-identity-only-substrate-fuses-like-none.json' with { type: 'json' };
import halfWiredBlueprintsOnly from './cases/half-wired-blueprints-only-substrate-fuses-like-none.json' with { type: 'json' };
import allEphemeral from './cases/all-ephemeral-substrate-fuses-like-none.json' with { type: 'json' };
import registryFusion from './cases/registry-match-fuses-on-not-mountable.json' with { type: 'json' };
import malformedLocator from './cases/malformed-locator-stays-outside-the-typed-set.json' with { type: 'json' };
import liveRowMount from './cases/live-row-read-returns-mount-material.json' with { type: 'json' };
import remintMount from './cases/evicted-row-remints-from-the-durable-record.json' with { type: 'json' };
import inlineMount from './cases/channel-less-read-mounts-inline.json' with { type: 'json' };
import pinnedImmutable from './cases/pinned-superseded-record-serves-its-reign-immutably.json' with { type: 'json' };
import pinPastHead from './cases/pin-past-the-head-answers-not-found.json' with { type: 'json' };

// =============================================================================
// Authored vocabulary
// =============================================================================

/**
 * The closed classification a typed read failure carries on
 * `error.data.code`.
 *
 * The kit's decoupled copy, per the authoring posture in `../types`:
 * fixtures compile against the kit's frozen vocabulary, never the live
 * protocol types. CLOSED, not extensibly-closed — a fifth code is a kit
 * version bump, because a catalog cannot grade a class it ships no case
 * for.
 */
export type ResourceReadErrorCodeDecl =
  | 'NOT_FOUND'
  | 'BLUEPRINT_UNRESOLVABLE'
  | 'NOT_SUPPORTED'
  | 'NOT_MOUNTABLE';

/**
 * How much of the record-keeping substrate a re-mint needs the server
 * to have bound.
 *
 * Restoring an evicted render needs the whole set — the record naming
 * what the render was, the blueprint it names, and the component body
 * behind that blueprint. A server holding only part of it can restore
 * nothing, so `identity-only` and `blueprints-only` are as
 * substrate-less as `none`; they exist as separate arms because they
 * are the shapes an operator actually reaches, by provisioning one
 * store and forgetting the other.
 *
 * `all-ephemeral` (#457): every store bound, every store DECLARING
 * ephemeral durability — binding is not durability, and a server whose
 * records die with the process MUST fuse like one holding nothing.
 * The arm an operator reaches by wiring three in-memory stores.
 */
export type DurableSubstrateWiring =
  | 'all'
  | 'none'
  | 'identity-only'
  | 'blueprints-only'
  | 'all-ephemeral';

/** The deployment shape a case needs the server under test to have. */
export interface ResourceReadServerShape {
  readonly durableSubstrate: DurableSubstrateWiring;
  /** Bind the blueprint registry a read can fall back to. Default false. */
  readonly blueprintRegistry?: boolean;
  /** Bind static component delivery (a fetchable component URL). Default false. */
  readonly staticDelivery?: boolean;
  /** Bind the live delivery channel. Default false. */
  readonly liveChannel?: boolean;
}

/**
 * Whose read this is. `owner` holds the seeded renders; `other` is a
 * caller with valid credentials and no claim to them — the identity
 * every disclosure obligation is stated against.
 */
export type ResourceReadCaller = 'owner' | 'other';

/**
 * State the driver installs before the reads. CLOSED vocabulary: an
 * unknown seed kind is a case-authoring error the runner throws on,
 * never a skip and never a verdict on the server.
 *
 * Every seed belongs to the `owner` identity, whichever caller the case
 * then reads as — that is what makes a refused read a read of something
 * that really is there.
 */
export type ResourceReadSeed =
  | {
      /** A durable record of a render that has since been evicted. */
      readonly kind: 'identity-record';
      readonly session: string;
      /**
       * The contract key the record was stamped with — the
       * `blueprintKey` segment a resume locator carries. Authored
       * explicitly so nothing about which key resolves which record is
       * implicit: a probe reading this record spells the same literal.
       */
      readonly key: string;
      /** Whether the record names a blueprint at all. */
      readonly blueprint: 'named' | 'unnamed';
    }
  | {
      /** The durable blueprint an `identity-record` names. */
      readonly kind: 'durable-blueprint';
      /** Whether the blueprint stores a reference to a component body. */
      readonly componentRef: 'present' | 'absent';
      /** Whether the body behind that reference is still stored. */
      readonly body: 'stored' | 'purged';
    }
  | {
      /** A live render row that has committed a component. */
      readonly kind: 'committed-render';
      readonly session: string;
      /**
       * Size class of the committed component relative to the inline
       * `codeB64` cap. `'under-inline-cap'` (the default) seeds a
       * component the server can deliver inline even with no wired
       * channels; `'over-inline-cap'` seeds one it cannot — the shape
       * that still exercises the no-delivery-channel failure arm on a
       * channel-less server.
       */
      readonly size: 'under-inline-cap' | 'over-inline-cap';
    }
  | {
      /** A live render row whose generation has not committed yet. */
      readonly kind: 'uncommitted-render';
      readonly session: string;
    }
  | {
      /**
       * A blueprint published to the registry a read falls back to. The
       * SERVER computes its key, so the driver reports the key back
       * through {@link PreparedResourceReadScenario.registeredKeys}
       * under this `as` name, and probes reference it there.
       */
      readonly kind: 'registered-blueprint';
      readonly as: string;
    }
  | {
      /**
       * A session with epoch HISTORY (#483): `records[0]` is the mint
       * (epoch 0), each later entry one `ggui_update` (epoch N). The
       * driver seeds the ledger so every superseded record is
       * reconstructable (an in-reign props event per record) and the
       * row carries the head epoch.
       */
      readonly kind: 'epoch-history';
      readonly session: string;
      readonly records: ReadonlyArray<{
        readonly props: Readonly<Record<string, unknown>>;
      }>;
    };

/**
 * The blueprint-key segment of a locator.
 *
 * `literal` is a value the case authors — the kit builds the URI from
 * it, so the case pins the exact bytes read. `registered` defers to a
 * key the server computed for a `registered-blueprint` seed, which is
 * the one value a case cannot know in advance.
 */
export type ResourceReadKey =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'registered'; readonly seed: string };

/**
 * What gets read.
 *
 * `render` is the protocol's locator grammar and the kit builds the URI
 * — a case never spells a well-formed locator out by hand, so the
 * grammar has one owner. `raw` exists for the probes whose whole point
 * is a URI that does NOT name a locator; there the exact string IS the
 * input under test.
 */
export type ResourceReadLocator =
  | {
      readonly kind: 'render';
      readonly session: string;
      readonly key?: ResourceReadKey;
      /**
       * Epoch pin (#483, SPEC §7.1.2.2): present ⇒ the kit reads the
       * PINNED history record (`…#N`); absent ⇒ the live head. The
       * fragment encoding is pinned HERE deliberately — the kit is
       * the arbiter of the wire grammar, so an encoding change is a
       * conscious, visible kit change.
       */
      readonly epoch?: number;
    }
  | { readonly kind: 'raw'; readonly uri: string };

/**
 * What one probe's read MUST produce. CLOSED vocabulary — see the
 * module docstring for what each arm deliberately leaves ungraded.
 */
export type ResourceReadExpectation =
  | {
      readonly kind: 'typed-error';
      /**
       * The canonical number. `NOT_FOUND` rides on the resource-missing
       * number; the other three ride on the mount-unavailable one. Both
       * are pinned as literals in the case JSON so a rename that moved
       * the wire fails here rather than passing against a constant.
       */
      readonly jsonRpcCode: number;
      readonly dataCode: ResourceReadErrorCodeDecl;
      /**
       * Assert `error.data` carries NO `detail` key. Normative for
       * `NOT_FOUND`, whose body must not vary; not authored elsewhere,
       * because `detail` is optional context a conformant server may or
       * may not attach.
       */
      readonly detailAbsent?: boolean;
    }
  | {
      /**
       * An error the resource-read classification does not reach:
       * `data` carries no resource-read code.
       *
       * The NUMBER is deliberately not pinned — not even negatively.
       * MCP assigns the resource-missing number to a `resources/read`
       * of a URI the server does not serve, so a framework that maps
       * every unrecognized URI onto it is correct, and banning that
       * number here would fail it forever. The classification is what
       * separates the two cases, and it is enough: a genuine miss
       * carries one, a malformed URI carries none.
       */
      readonly kind: 'outside-typed-set';
    }
  | {
      /** A result whose contents declare a delivery channel. */
      readonly kind: 'live-mount';
    }
  | {
      /**
       * A mount serving a HISTORY record (#483): still a real mount
       * (delivery channel required), graded additionally on its
       * props — every `propsInclude` entry must appear in the parsed
       * `propsJson` with the authored value.
       */
      readonly kind: 'pinned-mount';
      readonly propsInclude?: Readonly<Record<string, unknown>>;
    };

/** One read within a case. */
export interface ResourceReadProbe {
  /** Name, unique within the case. Referenced by `indistinguishable`. */
  readonly as: string;
  readonly locator: ResourceReadLocator;
  readonly expect: ResourceReadExpectation;
}

/**
 * One resource-read conformance case. Authored as JSON under
 * `./cases/`, consumed via {@link resourceReadCases}, graded by
 * {@link runResourceReadConformance}.
 *
 * The shape IS the public API — additive changes only.
 */
export interface ResourceReadConformanceCase {
  /** Unique case name. MUST match the JSON filename without `.json`. */
  readonly name: string;
  /** Which obligation this case proves. */
  readonly description: string;
  /** The deployment shape the driver brings up. */
  readonly server: ResourceReadServerShape;
  /** Whose read this is. */
  readonly caller: ResourceReadCaller;
  /** State installed before the reads. May be empty. */
  readonly seeds: readonly ResourceReadSeed[];
  /** The reads, dispatched in order against the one prepared server. */
  readonly reads: readonly ResourceReadProbe[];
  /**
   * Probe names whose RAW error frames MUST be byte-identical.
   *
   * This is the disclosure obligation stated positively: a read of a
   * locator the caller may not see and a read of one that never existed
   * must be the same bytes, or the read is an existence oracle for
   * other callers' renders. Compared on the serialized frames with only
   * the session segments normalized away — a locator is caller-supplied
   * and a server that echoes it back is caught by `disclosesNothing`,
   * not excused here.
   */
  readonly indistinguishable?: readonly string[];
  /**
   * Probe names whose MOUNT outcomes must carry byte-identical
   * `propsJson` (#483 — pinned-record immutability). Deliberately
   * compares ONLY the props: live-channel tokens and expiries on the
   * same meta legitimately differ per read; the RECORD is what may
   * not.
   */
  readonly identicalMounts?: readonly string[];
  /**
   * Literal substrings that MUST NOT appear anywhere in any error frame
   * this case produces. The values a refusal would leak if a diagnostic
   * escaped into `message` or `detail`.
   */
  readonly disclosesNothing?: readonly string[];
}

// =============================================================================
// Driver seam
// =============================================================================

/** What the driver is asked to bring up. */
export interface ResourceReadScenario {
  /** The case being prepared — for the driver's own diagnostics. */
  readonly caseName: string;
  readonly server: ResourceReadServerShape;
  readonly caller: ResourceReadCaller;
  readonly seeds: readonly ResourceReadSeed[];
}

/**
 * The delivery-channel fields of the render meta a successful read
 * projects onto its contents.
 *
 * Narrowed to what the invariant needs: the kit asks "can this be
 * mounted", not "what does it look like". A driver reports these off
 * whatever its shell carries — the projection is protocol surface, the
 * markup that transports it is not.
 */
export interface ResourceReadRenderMeta {
  /** A fetchable component URL — the fetched static delivery channel. */
  readonly codeUrl?: string;
  /** Base64 component source — the inline static delivery channel. */
  readonly codeB64?: string;
  /** The live channel's endpoint. Only a channel WITH a token. */
  readonly wsUrl?: string;
  /** The live channel's token. Only a channel WITH an endpoint. */
  readonly wsToken?: string;
  /** A server-emitted system card, which carries its own content. */
  readonly kind?: string;
  /**
   * The mount's props as a JSON string (#483). Graded by the
   * `pinned-mount` expectation and the `identicalMounts` group;
   * ungraded elsewhere.
   */
  readonly propsJson?: string;
}

/** The raw JSON-RPC error body a server put on the wire. */
export interface JsonRpcErrorFrame {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** What one read produced. */
export type ResourceReadOutcome =
  | { readonly kind: 'mount'; readonly renderMeta: ResourceReadRenderMeta }
  | { readonly kind: 'error'; readonly error: JsonRpcErrorFrame };

/** A server brought up in a declared shape, ready to be read. */
export interface PreparedResourceReadScenario {
  /**
   * Read one locator. MUST resolve — a protocol-level failure is
   * `{kind: 'error'}` carrying the RAW frame, not a throw. A throw is
   * graded as a FAIL, since the read is the thing under test.
   *
   * Honest-grade contract: the reported outcome MUST be what the server
   * really produced. A driver that fabricates a passing outcome is
   * cheating its own conformance audit — the implementer's integrity to
   * keep, exactly as with every other adapter the kit defines.
   */
  read(uri: string): Promise<ResourceReadOutcome>;
  /**
   * Keys the server computed for this case's `registered-blueprint`
   * seeds, by their `as` name. Required whenever a probe references
   * one; a case whose reference is unresolved SKIPS, because the kit
   * cannot construct the locator it was supposed to read.
   */
  readonly registeredKeys?: Readonly<Record<string, string>>;
  /** Tear the scenario down. Invoked after every case, pass or fail. */
  dispose?(): Promise<void>;
}

/**
 * Bring up a server in the declared shape. Throwing signals "I cannot
 * express this scenario" and the runner records a SKIP with the
 * message — never a pass.
 */
export type ResourceReadScenarioDriver = (
  scenario: ResourceReadScenario,
) => Promise<PreparedResourceReadScenario>;

// =============================================================================
// Catalog
// =============================================================================

/**
 * Every resource-read case the kit ships, in deterministic order: the
 * four typed classes, then the disclosure fusions, then the boundary of
 * the classification, then the three mount cases.
 */
export const resourceReadCases: readonly ResourceReadConformanceCase[] = [
  notFoundOnAMiss as ResourceReadConformanceCase,
  purgedBlueprint as ResourceReadConformanceCase,
  substrateLess as ResourceReadConformanceCase,
  noDeliveryChannel as ResourceReadConformanceCase,
  refusalIsAMiss as ResourceReadConformanceCase,
  substrateLessFusion as ResourceReadConformanceCase,
  halfWiredIdentityOnly as ResourceReadConformanceCase,
  halfWiredBlueprintsOnly as ResourceReadConformanceCase,
  allEphemeral as ResourceReadConformanceCase,
  registryFusion as ResourceReadConformanceCase,
  malformedLocator as ResourceReadConformanceCase,
  liveRowMount as ResourceReadConformanceCase,
  remintMount as ResourceReadConformanceCase,
  inlineMount as ResourceReadConformanceCase,
  pinnedImmutable as ResourceReadConformanceCase,
  pinPastHead as ResourceReadConformanceCase,
];

// =============================================================================
// Locator grammar + the mount predicate
// =============================================================================

/** The resource URI every render locator hangs off. */
export const GGUI_RENDER_RESOURCE_URI = 'ui://ggui/render';

/**
 * Build the URI a probe reads. The kit owns the grammar so no case
 * spells a well-formed locator out by hand; a `raw` locator passes
 * through verbatim, which is the point of that arm.
 */
export function renderLocatorUri(
  locator: ResourceReadLocator,
  registeredKeys: Readonly<Record<string, string>> = {},
): string {
  if (locator.kind === 'raw') return locator.uri;
  const pin = locator.epoch === undefined ? '' : `#${locator.epoch}`;
  const base = `${GGUI_RENDER_RESOURCE_URI}/${locator.session}`;
  const keyRef = locator.key;
  if (keyRef === undefined) return `${base}${pin}`;
  if (keyRef.kind === 'literal') return `${base}/${keyRef.value}${pin}`;
  const key = registeredKeys[keyRef.seed];
  if (key === undefined) {
    throw new Error(`no key was reported for registry seed '${keyRef.seed}'`);
  }
  return `${base}/${key}${pin}`;
}

/**
 * Does this render meta carry enough to paint something? One of the
 * four delivery channels a runtime knows: a fetchable static component
 * URL, inline base64 component source, a live channel, or a
 * server-emitted system card.
 *
 * The live channel needs BOTH halves — an endpoint with no token cannot
 * be opened, and a token with no endpoint has nowhere to go — so a
 * half-declared one is not a channel.
 */
export function declaresDeliveryChannel(meta: ResourceReadRenderMeta): boolean {
  if (typeof meta.codeUrl === 'string' && meta.codeUrl.length > 0) return true;
  if (typeof meta.codeB64 === 'string' && meta.codeB64.length > 0) return true;
  if (typeof meta.kind === 'string' && meta.kind.length > 0) return true;
  return (
    typeof meta.wsUrl === 'string' &&
    meta.wsUrl.length > 0 &&
    typeof meta.wsToken === 'string' &&
    meta.wsToken.length > 0
  );
}

// =============================================================================
// Result shape
// =============================================================================

/** One obligation a server under test did not meet. */
export interface ResourceReadConformanceFailure {
  /** The case that failed. */
  readonly name: string;
  /** The probe whose read produced it, when the failure is probe-scoped. */
  readonly probe?: string;
  /** Which obligation was violated, in the catalog's own words. */
  readonly obligation: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly message: string;
}

/** One case the kit could not grade, and why. */
export interface ResourceReadConformanceSkip {
  readonly name: string;
  readonly reason: string;
}

/** Outcome of grading a server against the catalog. */
export interface ResourceReadConformanceResult {
  /** Names of cases the server satisfied. */
  readonly passed: readonly string[];
  /** Cases the server got wrong — at most one entry per case. */
  readonly failed: readonly ResourceReadConformanceFailure[];
  /** Cases the kit could not observe. Never a pass, never a fail. */
  readonly skipped: readonly ResourceReadConformanceSkip[];
}

/** Options for {@link runResourceReadConformance}. */
export interface RunResourceReadConformanceOptions {
  /** Grade only these case names. Useful when debugging one obligation. */
  readonly only?: readonly string[];
}

// =============================================================================
// Runner
// =============================================================================

/**
 * Grade a server against the catalog.
 *
 * One scenario is prepared per case, every probe is read against it in
 * order, then the cross-probe obligations are checked. A case
 * contributes at most one failure — the first obligation it broke —
 * so the result reads as one verdict per case.
 *
 * A conformant server produces an empty `failed` array. An empty
 * `passed` array is NOT success: a run where every case skipped proves
 * nothing, and callers should treat it the way the WebSocket runner's
 * consumers already do.
 */
export async function runResourceReadConformance(
  drive: ResourceReadScenarioDriver,
  options: RunResourceReadConformanceOptions = {},
): Promise<ResourceReadConformanceResult> {
  const passed: string[] = [];
  const failed: ResourceReadConformanceFailure[] = [];
  const skipped: ResourceReadConformanceSkip[] = [];

  for (const raw of resourceReadCases) {
    const testCase = parseCase(raw);
    if (options.only !== undefined && !options.only.includes(testCase.name)) continue;

    let prepared: PreparedResourceReadScenario;
    try {
      prepared = await drive({
        caseName: testCase.name,
        server: testCase.server,
        caller: testCase.caller,
        seeds: testCase.seeds,
      });
    } catch (err) {
      skipped.push({
        name: testCase.name,
        reason: `driver refused to prepare the scenario: ${errorText(err)}`,
      });
      continue;
    }

    let verdict: CaseVerdict;
    try {
      verdict = await gradeCase(testCase, prepared);
    } finally {
      // A teardown that throws costs THIS case its cleanup and nothing
      // else. Unguarded, one flaky dispose propagates out of the loop
      // and takes the whole scorecard with it — every case after it
      // goes ungraded, and the run reports nothing rather than the
      // verdicts it had already earned. Cleanup is not a verdict, so it
      // cannot produce one either: the throw is dropped here, not
      // recorded as a failure of the server.
      if (prepared.dispose !== undefined) {
        await prepared.dispose().catch(() => undefined);
      }
    }
    if (verdict.kind === 'pass') passed.push(testCase.name);
    else if (verdict.kind === 'fail') failed.push(verdict.failure);
    else skipped.push({ name: testCase.name, reason: verdict.reason });
  }

  return { passed, failed, skipped };
}

type CaseVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'fail'; readonly failure: ResourceReadConformanceFailure }
  | { readonly kind: 'skip'; readonly reason: string };

async function gradeCase(
  testCase: ResourceReadConformanceCase,
  prepared: PreparedResourceReadScenario,
): Promise<CaseVerdict> {
  const registeredKeys = prepared.registeredKeys ?? {};
  const outcomes = new Map<string, ResourceReadOutcome>();

  for (const probe of testCase.reads) {
    let uri: string;
    try {
      uri = renderLocatorUri(probe.locator, registeredKeys);
    } catch (err) {
      return {
        kind: 'skip',
        reason: `probe '${probe.as}' reads a locator the driver did not resolve — ${errorText(err)}`,
      };
    }

    let outcome: ResourceReadOutcome;
    try {
      outcome = await prepared.read(uri);
    } catch (err) {
      return {
        kind: 'fail',
        failure: {
          name: testCase.name,
          probe: probe.as,
          obligation: 'a read resolves with an outcome; a protocol failure is a typed error frame, not a throw',
          expected: probe.expect,
          actual: `read('${uri}') threw: ${errorText(err)}`,
          message: `reading '${uri}' threw instead of resolving. A read that cannot succeed still answers — with one typed JSON-RPC error.`,
        },
      };
    }
    outcomes.set(probe.as, outcome);

    const probeFailure = gradeProbe(testCase, probe, uri, outcome);
    if (probeFailure !== null) return { kind: 'fail', failure: probeFailure };
  }

  const disclosure = gradeDisclosure(testCase, outcomes);
  if (disclosure !== null) return { kind: 'fail', failure: disclosure };

  const fusion = gradeIndistinguishable(testCase, outcomes);
  if (fusion !== null) return { kind: 'fail', failure: fusion };

  const pinned = gradeIdenticalMounts(testCase, outcomes);
  if (pinned !== null) return { kind: 'fail', failure: pinned };

  return { kind: 'pass' };
}

function gradeProbe(
  testCase: ResourceReadConformanceCase,
  probe: ResourceReadProbe,
  uri: string,
  outcome: ResourceReadOutcome,
): ResourceReadConformanceFailure | null {
  const fail = (
    obligation: string,
    expected: unknown,
    message: string,
  ): ResourceReadConformanceFailure => ({
    name: testCase.name,
    probe: probe.as,
    obligation,
    expected,
    actual: outcome,
    message,
  });

  if (probe.expect.kind === 'live-mount') {
    if (outcome.kind !== 'mount') {
      return fail(
        'a resolvable locator returns a result, not an error',
        'a result whose contents declare a delivery channel',
        `reading '${uri}' failed, but this locator resolves on this server — the read had mount material to hand back.`,
      );
    }
    if (!declaresDeliveryChannel(outcome.renderMeta)) {
      return fail(
        'any successful result IS a live mount',
        'render meta declaring a component URL, a live channel (endpoint AND token), or a system card',
        `reading '${uri}' succeeded with contents that declare no delivery channel — a shell that can never paint anything. A read with nothing to mount answers with a typed error instead.`,
      );
    }
    return null;
  }

  if (probe.expect.kind === 'pinned-mount') {
    if (outcome.kind !== 'mount') {
      return fail(
        'a pinned history record within the servable window mounts (SPEC §7.1.2.2)',
        'a result whose contents declare a delivery channel and carry the record props',
        `reading '${uri}' failed, but this pinned record resolves on this server.`,
      );
    }
    if (!declaresDeliveryChannel(outcome.renderMeta)) {
      return fail(
        'a pinned mount is still a mount',
        'render meta declaring a delivery channel',
        `reading '${uri}' succeeded with contents that declare no delivery channel.`,
      );
    }
    const include = probe.expect.propsInclude;
    if (include !== undefined) {
      const raw = outcome.renderMeta.propsJson;
      let parsed: Record<string, unknown> | null = null;
      if (typeof raw === 'string') {
        try {
          const candidate: unknown = JSON.parse(raw);
          if (isRecord(candidate)) parsed = candidate as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
      if (parsed === null) {
        return fail(
          'a pinned mount carries its record props (SPEC §7.1.2.2)',
          'parseable propsJson on the render meta',
          `reading '${uri}' mounted, but its render meta carries no parseable propsJson to grade the record against.`,
        );
      }
      for (const [key, expected] of Object.entries(include)) {
        if (JSON.stringify(parsed[key]) !== JSON.stringify(expected)) {
          return fail(
            'a pinned record serves the props of ITS epoch, never a neighbor\'s',
            `propsJson entry '${key}' = ${JSON.stringify(expected)}`,
            `reading '${uri}' served '${key}' = ${JSON.stringify(parsed[key])}.`,
          );
        }
      }
    }
    return null;
  }

  if (outcome.kind !== 'error') {
    return fail(
      'a read that cannot be mounted answers with a typed error, never a success-shaped result',
      probe.expect,
      `reading '${uri}' returned a result, but this locator cannot be mounted on this server.`,
    );
  }

  const dataCode = readDataCode(outcome.error.data);

  if (probe.expect.kind === 'outside-typed-set') {
    // The NUMBER is deliberately not graded here, and an earlier draft
    // of this arm got it wrong by banning the two canonical ones. MCP
    // itself assigns the resource-missing number to a `resources/read`
    // of a URI the server does not serve, so a framework that maps every
    // unrecognized URI onto it is behaving correctly and would fail such
    // a check forever. What survives is the classification: the four
    // codes classify reads that NAME a locator, and this URI names none.
    //
    // That still leaves the two distinguishable, which is the point —
    // a genuine miss carries the resource-read classification and the
    // constant message; a malformed URI carries no classification at
    // all, whatever number it rides on.
    if (dataCode !== undefined) {
      return fail(
        'the four resource-read codes classify reads of a locator; a URI that names none is not one',
        'an error carrying no resource-read classification on error.data.code',
        `reading '${uri}' — which names no render locator — was classified as '${dataCode}'. That classification is for reads of a locator; this is a malformed request, and giving it a locator verdict tells a host to stop retrying a request it should fix instead.`,
      );
    }
    return null;
  }

  if (outcome.error.code !== probe.expect.jsonRpcCode) {
    return fail(
      'each classification rides on its canonical JSON-RPC number',
      probe.expect.jsonRpcCode,
      `reading '${uri}' answered on ${outcome.error.code}; this class rides on ${probe.expect.jsonRpcCode}. A host routes on the number before it reads anything else — a deterministic outcome reported as a malfunction invites a retry that cannot succeed.`,
    );
  }
  if (dataCode !== probe.expect.dataCode) {
    return fail(
      'the fine-grained class rides on error.data.code',
      probe.expect.dataCode,
      `reading '${uri}' carried data.code ${dataCode === undefined ? '(absent)' : `'${dataCode}'`}; the catalog expects '${probe.expect.dataCode}'.`,
    );
  }
  if (typeof outcome.error.message !== 'string') {
    // Presence-and-type only, and NOT a ggui obligation: JSON-RPC 2.0
    // requires an error object to carry a string `message`. An earlier
    // draft required it to be non-empty, which is a rule no ruling
    // establishes — a server whose constant message is the empty string
    // is conformant, however unhelpful. Kept because the fusion
    // comparison serializes this field, so a frame missing it entirely
    // is malformed at the transport level before this catalog has an
    // opinion.
    return fail(
      "JSON-RPC requires an error object to carry a string 'message'",
      'a string message field',
      `reading '${uri}' answered with an error carrying no string message.`,
    );
  }
  if (probe.expect.detailAbsent === true && dataHasDetail(outcome.error.data)) {
    return fail(
      'a NOT_FOUND body is constant — it carries no detail',
      'error.data with no `detail` key',
      `reading '${uri}' attached a 'detail' to a NOT_FOUND. Whatever varies between a refused read and a read of a locator that never existed is an existence oracle for other callers' renders, and a diagnostic is exactly what varies.`,
    );
  }
  return null;
}

function gradeDisclosure(
  testCase: ResourceReadConformanceCase,
  outcomes: ReadonlyMap<string, ResourceReadOutcome>,
): ResourceReadConformanceFailure | null {
  const secrets = testCase.disclosesNothing ?? [];
  if (secrets.length === 0) return null;
  for (const [probeName, outcome] of outcomes) {
    if (outcome.kind !== 'error') continue;
    const serialized = JSON.stringify(outcome.error);
    for (const secret of secrets) {
      if (serialized.includes(secret)) {
        return {
          name: testCase.name,
          probe: probeName,
          obligation: 'an error frame names nothing about the render it refused',
          expected: `no occurrence of ${JSON.stringify(secret)}`,
          actual: serialized,
          message: `the error frame for probe '${probeName}' contains ${JSON.stringify(secret)}. A caller with no claim to this render learned it exists.`,
        };
      }
    }
  }
  return null;
}

function gradeIdenticalMounts(
  testCase: ResourceReadConformanceCase,
  outcomes: ReadonlyMap<string, ResourceReadOutcome>,
): ResourceReadConformanceFailure | null {
  const group = testCase.identicalMounts ?? [];
  if (group.length < 2) return null;
  let reference: { readonly probe: string; readonly propsJson: string } | null = null;
  for (const probeName of group) {
    const outcome = outcomes.get(probeName);
    if (outcome === undefined || outcome.kind !== 'mount' || outcome.renderMeta.propsJson === undefined) {
      return {
        name: testCase.name,
        probe: probeName,
        obligation: 'a pinned history record serves identical props on every read (SPEC §7.1.2.2)',
        expected: 'a mount outcome carrying propsJson to compare',
        actual: outcome ?? '(no outcome recorded)',
        message: `probe '${probeName}' is named in this case's identicalMounts group but did not produce a props-carrying mount, so immutability cannot even be compared.`,
      };
    }
    if (reference === null) {
      reference = { probe: probeName, propsJson: outcome.renderMeta.propsJson };
      continue;
    }
    if (outcome.renderMeta.propsJson !== reference.propsJson) {
      return {
        name: testCase.name,
        probe: probeName,
        obligation: 'a pinned history record serves identical props on every read (SPEC §7.1.2.2)',
        expected: reference.propsJson,
        actual: outcome.renderMeta.propsJson,
        message: `probes '${reference.probe}' and '${probeName}' read the same pinned record and got different props — the record mutated between reads.`,
      };
    }
  }
  return null;
}

function gradeIndistinguishable(
  testCase: ResourceReadConformanceCase,
  outcomes: ReadonlyMap<string, ResourceReadOutcome>,
): ResourceReadConformanceFailure | null {
  const group = testCase.indistinguishable ?? [];
  if (group.length < 2) return null;

  // Session segments are caller-supplied and differ BY CONSTRUCTION
  // between the probes being compared, so they are normalized out
  // before the byte comparison. A server that echoes one back is not
  // excused by this — `disclosesNothing` catches that, and it runs
  // first.
  const sessions = testCase.reads
    .flatMap((probe) => (probe.locator.kind === 'render' ? [probe.locator.session] : []))
    .sort((a, b) => b.length - a.length);

  let reference: { readonly probe: string; readonly frame: string } | null = null;
  for (const probeName of group) {
    const outcome = outcomes.get(probeName);
    if (outcome === undefined || outcome.kind !== 'error') {
      return {
        name: testCase.name,
        probe: probeName,
        obligation: 'a refused read and a read of a locator that never existed are the same bytes',
        expected: 'an error frame to compare',
        actual: outcome ?? '(no outcome recorded)',
        message: `probe '${probeName}' is named in this case's indistinguishability group but did not produce an error frame, so the two reads are already distinguishable — one failed and one did not.`,
      };
    }
    const normalized = normalizeSessions(JSON.stringify(outcome.error), sessions);
    if (reference === null) {
      reference = { probe: probeName, frame: normalized };
      continue;
    }
    if (normalized !== reference.frame) {
      return {
        name: testCase.name,
        probe: probeName,
        obligation: 'a refused read and a read of a locator that never existed are the same bytes',
        expected: reference.frame,
        actual: normalized,
        message: `probes '${reference.probe}' and '${probeName}' produced different error frames. One read a locator that resolves for somebody else and one read a locator that never existed; any difference between them answers "does this render exist?" for a caller with no claim to it.`,
      };
    }
  }
  return null;
}

function normalizeSessions(frame: string, sessions: readonly string[]): string {
  let out = frame;
  for (const session of sessions) {
    out = out.split(session).join('<session>');
  }
  return out;
}

/** The two numbers the resource-read classification rides on. */
const CANONICAL_NUMBERS = {
  NOT_FOUND: -32002,
  MOUNT_UNAVAILABLE: -32006,
} as const;

function readDataCode(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const code = data['code'];
  return typeof code === 'string' ? code : undefined;
}

function dataHasDetail(data: unknown): boolean {
  return isRecord(data) && 'detail' in data;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// =============================================================================
// Case-authoring trust boundary
// =============================================================================

const SEED_KINDS = [
  'identity-record',
  'durable-blueprint',
  'committed-render',
  'uncommitted-render',
  'registered-blueprint',
] as const;

const DATA_CODES: readonly string[] = [
  'NOT_FOUND',
  'BLUEPRINT_UNRESOLVABLE',
  'NOT_SUPPORTED',
  'NOT_MOUNTABLE',
];

const SUBSTRATE_WIRINGS: readonly string[] = [
  'all',
  'none',
  'identity-only',
  'blueprints-only',
  'all-ephemeral',
];

const EXPECTATION_KINDS: readonly string[] = [
  'typed-error',
  'outside-typed-set',
  'live-mount',
];

/**
 * Validating parse of one authored case.
 *
 * The input is `unknown` BY DESIGN — this function IS the trust
 * boundary, so it never leans on the static union it produces evidence
 * for. The catalog's JSON enters the type system through a compile-time
 * cast (tsc widens JSON-module string literals), which means the static
 * type is the claim being checked here, not support for it. Same
 * posture as the WebSocket runner's `parseSetupStep`.
 *
 * An unknown seed kind, locator kind, expectation kind or
 * classification is a CASE-AUTHORING error: the runner throws, aborting
 * the run loudly. It is never a skip and never a fail — those verdicts
 * describe the server under test, not the catalog.
 *
 * Exported for the kit's own meta-tests and reachable from the
 * `./resource-read-conformance` subpath, but NOT re-exported from the
 * package root — the runner calls it for you, and a consumer needing it
 * directly is authoring their own catalog rather than grading against
 * this one.
 */
export function parseCase(input: unknown): ResourceReadConformanceCase {
  if (!isRecord(input) || typeof input['name'] !== 'string' || input['name'].length === 0) {
    throw new Error(
      `protocol-conformance: a resource-read case is malformed — expected an object with a non-empty string 'name'. Received: ${JSON.stringify(input)}`,
    );
  }
  const name = input['name'];
  const bad = (problem: string): Error =>
    new Error(`protocol-conformance: resource-read case '${name}' is malformed — ${problem}.`);

  rejectUnknownKeys(bad, input, CASE_KEYS, 'the case');
  if (typeof input['description'] !== 'string' || input['description'].length === 0) {
    throw bad("'description' must be a non-empty string — it is what a failure report names");
  }
  const server = input['server'];
  if (!isRecord(server)) throw bad("'server' must be an object declaring the deployment shape");
  rejectUnknownKeys(bad, server, SERVER_KEYS, "'server'");
  for (const flag of ['blueprintRegistry', 'staticDelivery', 'liveChannel']) {
    if (server[flag] !== undefined && typeof server[flag] !== 'boolean') {
      throw bad(`'server.${flag}' must be a boolean when present`);
    }
  }
  const caller = input['caller'];
  if (caller !== 'owner' && caller !== 'other') {
    throw bad(`'caller' must be 'owner' or 'other'. Received: ${JSON.stringify(caller)}`);
  }
  const rawSeeds = input['seeds'];
  if (!Array.isArray(rawSeeds)) throw bad("'seeds' must be an array (possibly empty)");
  const seeds = rawSeeds.map((seed) => parseSeed(bad, seed));

  const rawReads = input['reads'];
  if (!Array.isArray(rawReads) || rawReads.length === 0) {
    throw bad("'reads' must be a non-empty array — a case that reads nothing grades nothing");
  }
  const probeNames = new Set<string>();
  const reads = rawReads.map((probe) => {
    const parsed = parseProbe(bad, probe);
    if (probeNames.has(parsed.as)) throw bad(`two probes named '${parsed.as}'`);
    probeNames.add(parsed.as);
    return parsed;
  });

  const mountGroup = input['identicalMounts'];
  if (mountGroup !== undefined) {
    if (!Array.isArray(mountGroup)) throw bad("'identicalMounts' must be an array of probe names");
    if (mountGroup.length < 2) {
      throw bad(
        "'identicalMounts' names a single probe — a group of one asserts nothing, which reads as an obligation being graded when it is not",
      );
    }
  }
  const group = input['indistinguishable'];
  if (group !== undefined) {
    if (!Array.isArray(group)) throw bad("'indistinguishable' must be an array of probe names");
    if (group.length === 1) {
      throw bad(
        "'indistinguishable' names a single probe — a group of one asserts nothing, which reads as an obligation being graded when it is not",
      );
    }
    for (const ref of group) {
      if (typeof ref !== 'string' || !probeNames.has(ref)) {
        throw bad(`the indistinguishability group names unknown probe '${String(ref)}'`);
      }
    }
  }
  const secrets = input['disclosesNothing'];
  if (
    secrets !== undefined &&
    (!Array.isArray(secrets) || secrets.some((s) => typeof s !== 'string' || s.length === 0))
  ) {
    throw bad("'disclosesNothing' must be an array of non-empty strings");
  }

  // Constructed rather than asserted: every field below came through a
  // check above, so the returned value carries evidence for its type
  // instead of a claim about it.
  return {
    name,
    description: input['description'],
    server: {
      durableSubstrate: parseSubstrate(bad, server['durableSubstrate']),
      ...(server['blueprintRegistry'] === true ? { blueprintRegistry: true } : {}),
      ...(server['staticDelivery'] === true ? { staticDelivery: true } : {}),
      ...(server['liveChannel'] === true ? { liveChannel: true } : {}),
    },
    caller,
    seeds,
    reads,
    ...(group !== undefined ? { indistinguishable: group.map(String) } : {}),
    ...(mountGroup !== undefined ? { identicalMounts: mountGroup.map(String) } : {}),
    ...(secrets !== undefined ? { disclosesNothing: secrets.map(String) } : {}),
  };
}

type BadFn = (problem: string) => Error;

/**
 * Reject any key outside the authored vocabulary.
 *
 * A typo is otherwise SILENT and expensive: `"liveChanel": true` leaves
 * the flag undefined, so the case brings up a server with no live
 * channel and grades that instead — passing, while asserting something
 * other than what it reads as asserting. Every closed shape in this
 * module is checked, because each one is a scenario the catalog claims
 * to have graded.
 */
function rejectUnknownKeys(
  bad: BadFn,
  value: Readonly<Record<string, unknown>>,
  known: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw bad(
        `${what} carries unknown key '${key}' — the vocabulary is closed: ${known.join(', ')}`,
      );
    }
  }
}

const CASE_KEYS: readonly string[] = [
  'name',
  'description',
  'server',
  'caller',
  'seeds',
  'reads',
  'indistinguishable',
  'identicalMounts',
  'disclosesNothing',
];

const SERVER_KEYS: readonly string[] = [
  'durableSubstrate',
  'blueprintRegistry',
  'staticDelivery',
  'liveChannel',
];

const PROBE_KEYS: readonly string[] = ['as', 'locator', 'expect'];

const SEED_KEYS: Readonly<Record<string, readonly string[]>> = {
  'identity-record': ['kind', 'session', 'key', 'blueprint'],
  'durable-blueprint': ['kind', 'componentRef', 'body'],
  'committed-render': ['kind', 'session', 'size'],
  'epoch-history': ['kind', 'session', 'records'],
  'uncommitted-render': ['kind', 'session'],
  'registered-blueprint': ['kind', 'as'],
};

const LOCATOR_KEYS: Readonly<Record<string, readonly string[]>> = {
  render: ['kind', 'session', 'key', 'epoch'],
  raw: ['kind', 'uri'],
};

const KEY_KEYS: Readonly<Record<string, readonly string[]>> = {
  literal: ['kind', 'value'],
  registered: ['kind', 'seed'],
};

const EXPECTATION_KEYS: Readonly<Record<string, readonly string[]>> = {
  'typed-error': ['kind', 'jsonRpcCode', 'dataCode', 'detailAbsent'],
  'outside-typed-set': ['kind'],
  'live-mount': ['kind'],
  'pinned-mount': ['kind', 'propsInclude'],
};

function parseSubstrate(bad: BadFn, value: unknown): DurableSubstrateWiring {
  switch (value) {
    case 'all':
    case 'none':
    case 'identity-only':
    case 'blueprints-only':
    case 'all-ephemeral':
      return value;
    default:
      throw bad(
        `'server.durableSubstrate' must be one of: ${SUBSTRATE_WIRINGS.join(', ')}. Received: ${JSON.stringify(value)}`,
      );
  }
}

function requireText(bad: BadFn, value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw bad(`${what} must be a non-empty string`);
  }
  return value;
}

function parseSeed(bad: BadFn, seed: unknown): ResourceReadSeed {
  if (!isRecord(seed)) throw bad(`a seed must be an object. Received: ${JSON.stringify(seed)}`);
  const seedKeys = SEED_KEYS[String(seed['kind'])];
  if (seedKeys !== undefined) rejectUnknownKeys(bad, seed, seedKeys, `a '${String(seed['kind'])}' seed`);
  switch (seed['kind']) {
    case 'identity-record': {
      const blueprint = seed['blueprint'];
      if (blueprint !== 'named' && blueprint !== 'unnamed') {
        throw bad("an identity-record seed's 'blueprint' must be 'named' or 'unnamed'");
      }
      return {
        kind: 'identity-record',
        session: requireText(bad, seed['session'], "an identity-record seed's 'session'"),
        key: requireText(bad, seed['key'], "an identity-record seed's 'key'"),
        blueprint,
      };
    }
    case 'durable-blueprint': {
      const componentRef = seed['componentRef'];
      const body = seed['body'];
      if (componentRef !== 'present' && componentRef !== 'absent') {
        throw bad("a durable-blueprint seed's 'componentRef' must be 'present' or 'absent'");
      }
      if (body !== 'stored' && body !== 'purged') {
        throw bad("a durable-blueprint seed's 'body' must be 'stored' or 'purged'");
      }
      return { kind: 'durable-blueprint', componentRef, body };
    }
    case 'committed-render': {
      const size = seed['size'] ?? 'under-inline-cap';
      if (size !== 'under-inline-cap' && size !== 'over-inline-cap') {
        throw bad(
          "a committed-render seed's 'size' must be 'under-inline-cap' or 'over-inline-cap' (or omitted for the default)",
        );
      }
      return {
        kind: 'committed-render',
        session: requireText(bad, seed['session'], "a committed-render seed's 'session'"),
        size,
      };
    }
    case 'uncommitted-render':
      return {
        kind: 'uncommitted-render',
        session: requireText(bad, seed['session'], "an uncommitted-render seed's 'session'"),
      };
    case 'epoch-history': {
      const session = requireText(bad, seed['session'], "epoch-history seed 'session'");
      const rawRecords = seed['records'];
      if (!Array.isArray(rawRecords) || rawRecords.length < 2) {
        throw bad(
          "epoch-history seed 'records' must be an array of at least TWO entries — one mint plus one update; a single-record history has nothing superseded to pin",
        );
      }
      const records = rawRecords.map((entry, i) => {
        if (!isRecord(entry) || !isRecord(entry['props'])) {
          throw bad(`epoch-history seed record ${i} authors no 'props' object`);
        }
        rejectUnknownKeys(bad, entry, ['props'], `epoch-history seed record ${i}`);
        return { props: entry['props'] as Record<string, unknown> };
      });
      return { kind: 'epoch-history', session, records };
    }
    case 'registered-blueprint':
      return {
        kind: 'registered-blueprint',
        as: requireText(bad, seed['as'], "a registered-blueprint seed's 'as'"),
      };
    default:
      throw bad(
        `unknown seed kind '${String(seed['kind'])}'. The seed vocabulary is closed: ${SEED_KINDS.join(', ')}`,
      );
  }
}

function parseProbe(bad: BadFn, probe: unknown): ResourceReadProbe {
  if (!isRecord(probe)) throw bad(`a probe must be an object. Received: ${JSON.stringify(probe)}`);
  const as = requireText(bad, probe['as'], "a probe's 'as' name");
  rejectUnknownKeys(bad, probe, PROBE_KEYS, `probe '${as}'`);
  return {
    as,
    locator: parseLocator(bad, as, probe['locator']),
    expect: parseExpectation(bad, as, probe['expect']),
  };
}

function parseLocator(bad: BadFn, as: string, locator: unknown): ResourceReadLocator {
  if (!isRecord(locator)) throw bad(`probe '${as}' authors no locator`);
  const locatorKeys = LOCATOR_KEYS[String(locator['kind'])];
  if (locatorKeys !== undefined) {
    rejectUnknownKeys(bad, locator, locatorKeys, `probe '${as}' locator`);
  }
  switch (locator['kind']) {
    case 'render': {
      const session = requireText(bad, locator['session'], `probe '${as}' locator 'session'`);
      const rawEpoch = locator['epoch'];
      let epoch: number | undefined;
      if (rawEpoch !== undefined) {
        if (typeof rawEpoch !== 'number' || !Number.isInteger(rawEpoch) || rawEpoch < 0) {
          throw bad(`probe '${as}' locator 'epoch' must be a non-negative integer`);
        }
        epoch = rawEpoch;
      }
      const key = locator['key'];
      const base = { kind: 'render' as const, session, ...(epoch !== undefined ? { epoch } : {}) };
      if (key === undefined) return base;
      return { ...base, key: parseKey(bad, as, key) };
    }
    case 'raw':
      return { kind: 'raw', uri: requireText(bad, locator['uri'], `probe '${as}' locator 'uri'`) };
    default:
      throw bad(
        `probe '${as}' authors unknown locator kind '${String(locator['kind'])}'. The vocabulary is closed: render, raw`,
      );
  }
}

function parseKey(bad: BadFn, as: string, key: unknown): ResourceReadKey {
  if (!isRecord(key)) throw bad(`probe '${as}' authors a malformed blueprint key`);
  const keyKeys = KEY_KEYS[String(key['kind'])];
  if (keyKeys !== undefined) rejectUnknownKeys(bad, key, keyKeys, `probe '${as}' blueprint key`);
  switch (key['kind']) {
    case 'literal':
      return { kind: 'literal', value: requireText(bad, key['value'], `probe '${as}' key value`) };
    case 'registered':
      return {
        kind: 'registered',
        seed: requireText(bad, key['seed'], `probe '${as}' registered-key seed name`),
      };
    default:
      throw bad(
        `probe '${as}' authors unknown key kind '${String(key['kind'])}'. The vocabulary is closed: literal, registered`,
      );
  }
}

function parseExpectation(bad: BadFn, as: string, expect: unknown): ResourceReadExpectation {
  if (!isRecord(expect)) throw bad(`probe '${as}' authors no expectation`);
  const expectKeys = EXPECTATION_KEYS[String(expect['kind'])];
  if (expectKeys !== undefined) {
    rejectUnknownKeys(bad, expect, expectKeys, `probe '${as}' expectation`);
  }
  switch (expect['kind']) {
    case 'outside-typed-set':
      return { kind: 'outside-typed-set' };
    case 'pinned-mount': {
      const rawInclude = expect['propsInclude'];
      if (rawInclude !== undefined && !isRecord(rawInclude)) {
        throw bad(`probe '${as}' 'propsInclude' must be an object of expected prop entries`);
      }
      return {
        kind: 'pinned-mount',
        ...(rawInclude !== undefined
          ? { propsInclude: rawInclude as Record<string, unknown> }
          : {}),
      };
    }
    case 'live-mount':
      return { kind: 'live-mount' };
    case 'typed-error': {
      const dataCode = parseDataCode(bad, as, expect['dataCode']);
      const canonical =
        dataCode === 'NOT_FOUND'
          ? CANONICAL_NUMBERS.NOT_FOUND
          : CANONICAL_NUMBERS.MOUNT_UNAVAILABLE;
      if (expect['jsonRpcCode'] !== canonical) {
        throw bad(
          `probe '${as}' pins ${String(expect['jsonRpcCode'])} for '${dataCode}', which rides on ${canonical}`,
        );
      }
      const detailAbsent = expect['detailAbsent'];
      if (detailAbsent !== undefined && typeof detailAbsent !== 'boolean') {
        throw bad(`probe '${as}' authors a non-boolean 'detailAbsent'`);
      }
      return {
        kind: 'typed-error',
        jsonRpcCode: canonical,
        dataCode,
        ...(detailAbsent === true ? { detailAbsent: true } : {}),
      };
    }
    default:
      throw bad(
        `probe '${as}' authors unknown expectation kind '${String(expect['kind'])}'. The vocabulary is closed: ${EXPECTATION_KINDS.join(', ')}`,
      );
  }
}

function parseDataCode(bad: BadFn, as: string, value: unknown): ResourceReadErrorCodeDecl {
  switch (value) {
    case 'NOT_FOUND':
    case 'BLUEPRINT_UNRESOLVABLE':
    case 'NOT_SUPPORTED':
    case 'NOT_MOUNTABLE':
      return value;
    default:
      throw bad(
        `probe '${as}' authors unknown classification '${String(value)}'. The vocabulary is closed: ${DATA_CODES.join(', ')}`,
      );
  }
}
