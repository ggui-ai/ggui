/**
 * N−1 wire compatibility — the §3.6 drift gate (ggui#1014).
 *
 * Every BACKWARD case is the PREVIOUS release's payload for a protocol-owned
 * wire, tagged with that release's sha, and passes iff today's parser accepts
 * it. Every FORWARD case is a LATER release's payload, synthetic by
 * construction, and passes iff today's READ side keeps it: a top-level
 * member today does not name is stripped and named, overlays intact
 * (ggui#1093 belt), and a view proof of a later version, or over a root
 * claim today does not name, is recognised rather than refused as
 * malformed (ggui#1415). A case that starts failing is a receiver
 * that broke N−1 across a rolling release — the fix is the receiver, never
 * the fixture; a fixture changes only when the pairing of record moves
 * (`docs/protocol/VERSION-POLICY.md` §3.6).
 *
 * Pure-function catalog: no transport, no adopter input — graded on every
 * `runConformance()` and by the kit's own unit lane.
 */
import { appGenerationProfileSchema, appThemeGetResponseSchema, appThemeSchema, handshakeSuggestionSchema, opsGenerateBlueprintInputSchema, opsListBlueprintsOutputSchema, parseAppThemeAtReadDoor, renderOutputSchema } from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  parseMcpAppAiGguiRenderMeta,
  parseViewProof,
  VIEW_PROOF_RELAY_SHAPE,
  VIEW_PROOF_V1_MAX_CHARS,
} from '@ggui-ai/protocol/integrations/mcp-apps';

import release2AppThemeV2 from './cases/release-2-app-theme-v2.json' with { type: 'json' };
import release2RenderMeta from './cases/release-2-render-meta.json' with { type: 'json' };
import release2GenerationProfile from './cases/release-2-generation-profile.json' with { type: 'json' };
import release2OpsGenerateBlueprint from './cases/release-2-ops-generate-blueprint.json' with { type: 'json' };
import release91HandshakeSuggestion from './cases/release-9-1-handshake-suggestion.json' with { type: 'json' };
import release13RenderResult from './cases/release-13-render-result.json' with { type: 'json' };
import release14OpsListBlueprints from './cases/release-14-ops-list-blueprints.json' with { type: 'json' };
import forwardAppThemeUnknownMember from './cases/forward-app-theme-unknown-member.json' with { type: 'json' };
import forwardAppThemeCarryUnknownMember from './cases/forward-app-theme-carry-unknown-member.json' with { type: 'json' };
import forwardAppThemeCarryUninterpretable from './cases/forward-app-theme-carry-uninterpretable.json' with { type: 'json' };
import forwardRenderMetaUnknownMember from './cases/forward-render-meta-unknown-member.json' with { type: 'json' };
import forwardOpsListBlueprintsStamped from './cases/forward-ops-list-blueprints-stamped.json' with { type: 'json' };
import forwardOpsListBlueprintsCloned from './cases/forward-ops-list-blueprints-cloned.json' with { type: 'json' };
import forwardViewProofLaterVersion from './cases/forward-view-proof-later-version.json' with { type: 'json' };
import forwardViewProofRootLaterClaim from './cases/forward-view-proof-root-later-claim.json' with { type: 'json' };

/** The protocol-owned wires the catalog can grade. */
export const N1_COMPAT_WIRES = ['app-theme', 'app-theme-read', 'app-theme-carry', 'render-meta', 'generation-profile', 'ops-generate-blueprint', 'handshake-suggestion', 'render-result', 'ops-list-blueprints', 'view-proof'] as const;

/** `backward`: the previous release's payload against today's parser. `forward`: a later release's payload against today's READ door. */
export const N1_COMPAT_DIRECTIONS = ['backward', 'forward'] as const;
export type N1CompatDirection = (typeof N1_COMPAT_DIRECTIONS)[number];
export type N1CompatWire = (typeof N1_COMPAT_WIRES)[number];

export interface N1CompatRelease {
  /** Human label of the release that emitted the payload (e.g. "ggui Release 2"). */
  readonly label: string;
  /** The release's sha — the receipt that the payload is that release's, not a guess. A FORWARD case has no landed release and carries the literal `synthetic`. */
  readonly sha: string;
  /** The pairing of record on the other side, when the wire crosses fleets. */
  readonly pairedWith?: string;
}

