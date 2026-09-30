/**
 * `fits(candidate, request)` — the three code checks a cached interface
 * passes before the semantic judge ranks it: **data-shape**, **surface**,
 * **direction**. They are typed comparisons that cost nothing, so they run
 * as a pre-filter on the judge's top-K; the LLM only ever ranks candidates
 * that fit. Each check runs only when BOTH sides declare its fact — an
 * undeclared side reads `not-evaluated`, never a miss — and the first miss
 * wins, in that order. Three states are kept apart on purpose (`hit`,
 * `miss`, `not-evaluated`) so a declined-by-miss count is never diluted by
 * sides that declared nothing.
 *
 * The candidate's facts are denormalized onto its cache row at registration
 * (the canvas classes it was judged on, the aesthetic preset and version it
 * was generated under, the digest of its direction text); the request's
 * facts are what the deployment declares for the request. Pure: no I/O.
 */
import { createHash } from 'node:crypto';
import type { DataContract, JsonValue } from '@ggui-ai/protocol';

export type FitKind = 'data-shape' | 'surface' | 'direction';
/**
 * Which direction a candidate's `directionDigest` hashes: `app` — the
 * direction the app's profile carries; `request` — a direction given with
 * the request itself. A card built for a request-given direction never
 * matches an app-level request by construction; the scope rides the verdict
 * so a direction miss can be read by its cause.
 */
export type DirectionScope = 'app' | 'request';
export type FitCheck = 'hit' | 'miss' | 'not-evaluated';

/** An aesthetic preset reference: the id, and the version when one is named. */
export interface AestheticPresetRef {
  readonly id: string;
  readonly version?: string | null;
}

/** The request's declared fit facts, beside its draft contract. */
export interface RequestFitFacts {
  /** The canvas class the request will mount on, when the host declares one. */
  readonly canvas?: string;
  readonly aestheticPreset?: AestheticPresetRef;
  readonly directionDigest?: string;
}

export interface FitRequest extends RequestFitFacts {
  /** The request's draft contract. Absent = data-shape not evaluated. */
  readonly contract?: DataContract;
}

export interface FitCandidate {
  readonly contract?: DataContract;
  /** The canvas classes the cached interface was judged on. */
  readonly judgedCanvases?: readonly string[];
  readonly aestheticPreset?: AestheticPresetRef;
  readonly directionDigest?: string;
  readonly directionScope?: DirectionScope;
}

export interface FitVerdict {
  readonly fits: boolean;
  /** The first miss in check order; absent when the candidate fits. */
  readonly miss?: FitKind;
  readonly checks: Readonly<Record<FitKind, FitCheck>>;
  /** The candidate's declared direction scope, present whenever the direction check ran. */
  readonly directionScope?: DirectionScope;
}

/** A candidate the pre-filter dropped, named with its first miss. */
export interface FitDeclined {
  readonly id: string;
  readonly miss: FitKind;
  /** On a direction miss, the candidate's declared scope when it had one. */
  readonly directionScope?: DirectionScope;
}

const FIT_ORDER: readonly FitKind[] = ['data-shape', 'surface', 'direction'];

/** sha256 of the direction text trimmed, whitespace-collapsed and lowercased — a stray edit to spacing or case never flips a card. */
export function directionDigest(text: string): string {
  return createHash('sha256').update(text.trim().replace(/\s+/g, ' ').toLowerCase(), 'utf8').digest('hex');
}

const typeNames = (t: JsonValue | undefined): readonly string[] | undefined => {
  if (t === undefined) return undefined;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return undefined;
};

/**
 * JSON-Schema type compatibility, not string equality: `integer` satisfies a
 * `number` spec, type arrays are compatible when they intersect, and an
 * absent type on either side is compatible.
 */
export function jsonSchemaTypesCompatible(candidateType: JsonValue | undefined, requestType: JsonValue | undefined): boolean {
  const accepted = typeNames(candidateType);
  const asked = typeNames(requestType);
  if (accepted === undefined || asked === undefined || accepted.length === 0 || asked.length === 0) return true;
  return asked.some((r) => accepted.some((c) => c === r || (r === 'integer' && c === 'number')));
}

/**
 * Two arms, one per side's `required`, each with a compatible type: a prop
 * the CANDIDATE requires must be declared by the request with a type the
 * candidate accepts (the cached interface cannot render without it); a prop
 * the REQUEST requires must be declared by the candidate, again with a type
 * the candidate accepts (a required prop is always sent, and a render carrying
 * a key the served contract does not declare, or a value its type refuses, is
 * refused every time, so such a candidate cannot serve the request). An
 * optional request prop the candidate lacks, or declares with another type,
 * stays a coverage matter, reported on the hit, never a miss here: it is
 * refused only when it is sent.
 */
function checkDataShape(candidate: DataContract | undefined, request: DataContract | undefined): FitCheck {
  if (candidate === undefined || request === undefined) return 'not-evaluated';
  const offered = candidate.propsSpec?.properties ?? {};
  const declared = request.propsSpec?.properties ?? {};
  for (const [name, entry] of Object.entries(offered)) {
    if (entry.required !== true) continue;
    const asked = declared[name];
    if (asked === undefined) return 'miss';
    if (!jsonSchemaTypesCompatible(entry.schema.type, asked.schema.type)) return 'miss';
  }
  for (const [name, entry] of Object.entries(declared)) {
    if (entry.required !== true) continue;
    const served = offered[name];
    if (served === undefined) return 'miss';
    if (!jsonSchemaTypesCompatible(served.schema.type, entry.schema.type)) return 'miss';
  }
  return 'hit';
}

function checkSurface(candidate: FitCandidate, request: FitRequest): FitCheck {
  if (candidate.judgedCanvases === undefined || request.canvas === undefined) return 'not-evaluated';
  return candidate.judgedCanvases.includes(request.canvas) ? 'hit' : 'miss';
}

function checkDirection(candidate: FitCandidate, request: FitRequest): FitCheck {
  const outcomes: boolean[] = [];
  if (candidate.aestheticPreset !== undefined && request.aestheticPreset !== undefined) {
    const sameId = candidate.aestheticPreset.id === request.aestheticPreset.id;
    // A request preset without a version compares by id alone; one that
    // names a version compares both (a candidate that recorded none misses).
    const asked = request.aestheticPreset.version;
    const sameVersion = asked === undefined || asked === null ? true : candidate.aestheticPreset.version === asked;
    outcomes.push(sameId && sameVersion);
  }
  if (candidate.directionDigest !== undefined && request.directionDigest !== undefined) {
    outcomes.push(candidate.directionDigest === request.directionDigest);
  }
  if (outcomes.length === 0) return 'not-evaluated';
  return outcomes.every(Boolean) ? 'hit' : 'miss';
}

export function fits(candidate: FitCandidate, request: FitRequest): FitVerdict {
  const checks: Readonly<Record<FitKind, FitCheck>> = {
    'data-shape': checkDataShape(candidate.contract, request.contract),
    surface: checkSurface(candidate, request),
    direction: checkDirection(candidate, request),
  };
  const miss = FIT_ORDER.find((k) => checks[k] === 'miss');
  const scope =
    checks.direction !== 'not-evaluated' && candidate.directionScope !== undefined
      ? { directionScope: candidate.directionScope }
      : {};
  return miss === undefined ? { fits: true, checks, ...scope } : { fits: false, miss, checks, ...scope };
}
