/**
 * react ↔ react-native twin parity gate.
 *
 * `@ggui-ai/react` and `@ggui-ai/react-native` deliberately carry
 * byte-identical copies of the platform-neutral chat-helpers core
 * (and of this very test). Duplicated
 * platform-neutral React code is the leading indicator of silent
 * behavioral drift between the two published SDKs — this gate makes
 * any one-sided edit fail fast in BOTH packages' suites.
 *
 * This duplication is tolerated, not endorsed: the eventual fix is
 * hoisting the platform-neutral core into a shared package both SDKs
 * re-export, at which point these manifest entries disappear. Until
 * then, every behavior-neutral change to a listed module MUST be
 * applied to both copies in the same slice.
 *
 * Rules per manifest entry:
 *   - both files present  → bytes must match exactly.
 *   - one file present    → drift (a one-sided add/delete) — fail.
 *   - neither file present→ the twin was deleted (or hoisted) in
 *     tandem; parity holds. Prune the stale entry when convenient.
 *
 * Files that intentionally differ (platform deltas) fall into two
 * tiers:
 *   - documented-delta twins listed in `DOCUMENTED_DELTA_TWINS` —
 *     near-twins whose RN copy carries a file-top "Platform delta"
 *     header enumerating the intentional divergences. The structural
 *     gate below pins their EXPORTED SURFACE equal (modulo the
 *     per-entry annotated one-sided exports) and requires the header,
 *     so undocumented drift in the public shape still fails fast.
 *   - header-only twins NOT listed in any manifest (e.g.
 *     `invoke/sse-parse.ts`) — they document their delta in a
 *     file-top header per the original convention.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This test is itself one of the twins — the same bytes live at
// `<packages>/ggui-react/src/twin-parity.test.ts` and
// `<packages>/ggui-react-native/src/twin-parity.test.ts`, so all path
// resolution is written symmetrically from the shared packages root.
const here = path.dirname(fileURLToPath(import.meta.url));
const packagesRoot = path.resolve(here, '..', '..');
const WEB_SRC = path.join(packagesRoot, 'ggui-react', 'src');
const RN_SRC = path.join(packagesRoot, 'ggui-react-native', 'src');

/**
 * Relative (to each package's `src/`) paths expected to be
 * byte-identical across the two SDKs.
 */
const BYTE_IDENTICAL_TWINS: readonly string[] = [
  // The chat-thread/* entries were pruned when the RN chat-thread stack
  // (ChatThreadProvider/useChatThread/outbox/shells) was deleted as an
  // owner-ruled zero-consumer surface (ggui#425 residual slice) — the
  // ggui-react copy survives as a deliberately web-only surface, so it
  // is no longer a twin.
  'chat-helpers/message-groups.ts',
  'chat-helpers/render.ts',
  'chat-helpers/useRafThrottled.ts',
  // No chat-thread entries on either side: the chat-thread family was
  // deleted from BOTH packages (owner-ruled SDK-for-others surface,
  // zero internal consumers — web slice + #425-residual RN slice,
  // 2026-08-13). Nothing to diff.
  'twin-parity.test.ts',
];

/**
 * Near-twins that CANNOT be byte-identical (genuine platform
 * adaptations: AppState/NetInfo monitoring, AsyncStorage persistence,
 * Dimensions-based context detection, …). Contract per entry:
 *
 *   - both files must exist (one-sided delete = drift);
 *   - the RN copy documents its divergences in a file-top
 *     "Platform delta" header (the adapted side carries the record,
 *     matching the `invoke/sse-parse.ts` precedent);
 *   - the exported surface must be identical across the two copies,
 *     except for exports explicitly annotated `webOnlyExports` /
 *     `rnOnlyExports` below — and every annotation must be LIVE
 *     (actually one-sided), so stale annotations fail too.
 */
interface DeltaTwin {
  readonly rel: string;
  /** Exports present only in the ggui-react copy, by design. */
  readonly webOnlyExports?: readonly string[];
  /** Exports present only in the ggui-react-native copy, by design. */
  readonly rnOnlyExports?: readonly string[];
}

const DOCUMENTED_DELTA_TWINS: readonly DeltaTwin[] = [
  { rel: 'components/GguiProvider.tsx' },
  { rel: 'components/UiFeedback.tsx' },
  // The websocket/useWebSocket delta-twin entries were pruned when the
  // RN legacy render family (GguiRender/DynamicComponent/WebViewRenderer/
  // NativeRegistry + its WS stack) was deleted — ggui#425. The web
  // copies survive for the @ggui-ai/console debugger only.
];

/** Marker every documented-delta RN copy must carry near the top. */
const DELTA_HEADER_RE = /platform delta/i;
/** How much of the file head is searched for the delta header. */
const DELTA_HEADER_WINDOW = 2000;

// The former CODE_IDENTICAL_MIRRORS gate (comment-stripped code parity
// beyond the SDK pair) was retired when its last entry — the
// reserved-validators A2UI adapter — collapsed to a single copy:
// the ggui-react copy was deleted with the legacy `GguiRender` WS
// render family, leaving `mcp-server/src/reserved-validators.ts` as
// the sole owner. Reinstate the mechanism if a new structural mirror
// family appears.

/**
 * Extract the set of exported binding names from a TS/TSX source.
 * Regex-based on purpose — the twins are plain ESM modules; this only
 * needs declaration exports, brace (re-)exports, and `export default`.
 */
