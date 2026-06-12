/**
 * react ↔ react-native twin parity gate.
 *
 * `@ggui-ai/react` and `@ggui-ai/react-native` deliberately carry
 * byte-identical copies of the platform-neutral chat-thread /
 * chat-helpers core (and of this very test). Duplicated
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
 *     `components/GguiRender.tsx`, `invoke/sse-parse.ts`) — they
 *     document their delta in a file-top header per the original
 *     convention.
 *
 * `CODE_IDENTICAL_MIRRORS` extends the same gate beyond the SDK pair:
 * documented structural copies (e.g. the reserved-validators A2UI
 * adapter, mirrored into `@ggui-ai/mcp-server`) whose docstrings
 * legitimately differ per package but whose EXECUTABLE CODE must stay
 * identical — compared comment-stripped.
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
  'chat-helpers/message-groups.ts',
  'chat-helpers/render.ts',
  'chat-helpers/useRafThrottled.ts',
  'chat-thread/ChatThreadProvider.tsx',
  'chat-thread/adapters/types.ts',
  'chat-thread/index.ts',
  'chat-thread/outbox.ts',
  'chat-thread/shells/agent/index.ts',
  'chat-thread/shells/chat/index.ts',
  'chat-thread/useChatThread.ts',
  'chat-thread/useNetworkState.ts',
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
  { rel: 'hooks/useWebSocket.ts' },
  { rel: 'websocket/EventBuffer.ts' },
  { rel: 'websocket/EventBuffer.test.ts' },
  { rel: 'websocket/WebSocketManager.ts', rnOnlyExports: ['NetInfoState'] },
  { rel: 'websocket/WebSocketManager.test.ts' },
];

/** Marker every documented-delta RN copy must carry near the top. */
const DELTA_HEADER_RE = /platform delta/i;
/** How much of the file head is searched for the delta header. */
const DELTA_HEADER_WINDOW = 2000;

/**
 * Documented structural copies whose executable code must stay
 * identical while package-perspective docstrings may differ.
 * Compared after stripping comments + blank lines. Paths are relative
 * to the shared `oss/packages/` root.
 */
const CODE_IDENTICAL_MIRRORS: ReadonlyArray<{
  readonly label: string;
  readonly files: readonly string[];
}> = [
  {
    label: 'reserved-validators A2UI adapter (react / react-native / mcp-server)',
    files: [
      'ggui-react/src/internal/reserved-validators.ts',
      'ggui-react-native/src/internal/reserved-validators.ts',
      'mcp-server/src/reserved-validators.ts',
    ],
  },
];

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

/**
 * Strip line and block comments (string-literal aware) plus blank
 * lines and trailing whitespace, so mirror comparison sees executable
 * code only. NOT a general TS lexer (no regex-literal handling) —
 * sufficient for the mirror files, which contain none.
 */
function stripCommentsAndBlankLines(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' =
    'code';
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    // String modes.
    if (ch === '\\') {
      out += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && ch === "'") ||
      (mode === 'double' && ch === '"') ||
      (mode === 'template' && ch === '`')
    ) {
      mode = 'code';
    }
    out += ch;
    i += 1;
  }
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
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

describe('documented structural mirrors (comment-stripped code parity)', () => {
  it.each(CODE_IDENTICAL_MIRRORS.map((m) => [m.label, m] as const))(
    '%s — executable code is identical across all copies',
    (label, mirror) => {
      const present = mirror.files.filter((rel) =>
        existsSync(path.join(packagesRoot, rel)),
      );
      if (present.length === 0) {
        // Whole mirror family deleted in tandem — prune the entry.
        return;
      }
      expect(
        present.length === mirror.files.length,
        `mirror drift (${label}): only ${present.length}/${mirror.files.length} ` +
          `copies exist (${present.join(', ')}). Delete or add all copies ` +
          'in the same slice.',
      ).toBe(true);

      const stripped = mirror.files.map((rel) =>
        stripCommentsAndBlankLines(
          readFileSync(path.join(packagesRoot, rel), 'utf8'),
        ),
      );
      for (let i = 1; i < stripped.length; i += 1) {
        expect(
          stripped[i] === stripped[0],
          `mirror drift (${label}): comment-stripped code of ` +
            `${mirror.files[i]} differs from ${mirror.files[0]}. ` +
            'These are documented structural copies — apply code changes ' +
            'to every copy in the same slice (docstrings may differ).',
        ).toBe(true);
      }
    },
  );
});