export interface N1CompatCase {
  readonly name: string;
  readonly description: string;
  readonly release: N1CompatRelease;
  /** Absent in a case file ⇒ `backward`. */
  readonly direction: N1CompatDirection;
  readonly wire: N1CompatWire;
  /** The other release's payload, verbatim (previous for `backward`, later for `forward`). */
  readonly payload: unknown;
  /** Always `accepted` — a rejected N−1 payload is the violation this catalog exists to catch. */
  readonly expect: 'accepted';
}

export interface N1CompatResult {
  readonly name: string;
  readonly direction: N1CompatDirection;
  readonly pass: boolean;
  readonly detail: string;
}

function isN1CompatWire(v: unknown): v is N1CompatWire {
  return typeof v === 'string' && (N1_COMPAT_WIRES as readonly string[]).includes(v);
}

function isN1CompatDirection(v: unknown): v is N1CompatDirection {
  return typeof v === 'string' && (N1_COMPAT_DIRECTIONS as readonly string[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(raw: Record<string, unknown>, key: string, where: string): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${where}: \`${key}\` must be a non-empty string`);
  return v;
}

function n1CompatCase(raw: unknown): N1CompatCase {
  if (!isRecord(raw)) throw new Error('n1-compat case: not an object');
  const name = str(raw, 'name', 'n1-compat case');
  const where = `n1-compat case ${name}`;
  const release = raw['release'];
  if (!isRecord(release)) throw new Error(`${where}: \`release\` must be an object`);
  const wire = str(raw, 'wire', where);
  if (!isN1CompatWire(wire)) throw new Error(`${where}: unknown wire \`${wire}\``);
  if (raw['expect'] !== 'accepted') throw new Error(`${where}: \`expect\` must be "accepted"`);
  if (!('payload' in raw)) throw new Error(`${where}: \`payload\` missing`);
  const pairedWith = release['pairedWith'];
  const direction = raw['direction'] ?? 'backward';
  if (!isN1CompatDirection(direction)) throw new Error(`${where}: unknown direction \`${String(direction)}\``);
  return {
    name,
    description: str(raw, 'description', where),
    direction,
    release: {
      label: str(release, 'label', `${where}.release`),
      sha: str(release, 'sha', `${where}.release`),
      ...(typeof pairedWith === 'string' ? { pairedWith } : {}),
    },
    wire,
    payload: raw['payload'],
    expect: 'accepted',
  };
}

export const N1_COMPAT_CASES: readonly N1CompatCase[] = [
  release2AppThemeV2,
  release2RenderMeta,
  release2GenerationProfile,
  release2OpsGenerateBlueprint,
  release91HandshakeSuggestion,
  release13RenderResult,
  release14OpsListBlueprints,
  forwardAppThemeUnknownMember,
  forwardAppThemeCarryUnknownMember,
  forwardAppThemeCarryUninterpretable,
  forwardRenderMetaUnknownMember,
  forwardOpsListBlueprintsStamped,
  forwardOpsListBlueprintsCloned,
  forwardViewProofLaterVersion,
  forwardViewProofRootLaterClaim,
].map(n1CompatCase);

function gradeAppTheme(payload: unknown): { pass: boolean; detail: string } {
  const r = appThemeSchema.safeParse(payload);
  return r.success
    ? { pass: true, detail: 'appThemeSchema: accepted' }
    : { pass: false, detail: `appThemeSchema refused the previous release's theme: ${r.error.issues.map((i) => i.message).join('; ')}` };
}

function gradeAppThemeRead(payload: unknown): { pass: boolean; detail: string } {
  const r = parseAppThemeAtReadDoor(payload);
  if (!r.ok) return { pass: false, detail: `the read door REFUSED a later release's theme: ${r.issues.join('; ')}` };
  if (r.stripped.length === 0) return { pass: false, detail: 'the read door stripped nothing — the case must carry a member today does not name' };
  const sent = isRecord(payload) ? payload['overlays'] : undefined;
  if (JSON.stringify(r.theme.overlays) !== JSON.stringify(sent)) return { pass: false, detail: 'the read door changed the overlays while stripping' };
  return { pass: true, detail: `parseAppThemeAtReadDoor: kept, stripped [${r.stripped.join(', ')}]` };
}

/** Key-order-insensitive JSON — a parser may emit named members first; VERBATIM is about content, not key order. */
function canonicalJson(v: unknown): string {
  const sortKeysDeep = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sortKeysDeep) : isRecord(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeysDeep(x[k])])) : x;
  return JSON.stringify(sortKeysDeep(v));
}
function gradeAppThemeCarry(payload: unknown): { pass: boolean; detail: string } {
  // ggui#1155 — the CARRY read must return the stored document VERBATIM and name,
  // beside it, exactly the members an INTERPRET reader on this release would drop.
  const r = appThemeGetResponseSchema.safeParse(payload);
  if (!r.success) return { pass: false, detail: `appThemeGetResponseSchema refused a later release's carry response: ${r.error.issues.map((i) => i.message).join('; ')}` };
  // ggui#1175 — a stored document that is not a theme comes back `theme: null` WITH `uninterpretable`;
  // the case grades that today's schema reads it as that, never as "no theme".
  if (r.data.theme === null) {
    const u = r.data.uninterpretable;
    if (u === undefined) return { pass: false, detail: 'a null-theme case must carry `uninterpretable`: a bare null is "no theme", not a forward case' };
    return { pass: true, detail: `appThemeGetResponseSchema: theme null, uninterpretable (${u.issueCount} issue(s): ${u.issues.map((i) => i.code).join(', ')})` };
  }
  const sentTheme = isRecord(payload) ? payload['theme'] : undefined;
  if (!isRecord(sentTheme)) return { pass: false, detail: 'the case must carry a non-null theme' };
  if (canonicalJson(r.data.theme) !== canonicalJson(sentTheme)) return { pass: false, detail: 'the carry read did not return the stored document VERBATIM' };
  const known = new Set(Object.keys(appThemeSchema.shape));
  const unknown = Object.keys(sentTheme).filter((k) => !known.has(k)).sort();
  const named = [...(r.data.interpreted?.stripped ?? [])].sort();
  if (unknown.length === 0) return { pass: false, detail: 'the case must carry a member today does not name' };
  if (JSON.stringify(named) !== JSON.stringify(unknown)) return { pass: false, detail: `interpreted.stripped [${named.join(', ')}] must name exactly the members today cannot name [${unknown.join(', ')}]` };
  return { pass: true, detail: `appThemeGetResponseSchema: verbatim, named [${unknown.join(', ')}]` };
}
function gradeGenerationProfile(payload: unknown): { pass: boolean; detail: string } {
  const r = appGenerationProfileSchema.safeParse(payload);
  return r.success
    ? { pass: true, detail: 'appGenerationProfileSchema: accepted' }
    : { pass: false, detail: `appGenerationProfileSchema refused the previous release's profile: ${r.error.issues.map((i) => i.message).join('; ')}` };
}

