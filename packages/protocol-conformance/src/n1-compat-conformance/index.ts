/**
 * N−1 wire compatibility — the §3.6 drift gate (ggui#1014).
 *
 * Every BACKWARD case is the PREVIOUS release's payload for a protocol-owned
 * wire, tagged with that release's sha, and passes iff today's parser accepts
 * it. Every FORWARD case (ggui#1093 belt) is a LATER release's payload —
 * today's shape plus a top-level member today does not name, synthetic by
 * construction — and passes iff today's READ door keeps it, overlays intact,
 * stripping and naming the member. A case that starts failing is a receiver
 * that broke N−1 across a rolling release — the fix is the receiver, never
 * the fixture; a fixture changes only when the pairing of record moves
 * (`docs/protocol/VERSION-POLICY.md` §3.6).
 *
 * Pure-function catalog: no transport, no adopter input — graded on every
 * `runConformance()` and by the kit's own unit lane.
 */
import { appGenerationProfileSchema, appThemeGetResponseSchema, appThemeSchema, handshakeSuggestionSchema, opsGenerateBlueprintInputSchema, parseAppThemeAtReadDoor } from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  parseMcpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';

import release2AppThemeV2 from './cases/release-2-app-theme-v2.json' with { type: 'json' };
import release2RenderMeta from './cases/release-2-render-meta.json' with { type: 'json' };
import release2GenerationProfile from './cases/release-2-generation-profile.json' with { type: 'json' };
import release2OpsGenerateBlueprint from './cases/release-2-ops-generate-blueprint.json' with { type: 'json' };
import release91HandshakeSuggestion from './cases/release-9-1-handshake-suggestion.json' with { type: 'json' };
import forwardAppThemeUnknownMember from './cases/forward-app-theme-unknown-member.json' with { type: 'json' };
import forwardAppThemeCarryUnknownMember from './cases/forward-app-theme-carry-unknown-member.json' with { type: 'json' };
import forwardRenderMetaUnknownMember from './cases/forward-render-meta-unknown-member.json' with { type: 'json' };

/** The protocol-owned wires the catalog can grade. */
export const N1_COMPAT_WIRES = ['app-theme', 'app-theme-read', 'app-theme-carry', 'render-meta', 'generation-profile', 'ops-generate-blueprint', 'handshake-suggestion'] as const;

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
  forwardAppThemeUnknownMember,
  forwardAppThemeCarryUnknownMember,
  forwardRenderMetaUnknownMember,
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

/** Grade every N−1 case against the protocol as shipped. */
export function runN1CompatConformance(): readonly N1CompatResult[] {
  return N1_COMPAT_CASES.map((c) => {
    const graded =
      c.wire === 'app-theme'
        ? gradeAppTheme(c.payload)
        : c.wire === 'app-theme-read'
          ? gradeAppThemeRead(c.payload)
        : c.wire === 'app-theme-carry'
          ? gradeAppThemeCarry(c.payload)
        : c.wire === 'render-meta'
          ? gradeRenderMeta(c.payload)
          : c.wire === 'generation-profile'
            ? gradeGenerationProfile(c.payload)
          : c.wire === 'handshake-suggestion'
            ? gradeHandshakeSuggestion(c.payload)
            : gradeOpsGenerateBlueprint(c.payload);
    return { name: c.name, direction: c.direction, pass: graded.pass, detail: `${c.release.label} (${c.release.sha}) → ${graded.detail}` };
  });
}