function extractExportedNames(source: string): ReadonlySet<string> {
  const names = new Set<string>();
  const declRe =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(declRe)) {
    names.add(m[1] as string);
  }
  const braceRe = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
  for (const m of source.matchAll(braceRe)) {
    for (const raw of (m[1] as string).split(',')) {
      const part = raw.trim();
      if (part.length === 0) continue;
      const withoutType = part.replace(/^type\s+/, '');
      const asMatch = withoutType.match(/^[\w$]+\s+as\s+([\w$]+)$/);
      names.add(asMatch ? (asMatch[1] as string) : withoutType);
    }
  }
  if (/^export\s+default\b/m.test(source)) names.add('default');
  return names;
}

describe('react ↔ react-native twin parity (byte-identical modules)', () => {
  it.each(BYTE_IDENTICAL_TWINS)('%s is byte-identical across both SDKs', (rel) => {
    const webPath = path.join(WEB_SRC, rel);
    const rnPath = path.join(RN_SRC, rel);
    const webExists = existsSync(webPath);
    const rnExists = existsSync(rnPath);

    if (!webExists && !rnExists) {
      // Deleted (or hoisted into a shared package) in tandem — parity
      // holds. The manifest entry is now stale; prune it when convenient.
      return;
    }

    expect(
      webExists && rnExists,
      `twin drift: ${rel} exists in only one SDK ` +
        `(ggui-react: ${webExists}, ggui-react-native: ${rnExists}). ` +
        'Add/delete the module in both packages in the same slice.',
    ).toBe(true);

    const webBytes = readFileSync(webPath, 'utf8');
    const rnBytes = readFileSync(rnPath, 'utf8');
    expect(
      webBytes === rnBytes,
      `twin drift: ${rel} differs between @ggui-ai/react and ` +
        '@ggui-ai/react-native. These copies must stay byte-identical — ' +
        'apply the change to both packages in the same slice. ' +
        '(Eventual fix: hoist the platform-neutral core into a shared ' +
        'package both SDKs re-export, and retire this manifest entry.)',
    ).toBe(true);
  });

  it('manifest is grounded — at least one listed twin still exists', () => {
    // Guards against the whole manifest going vacuous after a hoist:
    // when every entry is gone from both SDKs, this test demands the
    // manifest (or the whole gate) be retired deliberately.
    const anyLeft = BYTE_IDENTICAL_TWINS.some(
      (rel) => existsSync(path.join(WEB_SRC, rel)) || existsSync(path.join(RN_SRC, rel)),
    );
    expect(anyLeft).toBe(true);
  });
});

describe('react ↔ react-native twin parity (documented platform-delta twins)', () => {
  it.each(DOCUMENTED_DELTA_TWINS.map((t) => [t.rel, t] as const))(
    '%s — both copies exist, RN documents the delta, exported surfaces match',
    (rel, twin) => {
      const webPath = path.join(WEB_SRC, rel);
      const rnPath = path.join(RN_SRC, rel);
      const webExists = existsSync(webPath);
      const rnExists = existsSync(rnPath);

      if (!webExists && !rnExists) {
        // Deleted (or hoisted) in tandem — parity holds; prune the
        // stale entry when convenient.
        return;
      }

      expect(
        webExists && rnExists,
        `twin drift: ${rel} exists in only one SDK ` +
          `(ggui-react: ${webExists}, ggui-react-native: ${rnExists}). ` +
          'Add/delete the module in both packages in the same slice.',
      ).toBe(true);

      const webSource = readFileSync(webPath, 'utf8');
      const rnSource = readFileSync(rnPath, 'utf8');

      // The adapted (RN) copy must carry the platform-delta record.
      expect(
        DELTA_HEADER_RE.test(rnSource.slice(0, DELTA_HEADER_WINDOW)),
        `documented-delta twin ${rel}: the react-native copy is missing ` +
          'its file-top "Platform delta" header. Document every ' +
          'intentional divergence from the ggui-react copy there.',
      ).toBe(true);

      const webOnly = new Set(twin.webOnlyExports ?? []);
      const rnOnly = new Set(twin.rnOnlyExports ?? []);
      const webExports = extractExportedNames(webSource);
      const rnExports = extractExportedNames(rnSource);

      // Annotations must be live: a name annotated one-sided must
      // actually be exported on that side and absent on the other.
      for (const name of webOnly) {
        expect(
          webExports.has(name) && !rnExports.has(name),
          `stale webOnlyExports annotation on ${rel}: "${name}" ` +
            `(web exports it: ${webExports.has(name)}, ` +
            `rn exports it: ${rnExports.has(name)}).`,
        ).toBe(true);
      }
      for (const name of rnOnly) {
        expect(
          rnExports.has(name) && !webExports.has(name),
          `stale rnOnlyExports annotation on ${rel}: "${name}" ` +
            `(rn exports it: ${rnExports.has(name)}, ` +
            `web exports it: ${webExports.has(name)}).`,
        ).toBe(true);
      }

      const webCore = [...webExports].filter((n) => !webOnly.has(n)).sort();
      const rnCore = [...rnExports].filter((n) => !rnOnly.has(n)).sort();
      expect(
        rnCore,
        `documented-delta twin ${rel}: exported surfaces diverged. ` +
          'Either converge the export, or annotate it as ' +
          'webOnlyExports/rnOnlyExports in DOCUMENTED_DELTA_TWINS ' +
          '(both copies of twin-parity.test.ts, same slice) and record ' +
          'it in the RN file-top header.',
      ).toEqual(webCore);
    },
  );
});