function gradeOpsGenerateBlueprint(payload: unknown): { pass: boolean; detail: string } {
  const r = opsGenerateBlueprintInputSchema.safeParse(payload);
  return r.success
    ? { pass: true, detail: 'opsGenerateBlueprintInputSchema: accepted' }
    : { pass: false, detail: `opsGenerateBlueprintInputSchema refused the previous release's input: ${r.error.issues.map((i) => i.message).join('; ')}` };
}

function gradeRenderMeta(payload: unknown): { pass: boolean; detail: string } {
  const themeIssues: string[] = [];
  const actionIssues: string[] = [];
  const spentIssues: string[] = [];
  const r = parseMcpAppAiGguiRenderMeta(payload, {
    onInvalidTheme: (issues) => themeIssues.push(...issues),
    onInvalidActionSpec: (issues) => actionIssues.push(...issues),
    onInvalidSpentOneShots: (issues) => spentIssues.push(...issues),
  });
  if (!r.ok) return { pass: false, detail: `parseMcpAppAiGguiRenderMeta refused the previous release's slice: ${r.reason}` };
  if (r.meta === undefined) return { pass: false, detail: 'parseMcpAppAiGguiRenderMeta found no `ai.ggui/render` slice in the payload' };
  const sent = isRecord(payload) ? payload[MCP_APP_AI_GGUI_RENDER_META_KEY] : undefined;
  const sentTheme = isRecord(sent) && sent['theme'] !== undefined;
  if (sentTheme && (themeIssues.length > 0 || r.meta.theme === undefined)) {
    return { pass: false, detail: `the previous release's theme was dropped at the read door: ${themeIssues.join('; ') || 'theme absent on the parsed meta'}` };
  }
  // ggui#1178 — an action contract the slice carried must survive the read door (unknown entry
  // members stripped, never the whole spec dropped).
  const sentActionSpec = isRecord(sent) && sent['actionSpec'] !== undefined;
  if (sentActionSpec && (actionIssues.length > 0 || r.meta.actionSpec === undefined)) {
    return { pass: false, detail: `the slice's action contract was dropped at the read door: ${actionIssues.join('; ') || 'actionSpec absent on the parsed meta'}` };
  }
  // ggui#1223 — the card's spent oneShot names must survive the read door: dropping them makes a
  // consumed action read as live again after a reload.
  const sentSpent = isRecord(sent) && sent['spentOneShots'] !== undefined;
  if (sentSpent && (spentIssues.length > 0 || r.meta.spentOneShots === undefined)) {
    return { pass: false, detail: `the card's spent oneShot set was dropped at the read door: ${spentIssues.join('; ') || 'spentOneShots absent on the parsed meta'}` };
  }
  return {
    pass: true,
    detail:
      'parseMcpAppAiGguiRenderMeta: accepted' +
      (sentTheme ? ', theme preserved' : '') +
      (sentActionSpec ? ', actionSpec preserved' : '') +
      (sentSpent ? ', spentOneShots preserved' : ''),
  };
}

