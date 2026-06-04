/**
 * MCP Apps protocol probe system card.
 *
 * Diagnostic + regression fixture exercising every gesture surface
 * the iframe runtime routes:
 *
 *   1. **Pattern β bridge** — `tools/call ggui_runtime_submit_action` (audit) +
 *      `ui/update-model-context` (silent context) + `ui/message`
 *      (consent prompt). Fires for cross-server / non-app-visible
 *      `actionSpec[name].dispatch.tool` targets, OR any
 *      `dispatch.kind === 'agent'` entry. Empirical-first reproduction
 *      of the production `dispatchWiredAction` path.
 *   2. **Pattern α direct fire** — `tools/call ggui_runtime_submit_action`
 *      (audit) + `tools/call <T>` (direct, no consent prompt). Fires
 *      for same-server, app-visible target tools. Probes against
 *      `ggui_runtime_submit_action` itself (the only universally-app-visible
 *      tool the iframe can be sure exists).
 *   3. **Native-idiom: anchor click** — `ui/open-link` paired with
 *      `kind: 'openLink'` audit. Triggered by the runtime's
 *      capture-phase `<a href>` interceptor (cross-origin or
 *      `target="_blank"`). The probe row simulates the postMessage
 *      directly so the operator sees the envelope without needing to
 *      click an anchor.
 *   4. **Native-idiom: fullscreen** — `ui/request-display-mode` +
 *      `kind: 'requestDisplayMode'` audit. Triggered by the runtime's
 *      `Element.prototype.requestFullscreen` /
 *      `Document.prototype.exitFullscreen` overrides. The probe row
 *      simulates the postMessage; the row labelled "exitFullscreen"
 *      sends `mode: 'inline'` per the spec'd inverse mapping.
 *
 * Each button transitions through `idle → pending → success | error`
 * so the operator can see exactly which methods the embedding host
 * (claude.ai web, Claude Desktop, …) actually honors today. The
 * persistent receive-log captures every `ui/notifications/*` and
 * host-issued request seen while the card is mounted.
 *
 * Why this lives outside the wire-context: system cards (`kind:
 * 'mcp-apps-probe'`, `'no-credentials'`, …) mount in a render-only
 * branch of `bootSelfContained` that does NOT install
 * `<GguiWireProvider>` — they exist precisely to surface protocol
 * state when the wire-context might not be live (auth missing,
 * compile failed, etc.). The probe card mirrors the postMessage
 * envelopes the runtime's gesture surfaces would emit, derived from
 * the canonical `SubmitActionEnvelope` shape in
 * `@ggui-ai/protocol/integrations/mcp-apps`.
 *
 * Originating context: an earlier runtime posted its outbound
 * action dispatch only as `{method:'tools/call',
 * name:'ggui_runtime_submit_action', ...}`. Per MCP Apps spec §401, hosts MUST
 * reject `tools/call` from views for tools without `'app'` in
 * visibility — claude.ai silently dropped the call. The original
 * probe diagnosed the gap; the routing simplification work landed
 * Pattern α / Pattern β / native idioms in response.
 */
import * as React from 'react';
import {
  Card,
  Stack,
  Heading,
  Text,
  Button,
  Badge,
} from '@ggui-ai/design/primitives';

/**
 * One canonical View→Host method the spec defines (apps.mdx:963-1102).
 * Keep this list aligned with the §"Requests (View → Host)" section.
 * Adding a new probe button means adding one entry here + one
 * matching renderer in the JSX below.
 */
type ProbeMethod =
  | 'ui/message'
  | 'ui/update-model-context'
  | 'ui/open-link'
  | 'ui/request-display-mode'
  | 'tools/call';

/**
 * Per-button state machine.
 *
 *   - `idle` — initial; click fires the request.
 *   - `pending` — request sent; awaiting host response.
 *   - `success` — host returned a JSON-RPC `result` (we render the
 *     stringified shape).
 *   - `error` — host returned `error` (code + message) OR no response
 *     within the timeout (synthesized `code: 'TIMEOUT'`).
 */
type ProbeOutcome =
  | { readonly state: 'idle' }
  | { readonly state: 'pending'; readonly startedAtMs: number }
  | { readonly state: 'success'; readonly result: unknown }
  | { readonly state: 'error'; readonly code: number | string; readonly message: string };

/**
 * Receive-log entry — one row per host-emitted message we observe.
 * `params` is captured raw so the operator can inspect the shape;
 * formatting happens at render time.
 */
interface LogEntry {
  readonly id: number;
  readonly tsIso: string;
  readonly method: string;
  readonly params: unknown;
}

