/**
 * Boundary tests for `@ggui-ai/protocol/integrations/mcp-apps`.
 *
 * Type-level + runtime locks on the MCP Apps outbound surface. Nothing
 * here exercises WebSocket / HTTP behavior — those live in
 * `@ggui-ai/mcp-server/mcp-apps-outbound.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_APPS_UI_CAPABILITY,
  GGUI_RENDER_RESOURCE_URI,
  GGUI_RENDER_RESOURCE_MIME,
  GGUI_RENDER_UI_META,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  MCP_APP_AI_GGUI_HOST_SESSION_META_KEY,
  MCP_APP_LIFECYCLE_STATES,
  SUBMIT_ACTION_KINDS,
  parseMcpAppAiGguiRenderMeta,
  parseMcpAppAiGguiHostSessionMeta,
  toMcpAppEnvelope,
  deriveContextName,
  isMcpAppsGguiSession,
  isMcpAppLifecycleMessage,
  isGguiSubmitActionInput,
  validateMcpAppsGguiSession,
  type McpAppAiGguiRenderMeta,
  type McpAppAiGguiHostSessionMeta,
  type McpAppLifecycleEvent,
  type McpAppLifecycleMessage,
  type McpAppLifecycleState,
  type McpAppsGguiSession,
  type McpAppsToolVisibility,
  type SubmitActionKind,
  type GguiSubmitActionInput,
  type GguiUserActionMeta,
} from './mcp-apps';

describe('MCP Apps outbound constants', () => {
  it('advertises the spec-canonical UI capability name', () => {
    expect(MCP_APPS_UI_CAPABILITY).toBe('io.modelcontextprotocol/ui');
  });

  it('uses the locked render resource URI', () => {
    expect(GGUI_RENDER_RESOURCE_URI).toBe('ui://ggui/render');
  });

  it('serves the resource with spec-canonical profile MIME', () => {
    expect(GGUI_RENDER_RESOURCE_MIME).toBe('text/html;profile=mcp-app');
  });

  it('stamps GGUI_RENDER_UI_META with model-only visibility and the render resource URI', () => {
    expect(GGUI_RENDER_UI_META.resourceUri).toBe(GGUI_RENDER_RESOURCE_URI);
    expect(GGUI_RENDER_UI_META.visibility).toEqual(['model']);
    // §2.4.1 entry-point lock — ggui_render tool is ONLY model-callable.
    // Any widening (e.g. adding 'app') would change the visibility
    // surface and MUST revisit the design lock.
    const visibility: readonly McpAppsToolVisibility[] =
      GGUI_RENDER_UI_META.visibility;
    expect(visibility).not.toContain('app');
  });
});


describe('deriveContextName helper', () => {
  it('derives PascalCase + Context suffix for a typical camelCase slot key', () => {
    expect(deriveContextName('currentStep')).toBe('CurrentStepContext');
  });

  it('handles single-character slot keys', () => {
    expect(deriveContextName('a')).toBe('AContext');
  });

  it('upper-cases the leading character of an already-PascalCase input', () => {
    expect(deriveContextName('Status')).toBe('StatusContext');
  });

  it('returns the bare suffix for an empty string', () => {
    expect(deriveContextName('')).toBe('Context');
  });
});

describe('McpAppAiGguiRenderMeta structural lock', () => {
  // Post-Phase-B: the wire is one flat slice carrying identity, boot
  // wiring, live-channel auth, capability advertisements, render state,
  // contract pointer, and component-mode discriminator. The pre-Phase-B
  // pair (session + stack-item) collapsed because every render is its
  // own thing — the two slices were always activated together.
  it('carries identity + boot wiring + render state on a single flat shape', () => {
    const meta: McpAppAiGguiRenderMeta = {
      sessionId: 'r-1',
      appId: 'a',
      runtimeUrl: '/_ggui/iframe-runtime.js',
      wsUrl: 'w',
      wsToken: 't',
      expiresAt: 'e',
      propsJson: '{}',
      codeUrl: 'blob:...',
      codeHash: 'sha256:abc',
    };
    expect(meta.sessionId).toBe('r-1');
    expect(meta.appId).toBe('a');
    expect(meta.codeUrl).toBe('blob:...');
    expect(meta.propsJson).toBe('{}');
  });
});

describe('non-leak lock: outbound meta types live on the integrations subpath', () => {
  it('integration capability identifier is reachable only via the subpath', () => {
    expect(typeof MCP_APPS_UI_CAPABILITY).toBe('string');
  });
});

// =============================================================================
// Slice B — inbound McpAppsGguiSession shape
// =============================================================================

describe('isMcpAppsGguiSession type guard', () => {
  const validItem: McpAppsGguiSession = {
    type: 'mcpApps',
    id: 'item-1',
    createdAt: new Date().toISOString(),
    source: {
      connectorId: 'stripe',
      toolName: 'checkout',
      resourceUri: 'ui://stripe/checkout',
    },
  };
  it('accepts well-shaped McpAppsGguiSession', () => {
    expect(isMcpAppsGguiSession(validItem)).toBe(true);
  });
  it('rejects component renders', () => {
    expect(isMcpAppsGguiSession({ id: 'c', componentCode: '' })).toBe(false);
  });
  it('rejects null / primitives / non-mcpApps type', () => {
    expect(isMcpAppsGguiSession(null)).toBe(false);
    expect(isMcpAppsGguiSession('string')).toBe(false);
    expect(isMcpAppsGguiSession({ type: 'component' })).toBe(false);
  });
});

describe('validateMcpAppsGguiSession', () => {
  const base: McpAppsGguiSession = {
    type: 'mcpApps',
    id: 'item-1',
    createdAt: new Date().toISOString(),
    source: {
      connectorId: 'stripe',
      toolName: 'checkout',
      resourceUri: 'ui://stripe/checkout',
    },
  };
  it('accepts a well-shaped item', () => {
    expect(validateMcpAppsGguiSession(base)).not.toBeNull();
  });
  it('rejects missing / empty id', () => {
    expect(validateMcpAppsGguiSession({ ...base, id: '' })).toBeNull();
  });
  it('rejects missing source', () => {
    expect(validateMcpAppsGguiSession({ ...base, source: undefined })).toBeNull();
  });
  it('rejects empty connectorId', () => {
    expect(
      validateMcpAppsGguiSession({ ...base, source: { ...base.source, connectorId: '' } }),
    ).toBeNull();
  });
  it('rejects resourceUri that is not a ui:// URI', () => {
    expect(
      validateMcpAppsGguiSession({
        ...base,
        source: { ...base.source, resourceUri: 'https://example.com' },
      }),
    ).toBeNull();
  });
  it('rejects wrong-type discriminator', () => {
    expect(validateMcpAppsGguiSession({ ...base, type: 'component' })).toBeNull();
  });
});

describe('McpAppsGguiSession structural lock — ?:never on component fields', () => {
  it('typechecks when read via optional chain on the union', () => {
    const item: McpAppsGguiSession = {
      type: 'mcpApps',
      id: 'x',
      createdAt: '',
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' },
    };
    // These fields are `?: never` on McpAppsGguiSession. Optional-chain
    // reads should resolve to `undefined` at runtime.
    expect(item.componentCode).toBeUndefined();
    expect(item.actionSpec).toBeUndefined();
    expect(item.streamSpec).toBeUndefined();
    expect(item.props).toBeUndefined();
    expect(item.subscription).toBeUndefined();
  });
});

// =============================================================================
// MCP App lifecycle protocol — renderer ↔ host postMessage envelope.
// =============================================================================

describe('MCP_APP_LIFECYCLE_STATES — closed-set lock', () => {
  it('enumerates exactly four lifecycle states in canonical order', () => {
    expect(MCP_APP_LIFECYCLE_STATES).toEqual([
      'mounting',
      'code-ready',
      'error',
      'disconnected',
    ]);
  });

  it('every member is a valid McpAppLifecycleState (compile-time lock)', () => {
    for (const s of MCP_APP_LIFECYCLE_STATES) {
      const checked: McpAppLifecycleState = s;
      expect(typeof checked).toBe('string');
    }
  });
});

describe('isMcpAppLifecycleMessage type guard', () => {
  it('accepts a minimal mounting envelope', () => {
    const msg: McpAppLifecycleMessage = {
      type: 'ggui:lifecycle',
      event: { state: 'mounting' },
    };
    expect(isMcpAppLifecycleMessage(msg)).toBe(true);
  });

  it('accepts a code-ready envelope with sessionId', () => {
    const msg: McpAppLifecycleMessage = {
      type: 'ggui:lifecycle',
      event: { state: 'code-ready', sessionId: 'item_a' },
    };
    expect(isMcpAppLifecycleMessage(msg)).toBe(true);
  });

  it('accepts an error envelope with typed cause', () => {
    const msg: McpAppLifecycleMessage = {
      type: 'ggui:lifecycle',
      event: {
        state: 'error',
        error: { code: 'WS_HANDSHAKE_FAILED', message: 'boom' },
      },
    };
    expect(isMcpAppLifecycleMessage(msg)).toBe(true);
  });

  it('accepts a disconnected envelope', () => {
    const msg: McpAppLifecycleMessage = {
      type: 'ggui:lifecycle',
      event: { state: 'disconnected' },
    };
    expect(isMcpAppLifecycleMessage(msg)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['primitive string', 'ggui:lifecycle'],
    ['primitive number', 7],
    ['empty object', {}],
    ['wrong type tag', { type: 'ggui:other', event: { state: 'mounting' } }],
    ['missing event', { type: 'ggui:lifecycle' }],
    ['null event', { type: 'ggui:lifecycle', event: null }],
    ['missing state', { type: 'ggui:lifecycle', event: {} }],
    ['unknown state', { type: 'ggui:lifecycle', event: { state: 'spinning' } }],
    ['empty sessionId', { type: 'ggui:lifecycle', event: { state: 'mounting', sessionId: '' } }],
    ['non-string sessionId', { type: 'ggui:lifecycle', event: { state: 'mounting', sessionId: 7 } }],
    ['null error object', { type: 'ggui:lifecycle', event: { state: 'error', error: null } }],
    ['error missing code', { type: 'ggui:lifecycle', event: { state: 'error', error: { message: 'x' } } }],
    ['error missing message', { type: 'ggui:lifecycle', event: { state: 'error', error: { code: 'X' } } }],
  ])('rejects %s', (_label, input) => {
    expect(isMcpAppLifecycleMessage(input)).toBe(false);
  });
});

describe('McpAppLifecycleEvent shape lock', () => {
  // Producers MUST not add fields beyond `state`, `sessionId`,
  // `error`. Adding a key to this list is a protocol change — the
  // failing test forces a doc revision.
  it('a fully-populated event carries exactly state + sessionId + error', () => {
    const event: McpAppLifecycleEvent = {
      state: 'error',
      sessionId: 'item_a',
      error: { code: 'WS_HANDSHAKE_FAILED', message: 'boom' },
    };
    const keys = Object.keys(event).sort();
    expect(keys).toEqual(['error', 'sessionId', 'state']);
  });
});

describe('Gesture-audit envelope (ggui_runtime_submit_action input contract)', () => {
  it('exports the three canonical gesture kinds in SUBMIT_ACTION_KINDS', () => {
    expect(SUBMIT_ACTION_KINDS).toEqual([
      'dispatch',
      'openLink',
      'requestDisplayMode',
    ]);
  });

  it('SubmitActionKind permits the three primary kinds + an extension slot', () => {
    const _ok1: SubmitActionKind = 'dispatch';
    const _ok2: SubmitActionKind = 'openLink';
    const _ok3: SubmitActionKind = 'requestDisplayMode';
    // extension slot accepts any string — pre-launch forward-compat.
    const _ext: SubmitActionKind = 'futureSubmitActionKind';
    expect([_ok1, _ok2, _ok3, _ext]).toHaveLength(4);
  });

  describe('isGguiSubmitActionInput type guard', () => {
    const baseFields = {
      sessionId: 'r_1',
      appId: 'app_1',
      actionId: 'a3f2b1d4',
      firedAt: '2026-05-07T10:00:00.000Z',
    };

    it('accepts a well-formed dispatch envelope', () => {
      const env: GguiSubmitActionInput = {
        ...baseFields,
        kind: 'dispatch',
        payload: {
          intent: 'submit',
          actionData: { title: 'x' },
          uiContext: { draft: '' },
        },
      };
      expect(isGguiSubmitActionInput(env)).toBe(true);
    });

    it('accepts a dispatch envelope with null actionData (bare button click)', () => {
      const env: GguiSubmitActionInput = {
        ...baseFields,
        kind: 'dispatch',
        payload: { intent: 'submit', actionData: null, uiContext: {} },
      };
      expect(isGguiSubmitActionInput(env)).toBe(true);
    });

    it('accepts a well-formed openLink envelope', () => {
      expect(
        isGguiSubmitActionInput({
          ...baseFields,
          kind: 'openLink',
          payload: { url: 'https://example.com' },
        }),
      ).toBe(true);
    });

    it('accepts a well-formed requestDisplayMode envelope', () => {
      expect(
        isGguiSubmitActionInput({
          ...baseFields,
          kind: 'requestDisplayMode',
          payload: { mode: 'fullscreen' },
        }),
      ).toBe(true);
    });

    it('accepts an unknown extension kind with any payload object', () => {
      // Extension-slot guard: structural envelope is valid, payload-shape
      // narrowing is the extension handler's responsibility.
      expect(
        isGguiSubmitActionInput({
          ...baseFields,
          kind: 'futureSubmitActionKind',
          payload: { whatever: 'goes here' },
        }),
      ).toBe(true);
    });

    it.each([
      ['null', null],
      ['non-object', 'string'],
      ['empty object', {}],
      ['missing kind', { ...baseFields, payload: {} }],
      ['missing sessionId', { kind: 'dispatch', appId: 'a', actionId: 'i', firedAt: 't', payload: { intent: 's', actionData: null, uiContext: {} } }],
      ['missing actionId', { ...baseFields, kind: 'dispatch', payload: { intent: 's', actionData: null, uiContext: {} }, actionId: '' }],
      [
        'dispatch with empty intent',
        { ...baseFields, kind: 'dispatch', payload: { intent: '', actionData: null, uiContext: {} } },
      ],
      [
        'dispatch missing actionData',
        { ...baseFields, kind: 'dispatch', payload: { intent: 'submit', uiContext: {} } },
      ],
      [
        'dispatch with array uiContext',
        { ...baseFields, kind: 'dispatch', payload: { intent: 'submit', actionData: null, uiContext: [] } },
      ],
      [
        'dispatch with null uiContext',
        { ...baseFields, kind: 'dispatch', payload: { intent: 'submit', actionData: null, uiContext: null } },
      ],
      [
        'openLink with non-string url',
        { ...baseFields, kind: 'openLink', payload: { url: 42 } },
      ],
      [
        'requestDisplayMode with missing mode',
        { ...baseFields, kind: 'requestDisplayMode', payload: {} },
      ],
    ])('rejects %s', (_label, value) => {
      expect(isGguiSubmitActionInput(value)).toBe(false);
    });
  });
});

describe('GguiUserActionMeta — single pure-doorbell shape lock', () => {
  // There is NO runtime guard for this slice (deleted in #290): the
  // actionable directive lives in the iframe-authored `ui/message`
  // TEXT that every host forwards to the model, and the backend is a
  // pure prompt-forwarder with zero ggui knowledge. This `_meta` slice
  // is the OPTIONAL structured mirror for ggui-aware programmatic
  // consumers; the iframe-runtime constructs/types against this
  // interface. The test below locks the shape at the type level.
  it('is a pure pointer — single kind, ggui_consume nextStep, no payload', () => {
    const meta: GguiUserActionMeta = {
      kind: 'user-action',
      description:
        'The user interacted with render r_1. Call ggui_consume to retrieve it.',
      sessionId: 'r_1',
      actionId: '8f3a2b1c',
      submittedAt: '2026-05-14T00:00:00.000Z',
      intent: 'toggle',
      nextStep: { tool: 'ggui_consume', args: { sessionId: 'r_1' } },
    };
    expect(meta.kind).toBe('user-action');
    expect(meta.nextStep.tool).toBe('ggui_consume');
    expect(meta.nextStep.args.sessionId).toBe('r_1');
    // The slice carries no action payload — pointer only. (A `payload`
    // key would be a compile error against the interface; this runtime
    // assertion documents the absence for readers.)
    expect('payload' in meta).toBe(false);
  });
});

// =============================================================================
// Phase B render-identity collapse — single `ai.ggui/render` slice carries
// everything (identity, boot wiring, live-channel auth, capability
// advertisements, render state, contract pointer, component-mode
// discriminator).
// =============================================================================

describe('parseMcpAppAiGguiRenderMeta', () => {
  const minimalRender: McpAppAiGguiRenderMeta = {
    sessionId: 'r-1',
    appId: 'app-1',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  };

  it('returns ok with no meta when no recognized key is present', () => {
    // Absent key is NOT a failure — the downstream `validateMeta` step
    // enforces presence per consumer.
    const a = parseMcpAppAiGguiRenderMeta({});
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.meta).toBeUndefined();
    const b = parseMcpAppAiGguiRenderMeta(null);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.meta).toBeUndefined();
  });

  it('returns MALFORMED_RENDER when slice is present but identity is missing', () => {
    const result = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: { sessionId: '', appId: 'a', runtimeUrl: '/r' },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_RENDER');
  });

  it('parses a minimal render slice', () => {
    const result = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: minimalRender,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toEqual(minimalRender);
    }
  });

  it('parses a fully-populated render slice with auth + render state + contract pointer', () => {
    const result = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: {
        ...minimalRender,
        wsUrl: 'ws://x',
        wsToken: 't',
        expiresAt: '9999-12-31T23:59:59.999Z',
        themeId: 'indigo',
        themeMode: 'dark',
        appCallableTools: ['ggui_runtime_submit_action'],
        propsJson: '{}',
        contractHash: 'sha256:abc',
        validatorsUrl: '/contract/sha256:abc.js',
        kind: 'loading',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.sessionId).toBe('r-1');
      expect(result.meta?.wsUrl).toBe('ws://x');
      expect(result.meta?.wsToken).toBe('t');
      expect(result.meta?.contractHash).toBe('sha256:abc');
      expect(result.meta?.kind).toBe('loading');
    }
  });

  it('rejects half-live auth (wsUrl without wsToken)', () => {
    const result = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: { ...minimalRender, wsUrl: 'ws://x' },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_RENDER');
  });

  it('rejects slice with both kind and codeUrl (mutually exclusive)', () => {
    const result = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: {
        ...minimalRender,
        kind: 'loading',
        codeUrl: '/code/sha256:abc.js',
      },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_RENDER');
  });

  it('drops a malformed contract pair silently (degrades to no validators)', () => {
    const result = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: {
        ...minimalRender,
        contractHash: 'h' /* no validatorsUrl */,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.contractHash).toBeUndefined();
      expect(result.meta?.validatorsUrl).toBeUndefined();
    }
  });

  it('rejects lastSequence that is non-integer / negative', () => {
    const a = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: { ...minimalRender, lastSequence: -1 },
    });
    expect(a.ok ? null : a.reason).toBe('MALFORMED_RENDER');
    const b = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: { ...minimalRender, lastSequence: 1.5 },
    });
    expect(b.ok ? null : b.reason).toBe('MALFORMED_RENDER');
  });
});

