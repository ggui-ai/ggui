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
 * Files that intentionally differ (platform deltas) are NOT listed —
 * they document their delta in a file-top header instead (e.g.
 * `components/GguiRender.tsx`, `invoke/sse-parse.ts`).
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
