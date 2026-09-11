/**
 * N−1 wire compatibility — the §3.6 drift gate (ggui#1014).
 *
 * Every case is the PREVIOUS release's payload for a protocol-owned wire,
 * tagged with that release's sha, and passes iff today's parser accepts
 * it. A case that starts failing is a receiver that broke N−1 across a
 * rolling release — the fix is the receiver, never the fixture; a fixture
 * changes only when the pairing of record moves
 * (`docs/protocol/VERSION-POLICY.md` §3.6).
 *
 * Pure-function catalog: no transport, no adopter input — graded on every
 * `runConformance()` and by the kit's own unit lane.
 */
import { appThemeSchema } from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  parseMcpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';

import release2AppThemeV2 from './cases/release-2-app-theme-v2.json' with { type: 'json' };
import release2RenderMeta from './cases/release-2-render-meta.json' with { type: 'json' };

/** The protocol-owned wires the catalog can grade. */
export const N1_COMPAT_WIRES = ['app-theme', 'render-meta'] as const;
export type N1CompatWire = (typeof N1_COMPAT_WIRES)[number];

export interface N1CompatRelease {
  /** Human label of the release that emitted the payload (e.g. "ggui Release 2"). */
  readonly label: string;
  /** The release's sha — the receipt that the payload is that release's, not a guess. */
  readonly sha: string;
  /** The pairing of record on the other side, when the wire crosses fleets. */
  readonly pairedWith?: string;
}

export interface N1CompatCase {
  readonly name: string;
  readonly description: string;
  readonly release: N1CompatRelease;
  readonly wire: N1CompatWire;
  /** The previous release's payload, verbatim. */
  readonly payload: unknown;
  /** Always `accepted` — a rejected N−1 payload is the violation this catalog exists to catch. */
  readonly expect: 'accepted';
}

export interface N1CompatResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
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
  if (!(N1_COMPAT_WIRES as readonly string[]).includes(wire)) throw new Error(`${where}: unknown wire \`${wire}\``);
  if (raw['expect'] !== 'accepted') throw new Error(`${where}: \`expect\` must be "accepted"`);
  if (!('payload' in raw)) throw new Error(`${where}: \`payload\` missing`);
  const pairedWith = release['pairedWith'];
  return {
    name,
    description: str(raw, 'description', where),
    release: {
      label: str(release, 'label', `${where}.release`),
      sha: str(release, 'sha', `${where}.release`),
      ...(typeof pairedWith === 'string' ? { pairedWith } : {}),
    },
    wire: wire as N1CompatWire,
    payload: raw['payload'],
    expect: 'accepted',
  };
}

export const N1_COMPAT_CASES: readonly N1CompatCase[] = [release2AppThemeV2, release2RenderMeta].map(n1CompatCase);

function gradeAppTheme(payload: unknown): { pass: boolean; detail: string } {
  const r = appThemeSchema.safeParse(payload);
  return r.success
    ? { pass: true, detail: 'appThemeSchema: accepted' }
    : { pass: false, detail: `appThemeSchema refused the previous release's theme: ${r.error.issues.map((i) => i.message).join('; ')}` };
}

function gradeRenderMeta(payload: unknown): { pass: boolean; detail: string } {
  const themeIssues: string[] = [];
  const r = parseMcpAppAiGguiRenderMeta(payload, { onInvalidTheme: (issues) => themeIssues.push(...issues) });
  if (!r.ok) return { pass: false, detail: `parseMcpAppAiGguiRenderMeta refused the previous release's slice: ${r.reason}` };
  if (r.meta === undefined) return { pass: false, detail: 'parseMcpAppAiGguiRenderMeta found no `ai.ggui/render` slice in the payload' };
  const sent = isRecord(payload) ? payload[MCP_APP_AI_GGUI_RENDER_META_KEY] : undefined;
  const sentTheme = isRecord(sent) && sent['theme'] !== undefined;
  if (sentTheme && (themeIssues.length > 0 || r.meta.theme === undefined)) {
    return { pass: false, detail: `the previous release's theme was dropped at the read door: ${themeIssues.join('; ') || 'theme absent on the parsed meta'}` };
  }
  return { pass: true, detail: 'parseMcpAppAiGguiRenderMeta: accepted' + (sentTheme ? ', theme preserved' : '') };
}

/** Grade every N−1 case against the protocol as shipped. */
export function runN1CompatConformance(): readonly N1CompatResult[] {
  return N1_COMPAT_CASES.map((c) => {
    const graded = c.wire === 'app-theme' ? gradeAppTheme(c.payload) : gradeRenderMeta(c.payload);
    return { name: c.name, pass: graded.pass, detail: `${c.release.label} (${c.release.sha}) → ${graded.detail}` };
  });
}
