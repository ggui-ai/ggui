/**
 * Slice 11.5 C7 pathological coverage — probe blueprint.
 *
 * Not a product surface. Purpose: force-trigger two canonical failure
 * modes the runtime contract enforcement emits, and surface the
 * resulting `_ggui:contract-error` envelopes as DOM so the Lane-1
 * Playwright spec can make deterministic assertions.
 *
 *   - **TOOL_THREW**: "break" button dispatches `triggerBroken` (wired
 *     to `tasks_broken`, which always throws). The router catches the
 *     throw + emits a contract-error.
 *
 *   - **SCHEMA_VIOLATION**: "malformed refresh" button dispatches
 *     `triggerMalformedRefresh` (wired to `tasks_list` — the valid
 *     tool). Action succeeds. The channel refresh then calls
 *     `tasks_malformed_list` (declared on the `tasks` channel's
 *     `tool`), which returns `{wrong:'shape'}`. The router's
 *     post-refresh `assertStreamContract` rejects that shape against
 *     the declared `{items: array}` schema → contract-error envelope.
 *
 *   - **TOOL_NOT_FOUND**: "tool-not-found" button dispatches
 *     `triggerNotFound` (wired to `doesNotExist` — never registered on
 *     any mount). The router's `has()` check fails and emits a
 *     contract-error envelope before invoking. Tool name is locked to
 *     match the conformance fixture
 *     `wired-action-tool-not-found.json`'s `expectedBehavior.toolName`,
 *     which the Lane-1 spec asserts as `data-tool` on the row.
 *
 *   - **TOOL_TIMEOUT**: "tool-timeout" button dispatches
 *     `triggerTimeout` (wired to `hanging_tool`, which sleeps past the
 *     configured wiredActionRouter timeout). The router cancels its
 *     wait + emits a contract-error envelope. Tool name is locked to
 *     match the conformance fixture
 *     `wired-action-tool-timeout.json`'s `expectedBehavior.toolName`.
 *     The Lane-1 spec lowers the timeout via `GGUI_WIRED_TIMEOUT_MS`
 *     so the probe fires inside a small per-test budget.
 *
 * The envelopes arrive on the reserved `_ggui:contract-error` channel.
 * Reserved channels bypass the author-side streamSpec declaration
 * gate (see `validateStreamData`'s `isKnownReservedChannel` closed-set
 * short-circuit + the BUILTIN `ContractErrorPayload` structural
 * validator per Item 4 injection pattern + `GguiSessionStreamBuffer.
 * record()` forcing `replay:'all'` for `_ggui:*`), so
 * `useStream('_ggui:contract-error')` just works — no need to author
 * it into `streamSpec`.
 *
 * DOM anchors the spec matches:
 *   - `data-ggui-contract-error-count`     total count
 *   - `data-ggui-contract-error-codes`     "|"-joined codes in arrival order
 *   - `data-ggui-contract-error` per row, `data-code` carries the code
 */
import { useAction, useStream } from '@ggui-ai/wire';

interface ContractErrorPayload {
  readonly toolName: string;
  readonly actionName?: string;
  readonly sourceAction?: {
    readonly type: 'wired-action' | 'refresh-stream' | (string & {});
    readonly dispatchedAt: string;
  };
  readonly error: {
    // Mirrors `@ggui-ai/protocol` `ContractErrorCode` — an extensibly-
    // closed union (v1 codes + `(string & {})`). Kept in sync with the
    // source of truth per Phase 1 Item 2, so future codes
    // (`SANITIZER_FAILED`, `BOOTSTRAP_FAILED`, etc.) land through this
    // probe without the mirror type narrowing them away.
    readonly code:
      | 'TOOL_NOT_FOUND'
      | 'TOOL_THREW'
      | 'TOOL_TIMEOUT'
      | 'SCHEMA_VIOLATION'
      | (string & {});
    readonly message: string;
    readonly causedBy?: string;
  };
  readonly timestamp: string;
}

export default function ContractProbe(): JSX.Element {
  const triggerBroken = useAction<Record<string, never>>('triggerBroken');
  const triggerMalformed = useAction<Record<string, never>>(
    'triggerMalformedRefresh',
  );
  const triggerNotFound = useAction<Record<string, never>>('triggerNotFound');
  const triggerTimeout = useAction<Record<string, never>>('triggerTimeout');

  // useStream folds deliveries into `{latest, all}`. Contract-error
  // envelopes emit with `mode: 'append'` (see
  // `render-channel.ts::emitContractError`), so `all` accumulates in
  // arrival order — what the spec needs to count + identify codes.
  //
  // Reserved-channel replay: `GguiSessionStreamBuffer.record()` forces
  // `replay:'all'` for `_ggui:*` channels, so a subscriber that
  // attaches after an envelope landed still sees the history on
  // subscribe — no cold-boot race for the spec to work around.
  const errorStream = useStream<ContractErrorPayload>('_ggui:contract-error');

  const seen = errorStream.all;
  const codes = seen.map((e) => e.error.code).join('|');

  return (
    <article
      data-testid="contract-probe-blueprint"
      style={{ fontFamily: 'system-ui', maxWidth: 560 }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Contract probe</h1>
        <p style={{ color: '#666', fontSize: 13, margin: '4px 0 0' }}>
          Slice 11.5 pathological coverage. Clicking each button forces
          a canonical <code>_ggui:contract-error</code> emission.
        </p>
      </header>

      <section
        style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}
      >
        <button
          type="button"
          data-ggui-probe="break"
          onClick={() => triggerBroken({})}
          style={probeButtonStyle('#b33')}
        >
          Trigger broken tool
        </button>
        <button
          type="button"
          data-ggui-probe="malformed"
          onClick={() => triggerMalformed({})}
          style={probeButtonStyle('#b63')}
        >
          Trigger malformed refresh
        </button>
        <button
          type="button"
          data-ggui-probe="not-found"
          onClick={() => triggerNotFound({})}
          style={probeButtonStyle('#85b')}
        >
          Trigger tool-not-found
        </button>
        <button
          type="button"
          data-ggui-probe="timeout"
          onClick={() => triggerTimeout({})}
          style={probeButtonStyle('#358')}
        >
          Trigger tool-timeout
        </button>
      </section>

      <section
        data-ggui-contract-error-count={seen.length}
        data-ggui-contract-error-codes={codes}
        style={{
          border: '1px solid #ccc',
          borderRadius: 4,
          padding: 12,
        }}
      >
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>
          Contract errors ({seen.length})
        </h2>
        {seen.length === 0 ? (
          <p
            data-ggui-contract-error-empty
            style={{ color: '#888', fontSize: 13, margin: 0, fontStyle: 'italic' }}
          >
            No contract errors observed. Click a probe button above.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {seen.map((evt, i) => (
              <li
                key={`${evt.timestamp}-${i}`}
                data-ggui-contract-error
                data-code={evt.error.code}
                data-source={evt.sourceAction?.type ?? ''}
                data-tool={evt.toolName}
                style={{
                  padding: '6px 0',
                  borderTop: i === 0 ? 'none' : '1px solid #eee',
                  fontSize: 13,
                }}
              >
                <code style={{ fontWeight: 600 }}>{evt.error.code}</code>{' '}
                <span style={{ color: '#666' }}>
                  {evt.sourceAction?.type ?? 'unknown'} · {evt.toolName}
                </span>
                <div style={{ color: '#444', marginTop: 2 }}>
                  {evt.error.message}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function probeButtonStyle(tone: string) {
  return {
    padding: '10px 14px',
    background: tone,
    color: '#fff',
    border: 0,
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 14,
  };
}