describe('parseMcpAppAiGguiHostSessionMeta', () => {
  it('returns ok with no hostSession for empty / null meta', () => {
    expect(parseMcpAppAiGguiHostSessionMeta({})).toEqual({ ok: true });
    expect(parseMcpAppAiGguiHostSessionMeta(null)).toEqual({ ok: true });
    expect(parseMcpAppAiGguiHostSessionMeta(undefined)).toEqual({ ok: true });
  });

  it('returns ok with no hostSession when the key is absent (opt-out path)', () => {
    // Other unrecognized keys are ignored — the parser is namespace-scoped.
    const result = parseMcpAppAiGguiHostSessionMeta({
      'unrelated/key': { whatever: true },
    });
    expect(result).toEqual({ ok: true });
  });

  it('parses a well-formed host-session slice', () => {
    const slice: McpAppAiGguiHostSessionMeta = {
      hostName: 'sample',
      hostSessionId: 'chat-abc-123',
    };
    const result = parseMcpAppAiGguiHostSessionMeta({
      [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: slice,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hostSession).toEqual(slice);
  });

  it('rejects a non-object slice value', () => {
    const r1 = parseMcpAppAiGguiHostSessionMeta({
      [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: 'not-an-object',
    });
    expect(r1.ok ? null : r1.reason).toBe('MALFORMED_HOST_SESSION');
    const r2 = parseMcpAppAiGguiHostSessionMeta({
      [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: ['array', 'is', 'not', 'object'],
    });
    expect(r2.ok ? null : r2.reason).toBe('MALFORMED_HOST_SESSION');
    const r3 = parseMcpAppAiGguiHostSessionMeta({
      [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: null,
    });
    expect(r3.ok ? null : r3.reason).toBe('MALFORMED_HOST_SESSION');
  });

  it('rejects when hostName is missing / empty / wrong type', () => {
    for (const bad of [undefined, '', 42, null]) {
      const result = parseMcpAppAiGguiHostSessionMeta({
        [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: {
          hostName: bad,
          hostSessionId: 'chat-abc',
        },
      });
      expect(result.ok ? null : result.reason).toBe('MALFORMED_HOST_SESSION');
    }
  });

  it('rejects when hostSessionId is missing / empty / wrong type', () => {
    for (const bad of [undefined, '', 42, null]) {
      const result = parseMcpAppAiGguiHostSessionMeta({
        [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: {
          hostName: 'sample',
          hostSessionId: bad,
        },
      });
      expect(result.ok ? null : result.reason).toBe('MALFORMED_HOST_SESSION');
    }
  });

  it('uses the spec-canonical key spelling', () => {
    // Locks the wire string — hosts hard-code this; renaming breaks them.
    expect(MCP_APP_AI_GGUI_HOST_SESSION_META_KEY).toBe('ai.ggui/host-session');
  });
});

describe('toMcpAppEnvelope', () => {
  it('emits the single render key', () => {
    const out = toMcpAppEnvelope({
      sessionId: 'r', appId: 'a', runtimeUrl: '/r',
    });
    expect(out[MCP_APP_AI_GGUI_RENDER_META_KEY]).toBeDefined();
    expect(Object.keys(out)).toEqual([MCP_APP_AI_GGUI_RENDER_META_KEY]);
  });
});

describe('emit ⇔ parse round-trip', () => {
  it('preserves the typed render slice across emit → parse', () => {
    const meta: McpAppAiGguiRenderMeta = {
      sessionId: 'r-1',
      appId: 'app-1',
      runtimeUrl: '/_ggui/iframe-runtime.js',
      pollingUrl: '/api/sessions/r-1/events',
      themeId: 'indigo',
      themeMode: 'dark',
      wsUrl: 'ws://localhost:8080/ws',
      wsToken: 'btk.sig',
      expiresAt: '9999-12-31T23:59:59.999Z',
      appCallableTools: ['ggui_runtime_submit_action'],
      propsJson: '{"x":1}',
      actionNextSteps: { archive: 'gmail_archive' },
      kind: 'loading',
      contractHash: 'sha256:abc',
      validatorsUrl: '/contract/sha256:abc.js',
    };
    const wire = toMcpAppEnvelope(meta);
    expect(wire[MCP_APP_AI_GGUI_RENDER_META_KEY]).toBeDefined();
    const parsed = parseMcpAppAiGguiRenderMeta(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta).toEqual(meta);
  });
});
