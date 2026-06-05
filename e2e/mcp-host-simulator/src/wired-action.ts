/**
 * Wired-action bridge — host-side mirror of the 3-envelope dance the
 * iframe runtime fires on every button click. See
 * `docs/development/mcp-apps-wired-actions.md` for the empirical
 * findings that drove this shape.
 *
 * The iframe runtime's `dispatchWiredAction` (packages/iframe-runtime/
 * src/runtime.ts) posts three envelopes in order to `window.parent`.
 * In production they go to the MCP-Apps host (claude.ai et al.),
 * which handles each one differently:
 *
 *   1. `tools/call ggui_runtime_submit_action` — host forwards to the
 *      MCP server as a normal tool call (real wire round-trip). The
 *      arguments carry a `SubmitActionEnvelope` ({kind, payload, …}) per
 *      `@ggui-ai/protocol/integrations/mcp-apps`.
 *   2. `ui/update-model-context` — host stuffs into LLM context
 *      (silent, host-internal — never crosses the wire)
 *   3. `ui/message` — host pre-fills chat input + waits for user
 *      consent (host-internal until user hits send)
 *
 * Tier 2 tests don't have a real host or LLM. The simulator
 * faithfully drives #1 over the actual MCP transport (so the server-
 * side audit/echo is exercised) and captures #2 + #3 for assertions
 * (they're the host's internal state, not server protocol).
 *
 * The hash + builders here MUST stay byte-identical to runtime.ts —
 * if a future change in iframe-runtime alters the envelope shape, the
 * simulator's host will silently mis-handle real iframe traffic. The
 * `wiredActionFnv1a` test fixture cross-checks against runtime.ts
 * output to catch that drift.
 */

/**
 * FNV-1a 32-bit hash, 8 hex chars. Mirror of
 * `packages/iframe-runtime/src/runtime.ts::fnv1aHex` — must produce
 * identical output for the same input.
 *
 * Not cryptographic — just collision-resistant enough for in-flight
 * correlation between the silent context-update and the consent
 * message that bridge a click to the host's LLM.
 */