const PROBE_TIMEOUT_MS = 5_000;

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Lifetime-scoped JSON-RPC caller. One instance per card mount —
 * mirrors the runtime's own `makeJsonRpcCaller` (runtime.ts:105) so
 * the card behaves like a real View per spec semantics. Pending
 * requests are tracked by id; the persistent `message` listener
 * matches by id and resolves.
 */
function useJsonRpcCaller(): (
  method: ProbeMethod,
  params: unknown,
) => Promise<JsonRpcResponse> {
  const nextIdRef = React.useRef(10_000);
  const pendingRef = React.useRef(
    new Map<number, (resp: JsonRpcResponse) => void>(),
  );

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as unknown;
      if (data === null || typeof data !== 'object') return;
      const id = (data as { id?: unknown }).id;
      if (typeof id !== 'number') return;
      const resolver = pendingRef.current.get(id);
      if (resolver === undefined) return;
      pendingRef.current.delete(id);
      resolver(data as JsonRpcResponse);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return React.useCallback((method, params) => {
    return new Promise<JsonRpcResponse>((resolve) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      pendingRef.current.set(id, resolve);
      try {
        window.parent.postMessage(
          { jsonrpc: '2.0', id, method, params: params ?? {} },
          '*',
        );
      } catch (err) {
        pendingRef.current.delete(id);
        resolve({
          error: {
            code: -32099,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
      window.setTimeout(() => {
        if (pendingRef.current.delete(id)) {
          resolve({ error: { code: -32001, message: 'TIMEOUT' } });
        }
      }, PROBE_TIMEOUT_MS);
    });
  }, []);
}

/**
 * Persistent listener for host-emitted notifications. Captures every
 * `jsonrpc:'2.0'` message that arrives without an `id` (= notification)
 * AND has a `method` starting with `ui/notifications/` or matching one
 * of the spec's other host→view methods. Bounded to the most recent
 * 50 entries to keep the DOM small even on chatty hosts.
 */
function useNotificationLog(): readonly LogEntry[] {
  const [entries, setEntries] = React.useState<readonly LogEntry[]>([]);
  const seqRef = React.useRef(0);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as unknown;
      if (data === null || typeof data !== 'object') return;
      const obj = data as { jsonrpc?: unknown; method?: unknown; id?: unknown; params?: unknown };
      if (obj.jsonrpc !== '2.0') return;
      if (typeof obj.method !== 'string') return;
      // Capture notifications (no id) AND host-issued requests
      // (e.g. `ui/resource-teardown` carries an id). Skip echoes of
      // OUR own outbound calls — those have ids in the 10k range we
      // assigned.
      const isOurEcho =
        typeof obj.id === 'number' &&
        obj.id >= 10_000 &&
        (obj.method === 'ui/message' ||
          obj.method === 'ui/update-model-context' ||
          obj.method === 'ui/open-link' ||
          obj.method === 'ui/request-display-mode' ||
          obj.method === 'tools/call');
      if (isOurEcho) return;
      seqRef.current += 1;
      const entry: LogEntry = {
        id: seqRef.current,
        tsIso: new Date().toISOString(),
        method: obj.method,
        params: obj.params,
      };
      setEntries((prev) => {
        const next = [entry, ...prev];
        return next.slice(0, 50);
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return entries;
}

/**
 * Build a default param payload for each canonical method. The shapes
 * mirror the spec examples (apps.mdx:963-1102) exactly so any host
 * with a strict validator accepts them.
 */
function defaultParams(method: ProbeMethod): unknown {
  switch (method) {
    case 'ui/message':
      // Empirical 2026-05-03: claude.ai's validator wants `content`
      // as a ContentBlock[] array, NOT the single-object shape the
      // spec example (apps.mdx:1006-1011) shows. Other hosts may
      // accept either; an array satisfies both.
      return {
        role: 'user',
        content: [
          { type: 'text', text: '[ggui:probe] hello from the protocol probe card' },
        ],
      };
    case 'ui/update-model-context':
      return {
        content: [
          {
            type: 'text',
            text: '[ggui:probe] this user prefers concise replies',
          },
        ],
      };
    case 'ui/open-link':
      return { url: 'https://ggui.ai' };
    case 'ui/request-display-mode':
      return { mode: 'fullscreen' };
    case 'tools/call':
      // Mirror `runtime.ts::emitAudit` + `runtime.ts::dispatchWiredAction`
      // so this probe empirically validates the canonical
      // `GguiUserActionInput` envelope (SPEC §4.6, see
      // `@ggui-ai/protocol/integrations/mcp-apps`). `ggui_runtime_submit_action`
      // MUST be server-registered with `_meta.ui.visibility: ['app']`
      // for claude.ai to honor the call (spec §401). With registration
      // in place, the server echoes the discriminated envelope back as
      // a tool result; the host forwards that result to this iframe
      // via the JSON-RPC response matching our outbound id.
      //
      // The probe uses `kind: 'dispatch'` so the chained Pattern β
      // 3-message follow-up (`ui/update-model-context` + `ui/message`)
      // semantically matches a real wired-action click.
      return {
        name: 'ggui_runtime_submit_action',
        arguments: {
          kind: 'dispatch',
          payload: {
            intent: 'probe-click',
            data: { note: 'hello from the protocol probe' },
          },
          renderId: 'probe-render',
          appId: 'probe-app',
          actionId: '00000000', // overwritten in onClick with real FNV-1a
          firedAt: new Date().toISOString(),
        },
      };
  }
}

/**
 * Compute a short deterministic action-id from an action payload.
 * FNV-1a 32-bit, 8 hex chars — not cryptographically strong, just
 * collision-resistant enough for in-flight wired-action correlation.
 *
 * Why hash (vs. random UUID): the id reproduces from
 * `{intent, data, firedAt}` so both the silent context-update AND
 * the loud consent message arrive at the SAME id without
 * cross-state coordination. The LLM can then cross-check
 * `actionId` in message ↔ `actionId` in pending-action context
 * before acting — catches the case where a second click overwrote
 * the context between message-fire and user-confirm.
 */
function hashAction(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Render an action's `data` payload as a short inline string for
 * embedding in a chat message. Goal: readable by humans, not a JSON
 * dump. Falls back to truncated JSON for nested / non-scalar values
 * so the consent prompt doesn't drop information silently.
 */
function formatActionDataInline(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object' || Array.isArray(data)) return '';
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => {
    if (v === null) return `${k}: null`;
    if (typeof v === 'string') return `${k}: ${v}`;
    if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`;
    // Fallback for nested objects / arrays — keep it terse.
    const json = JSON.stringify(v);
    return `${k}: ${json.length > 40 ? `${json.slice(0, 37)}…` : json}`;
  });
  return parts.join(', ');
}

interface ProbeButtonRowProps {
  readonly method: ProbeMethod;
  readonly description: string;
  readonly call: (method: ProbeMethod, params: unknown) => Promise<JsonRpcResponse>;
}

function ProbeButtonRow({
  method,
  description,
  call,
}: ProbeButtonRowProps): React.JSX.Element {
  const [outcome, setOutcome] = React.useState<ProbeOutcome>({ state: 'idle' });

  const onClick = React.useCallback(() => {
    const startedAtMs = Date.now();
    setOutcome({ state: 'pending', startedAtMs });
    const params = defaultParams(method);
    void call(method, params).then((resp) => {
      if (resp.error) {
        setOutcome({
          state: 'error',
          code: resp.error.code ?? '?',
          message: resp.error.message ?? '(no message)',
        });
        return;
      }
      setOutcome({ state: 'success', result: resp.result ?? {} });

      // Tools/call chain. After the gateway tool acknowledges, fire
      // TWO follow-ups so the LLM gets both human-readable AND
      // machine-readable signals about the action:
      //
      //   1. `ui/update-model-context` (silent) — structured payload
      //      describing the pending action. Persists in context so
      //      the LLM has unambiguous tool-args data instead of
      //      having to parse "tomorrow 3pm" out of natural language.
      //      Spec §1099: each call overwrites the previous; we DON'T
      //      attempt to accumulate (latest click wins, which matches
      //      most UX flows).
      //
      //   2. `ui/message` (consent prompt) — natural-language
      //      surface of the same action. claude.ai pre-fills the
      //      input with this text and asks the user to confirm
      //      before sending. The consent IS the prompt-injection
      //      firewall (visibility:['app'] keeps the LLM from
      //      seeing view-issued tool calls directly).
      //
      // LLM next turn sees: the user-confirmed message + the
      // structured pending-action context. Combination reduces
      // tool-arg ambiguity dramatically — production actionSpec
      // routing would also include `tool: actionSpec.<intent>.tool`
      // in the structured context so the LLM knows the exact
      // downstream tool to call.
      if (method === 'tools/call') {
        const args = (params as { arguments?: Record<string, unknown> })
          .arguments ?? {};
        // New gesture-envelope shape (SPEC §4.6): `{kind, payload,
        // renderId, appId, actionId, firedAt}`. For Pattern β the
        // `payload` carries `{intent, data}`.
        const payload = (args['payload'] as Record<string, unknown> | undefined) ?? {};
        const intent = String(payload['intent'] ?? '?');
        const data = payload['data'];
        const inlineData = formatActionDataInline(data);
        const dataPart = inlineData === '' ? '' : ` (${inlineData})`;
        const firedAt = new Date().toISOString();
        // Action id binds the silent context update and the loud
        // consent message together. LLM verifies `actionId` in the
        // message matches `actionId` in pending-action context
        // before acting — guarantees the args it uses are the args
        // we authorized (not a stale or overwritten set).
        const actionId = hashAction(
          `${intent}|${JSON.stringify(data ?? null)}|${firedAt}`,
        );

        // Silent — structured hint for the LLM. `actionId` is the
        // verification token; rest carries the exact args.
        void call('ui/update-model-context', {
          content: [
            {
              type: 'text',
              text: `[ggui:pending-action] ${JSON.stringify({
                actionId,
                intent,
                data: data ?? null,
                firedAt,
              })}`,
            },
          ],
        });

        // Loud — user-confirmable surface. Three layers:
        //   - Intent in **bold** so the user sees what they're
        //     authorizing at a glance.
        //   - Inline data so the consent prompt is human-readable
        //     (no "approve a black box" UX).
        //   - Trailing `[id: <hash>]` stamp the LLM cross-checks
        //     against the pending-action context. Mismatch → LLM
        //     should refuse to act (production prompt-engineering).
        void call('ui/message', {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Please proceed with **${intent}**${dataPart}. [id: \`${actionId}\`]`,
            },
          ],
        });
      }
    });
  }, [call, method]);

  const buttonLabel =
    outcome.state === 'pending'
      ? 'Sending…'
      : outcome.state === 'success'
        ? 'Send again ✓'
        : outcome.state === 'error'
          ? 'Retry'
          : 'Send';

  const statusBadge: React.ReactNode =
    outcome.state === 'idle' ? (
      <Badge variant="default">idle</Badge>
    ) : outcome.state === 'pending' ? (
      <Badge variant="info">pending</Badge>
    ) : outcome.state === 'success' ? (
      <Badge variant="success">success</Badge>
    ) : (
      <Badge variant="warning">error</Badge>
    );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--ggui-spacing-2, 8px)',
        padding: 'var(--ggui-spacing-3, 12px)',
        borderRadius: 'var(--ggui-shape-radius-md, 10px)',
        border: '1px solid var(--ggui-color-neutral-200, #e4e4e7)',
        background: 'var(--ggui-color-surface, #fff)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--ggui-spacing-3, 12px)',
          flexWrap: 'wrap',
        }}
      >
        <code
          style={{
            fontFamily:
              'var(--ggui-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            fontSize: 'var(--ggui-font-size-sm, 13px)',
            color: 'var(--ggui-color-onSurface, #111)',
            fontWeight: 'var(--ggui-font-weight-semibold, 600)',
          }}
        >
          {method}
        </code>
        {statusBadge}
      </div>
      <Text
        variant="caption"
        style={{
          color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
          fontSize: 'var(--ggui-font-size-xs, 11px)',
        }}
      >
        {description}
      </Text>
      <div style={{ display: 'flex', gap: 'var(--ggui-spacing-2, 8px)' }}>
        <Button
          variant="primary"
          size="sm"
          onClick={onClick}
          disabled={outcome.state === 'pending'}
        >
          {buttonLabel}
        </Button>
      </div>
      {outcome.state === 'success' || outcome.state === 'error' ? (
        <pre
          style={{
            margin: 0,
            fontFamily:
              'var(--ggui-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            fontSize: 'var(--ggui-font-size-xs, 11px)',
            color:
              outcome.state === 'error'
                ? 'var(--ggui-color-warning, #b45309)'
                : 'var(--ggui-color-onSurfaceVariant, #52525b)',
            background: 'var(--ggui-color-neutral-100, #f4f4f5)',
            padding: 'var(--ggui-spacing-2, 8px)',
            borderRadius: 'var(--ggui-shape-radius-sm, 6px)',
            overflow: 'auto',
            maxHeight: '120px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {outcome.state === 'error'
            ? `${outcome.code}: ${outcome.message}`
            : JSON.stringify(outcome.result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export interface ProtocolProbeCardProps {
  /**
   * Optional: the original prompt that triggered the probe render.
   * Surfaced as a footnote so the card matches the framing of other
   * system cards (`NoCredentialsCard`).
   */
  readonly intent?: string;
}

export function ProtocolProbeCard({
  intent,
}: ProtocolProbeCardProps): React.JSX.Element {
  const call = useJsonRpcCaller();
  const log = useNotificationLog();

  return (
    <Card
      padding="lg"
      border={false}
      shadow="none"
      style={{ backgroundColor: 'transparent' }}
    >
      <Stack gap="lg">
        <Stack gap="sm">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--ggui-spacing-3, 12px)',
              flexWrap: 'wrap',
            }}
          >
            <Heading level={3}>MCP Apps protocol probe</Heading>
            <Badge variant="info">diagnostic</Badge>
          </div>
          <Text
            style={{
              color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              lineHeight: '1.55',
            }}
          >
            One button per primary host effect emitted by the iframe
            runtime's gesture surfaces (Pattern α / Pattern β / native-
            idiom interceptors). Click each to verify which methods
            this host honors. The
            <code>tools/call</code> row chains the full Pattern β bridge
            (audit + context + consent), reproducing the production
            <code>dispatchWiredAction</code> envelope shape verbatim.
            The receive log below captures every notification the host
            emits while this card is mounted.
          </Text>
        </Stack>

        <Stack gap="md">
          <ProbeButtonRow
            method="ui/message"
            description="Pattern β step 3 — consent-gated user authorization. Host pre-fills + waits for user confirm before the LLM acts on the paired pending-action context."
            call={call}
          />
          <ProbeButtonRow
            method="ui/update-model-context"
            description="Pattern β step 2 — silent structured `[ggui:pending-action]` context drop. LLM honors on next turn. No immediate UI."
            call={call}
          />
          <ProbeButtonRow
            method="ui/open-link"
            description="Native-idiom anchor click interceptor primary effect. Opens ggui.ai in the host's browser / new tab. Real iframe code triggers via `<a href target='_blank'>` or cross-origin href."
            call={call}
          />
          <ProbeButtonRow
            method="ui/request-display-mode"
            description="Native-idiom fullscreen interceptor primary effect. Request fullscreen — real iframe code calls `el.requestFullscreen()`; the runtime overrides the prototype to route through here."
            call={call}
          />
          <ProbeButtonRow
            method="tools/call"
            description="Pattern β full bridge: `tools/call ggui_runtime_submit_action` (audit, kind:'dispatch') + `ui/update-model-context` + `ui/message`. Spec §401 requires `_meta.ui.visibility:['app']` on the receiving tool. Pattern α (direct fire to a same-server app-visible target) would skip steps 2+3 and add a second `tools/call` to the target tool instead."
            call={call}
          />
        </Stack>

        <Stack gap="sm">
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--ggui-spacing-3, 12px)',
            }}
          >
            <Heading level={4}>Receive log</Heading>
            <Text
              variant="caption"
              style={{
                color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                fontSize: 'var(--ggui-font-size-xs, 11px)',
              }}
            >
              {log.length} {log.length === 1 ? 'event' : 'events'}
            </Text>
          </div>
          {log.length === 0 ? (
            <Text
              variant="caption"
              style={{
                color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                fontStyle: 'italic',
              }}
            >
              No host notifications observed yet. Click a probe button or
              wait for the host to emit one.
            </Text>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ggui-spacing-1, 4px)',
                maxHeight: '320px',
                overflow: 'auto',
                padding: 'var(--ggui-spacing-2, 8px)',
                background: 'var(--ggui-color-neutral-100, #f4f4f5)',
                border: '1px solid var(--ggui-color-neutral-200, #e4e4e7)',
                borderRadius: 'var(--ggui-shape-radius-md, 10px)',
              }}
            >
              {log.map((entry) => (
                <details
                  key={entry.id}
                  style={{
                    fontFamily:
                      'var(--ggui-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                    fontSize: 'var(--ggui-font-size-xs, 11px)',
                  }}
                >
                  <summary
                    style={{
                      cursor: 'pointer',
                      padding: 'var(--ggui-spacing-1, 4px) 0',
                      color: 'var(--ggui-color-onSurface, #111)',
                    }}
                  >
                    <span
                      style={{
                        color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                        marginRight: '8px',
                      }}
                    >
                      {entry.tsIso.slice(11, 19)}
                    </span>
                    <span style={{ fontWeight: 600 }}>{entry.method}</span>
                  </summary>
                  <pre
                    style={{
                      margin: '4px 0 0 16px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                    }}
                  >
                    {JSON.stringify(entry.params, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </Stack>

        {intent ? (
          <Text
            variant="caption"
            style={{
              color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              opacity: 0.7,
            }}
          >
            Triggered by: {intent}
          </Text>
        ) : null}
      </Stack>
    </Card>
  );
}