// ggui#1336 — the handshake suggestion the served release emits must keep parsing
// when the suggestion gains an optional member (`blueprintMeta.matchedIntent`).
function gradeHandshakeSuggestion(payload: unknown): { pass: boolean; detail: string } {
  const r = handshakeSuggestionSchema.safeParse(payload);
  return r.success
    ? { pass: true, detail: 'handshakeSuggestionSchema: accepted' }
    : { pass: false, detail: `handshakeSuggestionSchema refused the previous release's suggestion: ${r.error.issues.map((i) => i.message).join('; ')}` };
}

// ggui#1459 — the render result the served release emits must keep parsing when
// the result gains an optional member (`effort`).
function gradeRenderResult(payload: unknown): { pass: boolean; detail: string } {
  const r = renderOutputSchema.safeParse(payload);
  return r.success
    ? { pass: true, detail: 'renderOutputSchema: accepted' }
    : { pass: false, detail: `renderOutputSchema refused the previous release's render result: ${r.error.issues.map((i) => i.message).join('; ')}` };
}

// ggui#1280 — the blueprint rows the served release lists must keep parsing once
// rows carry the minting build, and a row that carries none must not gain one:
// absence is the unknown-build category, never a value a reader fills in.
// ggui#1570 — the same for a copied row's `clonedFrom`: kept verbatim on the
// copy, and never filled in on a row that is not one.
function gradeOpsListBlueprints(payload: unknown): { pass: boolean; detail: string } {
  const r = opsListBlueprintsOutputSchema.safeParse(payload);
  if (!r.success) {
    return { pass: false, detail: `opsListBlueprintsOutputSchema refused the previous release's list: ${r.error.issues.map((i) => i.message).join('; ')}` };
  }
  const sent = isRecord(payload) && Array.isArray(payload['blueprints']) ? payload['blueprints'] : [];
  for (const [i, row] of r.data.blueprints.entries()) {
    const sentRow: unknown = sent[i];
    const sentBuild = isRecord(sentRow) ? sentRow['build'] : undefined;
    if (canonicalJson(row.build) !== canonicalJson(sentBuild)) {
      return { pass: false, detail: `row ${i}'s build changed across the parse (sent ${canonicalJson(sentBuild)}, parsed ${canonicalJson(row.build)})` };
    }
    const sentClonedFrom = isRecord(sentRow) ? sentRow['clonedFrom'] : undefined;
    if (canonicalJson(row.clonedFrom) !== canonicalJson(sentClonedFrom)) {
      return { pass: false, detail: `row ${i}'s clonedFrom changed across the parse (sent ${canonicalJson(sentClonedFrom)}, parsed ${canonicalJson(row.clonedFrom)})` };
    }
  }
  return { pass: true, detail: `opsListBlueprintsOutputSchema: accepted, ${r.data.blueprints.length} row(s), build and clonedFrom kept as sent` };
}