export function wiredActionFnv1a(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * GguiSession a wired-action's `data` payload as a short inline string for
 * embedding in the `ui/message` consent prompt. Mirror of
 * `packages/iframe-runtime/src/runtime.ts::formatWiredActionDataInline`
 * — must produce identical output for the same input so consent
 * messages match runtime.ts byte-for-byte.
 */
export function formatWiredActionDataInline(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object' || Array.isArray(data)) return '';
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => {
    if (v === null) return `${k}: null`;
    if (typeof v === 'string') return `${k}: ${v}`;
    if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`;
    const json = JSON.stringify(v);
    return `${k}: ${json.length > 40 ? `${json.slice(0, 37)}…` : json}`;
  });
  return parts.join(', ');
}

/**
 * JSON-RPC 2.0 envelope for the gateway `tools/call`. The arguments
 * are a `SubmitActionEnvelope` from `@ggui-ai/protocol/integrations/mcp-apps`
 * (`{kind, payload}` discriminated union) plus the ambient correlation
 * fields the runtime stamps on every submit-action envelope.
 */
export interface WiredActionToolsCallEnvelope {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: 'tools/call';
  readonly params: {
    readonly name: string;
    readonly arguments: {
      readonly kind: 'dispatch' | 'openLink' | 'requestDisplayMode' | string;
      readonly payload: Record<string, unknown>;
      readonly renderId: string;
      readonly appId: string;
      readonly actionId: string;
      readonly firedAt: string;
    };
  };
}

/** JSON-RPC 2.0 envelope for the silent context update. */
export interface WiredActionUpdateContextEnvelope {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: 'ui/update-model-context';
  readonly params: {
    readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  };
}

/** JSON-RPC 2.0 envelope for the consent-gated user message. */
export interface WiredActionUiMessageEnvelope {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: 'ui/message';
  readonly params: {
    readonly role: 'user';
    readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  };
}

/**
 * Today's builder is dispatch-flavoured — the only kind that drives
 * the 3-message bridge (`tools/call` + `ui/update-model-context` +
 * `ui/message`). `openLink` / `requestDisplayMode` fire only the
 * audit envelope and would need a separate builder when host-side
 * coverage of those primary effects is exercised — out of scope here.
 */
export interface BuildWiredActionArgs {
  readonly intent: string;
  readonly data?: unknown;
  /**
   * Active render id — sourced from `bootstrap.renderId`. The
   * submit_action handler requires it for `kind:"dispatch"` (the
   * pending-events pipe is render-keyed).
   */
  readonly renderId: string;
  /**
   * `contextSpec` snapshot at gesture time — the iframe's
   * `readLocalUiContext()` output. Defaults to `{}` (no context).
   */
  readonly uiContext?: Record<string, unknown>;
  readonly appId: string;
  /**
   * ISO-8601 timestamp included in the actionId hash + envelopes.
   * Defaults to `new Date().toISOString()`. Override for deterministic
   * tests where the actionId needs to be predictable.
   */
  readonly firedAt?: string;
  /**
   * Receiver tool name. Defaults to `'ggui_runtime_submit_action'` —
   * the MCP server's wired-action receiver. Override only in tests
   * that wire a custom gateway tool.
   */
  readonly toolName?: string;
  /**
   * JSON-RPC `id` seed for the 3 envelopes. Defaults to 3 random ints.
   * Override for deterministic tests asserting specific ids.
   */
  readonly idSeed?: readonly [number, number, number];
}

export interface BuiltWiredAction {
  readonly actionId: string;
  readonly firedAt: string;
  readonly toolsCall: WiredActionToolsCallEnvelope;
  readonly updateContext: WiredActionUpdateContextEnvelope;
  readonly uiMessage: WiredActionUiMessageEnvelope;
  /**
   * The `[ggui:pending-action] {...}` JSON text the host stuffs into
   * the LLM's persistent context. Pulled out for direct assertion
   * without re-parsing the envelope.
   */
  readonly pendingActionText: string;
  /**
   * The natural-language consent prompt rendered into chat input. The
   * LLM cross-checks the embedded `actionId` against the pending-
   * action context before acting.
   */
  readonly consentText: string;
}

const randId = (): number => Math.floor(Math.random() * 1e9);

/**
 * Build the 3 envelopes the iframe runtime would post for a wired
 * action, plus the derived `actionId` + display strings. Pure: no
 * I/O, no network. Tests that want the full bridge dance call
 * `HostSimulator.simulateWiredAction` which uses this internally.
 */
export function buildWiredAction(args: BuildWiredActionArgs): BuiltWiredAction {
  const toolName = args.toolName ?? 'ggui_runtime_submit_action';
  const firedAt = args.firedAt ?? new Date().toISOString();
  const data = args.data === undefined ? undefined : args.data;
  // Mirror iframe-runtime/runtime.ts::dispatchWiredAction byte-for-byte:
  // `${intent}|${JSON.stringify(data ?? null)}|${firedAt}`. Drift here
  // makes the host's consent-text actionId disagree with the iframe's
  // pending-action actionId, breaking the LLM cross-check.
  const actionId = wiredActionFnv1a(
    `${args.intent}|${JSON.stringify(data ?? null)}|${firedAt}`,
  );
  const inlineData = formatWiredActionDataInline(data);
  const dataPart = inlineData === '' ? '' : ` (${inlineData})`;
  const ids = args.idSeed ?? ([randId(), randId(), randId()] as const);

  const pendingActionText = `[ggui:pending-action] ${JSON.stringify({
    actionId,
    intent: args.intent,
    data: data ?? null,
    firedAt,
    renderId: args.renderId,
    appId: args.appId,
  })}`;
  const consentText = `Please proceed with **${args.intent}**${dataPart}. [id: \`${actionId}\`]`;

  return {
    actionId,
    firedAt,
    toolsCall: {
      jsonrpc: '2.0',
      id: ids[0],
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: {
          // SubmitActionEnvelope shape per @ggui-ai/protocol/integrations/
          // mcp-apps. The dispatch payload is {intent, actionData,
          // uiContext} — actionData is what the user did, uiContext is
          // the contextSpec snapshot captured atomically at gesture time.
          kind: 'dispatch',
          payload: {
            intent: args.intent,
            actionData: data ?? null,
            uiContext: args.uiContext ?? {},
          },
          renderId: args.renderId,
          appId: args.appId,
          actionId,
          firedAt,
        },
      },
    },
    updateContext: {
      jsonrpc: '2.0',
      id: ids[1],
      method: 'ui/update-model-context',
      params: {
        content: [{ type: 'text', text: pendingActionText }],
      },
    },
    uiMessage: {
      jsonrpc: '2.0',
      id: ids[2],
      method: 'ui/message',
      params: {
        role: 'user',
        content: [{ type: 'text', text: consentText }],
      },
    },
    pendingActionText,
    consentText,
  };
}