/** The keys of a root's JSON payload, decoded without trusting it; `undefined` when it is not a JSON object. */
function rootKeys(root: string): readonly string[] | undefined {
  try {
    const padded = root.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((root.length + 3) % 4);
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
    return isRecord(json) ? Object.keys(json) : undefined;
  } catch {
    // Not base64url JSON: the case's own root is broken, reported by the caller.
    return undefined;
  }
}

// ggui#1415 — a later release's view proof (SPEC §4.7). The door shape is fixed
// for every version, so a relay that checks it must keep forwarding the proof,
// including one longer than any v1 proof. A later version reads
// `version_unknown`, never `malformed`; a v1 proof whose root carries a claim
// this release does not name still parses.
function gradeViewProof(payload: unknown): { pass: boolean; detail: string } {
  const proof = isRecord(payload) ? payload['proof'] : undefined;
  if (typeof proof !== 'string') return { pass: false, detail: 'the case must carry a proof string' };
  if (!VIEW_PROOF_RELAY_SHAPE.test(proof)) {
    return { pass: false, detail: "the later release's proof is off the relay door shape, so a relay that checks it would drop it" };
  }
  const parsed = parseViewProof(proof);
  if (!proof.startsWith('v1.')) {
    if (proof.length <= VIEW_PROOF_V1_MAX_CHARS) {
      return { pass: false, detail: `the case must use the room the door keeps for later versions: its proof is ${proof.length} characters, within v1's ${VIEW_PROOF_V1_MAX_CHARS}` };
    }
    return !parsed.ok && parsed.reason === 'version_unknown'
      ? { pass: true, detail: `parseViewProof: a later version of ${proof.length} characters reads version_unknown, and the relay shape holds` }
      : { pass: false, detail: `parseViewProof read a later version as ${parsed.ok ? 'a v1 proof' : parsed.reason}, not version_unknown` };
  }
  if (!parsed.ok) return { pass: false, detail: `parseViewProof refused a v1 proof over a later root claim: ${parsed.reason}` };
  const named = new Set(Object.keys(parsed.proof.claims));
  const unnamed = (rootKeys(parsed.proof.root) ?? []).filter((k) => !named.has(k));
  return unnamed.length > 0
    ? { pass: true, detail: `parseViewProof: a v1 proof whose root carries [${unnamed.join(', ')}] still parses` }
    : { pass: false, detail: 'the case must root its proof in claims this release does not name' };
}

/**
 * One grader per wire, exhaustively: a wire added to {@link N1_COMPAT_WIRES}
 * without an arm here does not compile, rather than falling through to
 * another wire's grader.
 */
function gradeWire(wire: N1CompatWire, payload: unknown): { pass: boolean; detail: string } {
  switch (wire) {
    case 'app-theme':
      return gradeAppTheme(payload);
    case 'app-theme-read':
      return gradeAppThemeRead(payload);
    case 'app-theme-carry':
      return gradeAppThemeCarry(payload);
    case 'render-meta':
      return gradeRenderMeta(payload);
    case 'generation-profile':
      return gradeGenerationProfile(payload);
    case 'ops-generate-blueprint':
      return gradeOpsGenerateBlueprint(payload);
    case 'handshake-suggestion':
      return gradeHandshakeSuggestion(payload);
    case 'render-result':
      return gradeRenderResult(payload);
    case 'ops-list-blueprints':
      return gradeOpsListBlueprints(payload);
    case 'view-proof':
      return gradeViewProof(payload);
    default: {
      const unhandled: never = wire;
      return { pass: false, detail: `no grader for wire ${String(unhandled)}` };
    }
  }
}

/** Grade every N−1 case against the protocol as shipped. */
export function runN1CompatConformance(): readonly N1CompatResult[] {
  return N1_COMPAT_CASES.map((c) => {
    const graded = gradeWire(c.wire, c.payload);
    return { name: c.name, direction: c.direction, pass: graded.pass, detail: `${c.release.label} (${c.release.sha}) → ${graded.detail}` };
  });
}
