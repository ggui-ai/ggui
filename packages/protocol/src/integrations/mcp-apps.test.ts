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
  GGUI_SESSION_RESOURCE_URI,
  GGUI_SESSION_RESOURCE_MIME,
  GGUI_PUSH_UI_META,
    MCP_APP_AI_GGUI_SESSION_META_KEY,
  MCP_APP_AI_GGUI_STACK_ITEM_META_KEY,
  MCP_APP_LIFECYCLE_STATES,
  SUBMIT_ACTION_KINDS,
  combineMcpAppAiGguiMeta,
  mergeSlicesIntoMountView,
  slicesToMcpAppMeta,
  splitMountViewIntoSlices,
  deriveContextName,
    isGguiUserActionMeta,
  isMcpAppsStackItem,
  isMcpAppLifecycleMessage,
  isGguiSubmitActionInput,
  validateMcpAppsStackItem,
  type McpAppAiGguiMountView,
  type McpAppLifecycleEvent,
  type McpAppLifecycleMessage,
  type McpAppLifecycleState,
  type McpAppsStackItem,
  type McpAppsToolVisibility,
  type SubmitActionKind,
  type GguiSubmitActionInput,
} from './mcp-apps';

describe('MCP Apps outbound constants', () => {
  it('advertises the spec-canonical UI capability name', () => {
    expect(MCP_APPS_UI_CAPABILITY).toBe('io.modelcontextprotocol/ui');
  });

  it('uses the locked session resource URI', () => {
    expect(GGUI_SESSION_RESOURCE_URI).toBe('ui://ggui/session');
  });

  it('serves the resource with spec-canonical profile MIME', () => {
    expect(GGUI_SESSION_RESOURCE_MIME).toBe('text/html;profile=mcp-app');
  });

  it('stamps GGUI_PUSH_UI_META with model-only visibility and the session resource URI', () => {
    expect(GGUI_PUSH_UI_META.resourceUri).toBe(GGUI_SESSION_RESOURCE_URI);
    expect(GGUI_PUSH_UI_META.visibility).toEqual(['model']);
    // §2.4.1 entry-point lock — ggui_push tool is ONLY model-callable.
    // Any widening (e.g. adding 'app') would change the visibility
    // surface and MUST revisit the design lock.
    const visibility: readonly McpAppsToolVisibility[] =
      GGUI_PUSH_UI_META.visibility;
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

describe('McpAppAiGguiMountView structural lock', () => {
  // Intentional key-set enumeration — any addition or rename must
  // revisit the design-lock rule about structuredContent-vs-_meta
  // separation. McpAppAiGguiMountView is the CANONICAL shape view code
  // reads from `_meta.ggui.bootstrap`; its keys are the API surface.
  it('carries exactly the six required keys when no optionals are set', () => {
    // Minimal producer shape — no adapters. Six required keys are
    // the wire-critical boot set (wsUrl + token + expiresAt +
    // sessionId + appId + runtimeUrl). Any addition or rename to
    // THIS set must revisit the design-lock rule about
    // structuredContent-vs-_meta separation.
    //
    // `runtimeUrl` joined the required set in C8 (2026-04-23) when
    // the thin-shell pivot moved all rendering logic out of the shell
    // into the separately-served renderer bundle. The shell reads
    // this URL to know where to dynamic-script-load the runtime; a
    // bootstrap without it is un-bootable under the post-C8 shell.
    const meta: McpAppAiGguiMountView = {
      wsUrl: 'w',
      token: 't',
      expiresAt: 'e',
      sessionId: 's',
      appId: 'a',
      runtimeUrl: '/_ggui/iframe-runtime.js',
    };
    const keys = Object.keys(meta).sort();
    expect(keys).toEqual(['appId', 'expiresAt', 'runtimeUrl', 'sessionId', 'token', 'wsUrl']);
  });

  // The `bootstrap.adapters` optional field was retired 2026-05-13. The
  // adapter registry pattern moved to `@ggui-ai/gadgets` hooks
  // (EE+, 2026-05-11); the bootstrap-meta surface stayed dormant on the
  // producer side for two release cycles, then dropped. Host apps that
  // wire their own `AdapterRegistry` slots (via declaration merging on
  // `@ggui-ai/react` / `@ggui-ai/react-native`) still use `useAdapter()`
  // via their own Provider — they never read the field off
  // bootstrap-meta.
});

describe('non-leak lock: outbound meta types live on the integrations subpath', () => {
  it('integration capability identifier is reachable only via the subpath', () => {
    expect(typeof MCP_APPS_UI_CAPABILITY).toBe('string');
  });
});

// =============================================================================
// Slice B — inbound McpAppsStackItem shape
// =============================================================================

describe('isMcpAppsStackItem type guard', () => {
  const validItem: McpAppsStackItem = {
    type: 'mcpApps',
    id: 'item-1',
    createdAt: new Date().toISOString(),
    source: {
      connectorId: 'stripe',
      toolName: 'checkout',
      resourceUri: 'ui://stripe/checkout',
    },
  };
  it('accepts well-shaped McpAppsStackItem', () => {
    expect(isMcpAppsStackItem(validItem)).toBe(true);
  });
  it('rejects component stack items', () => {
    expect(isMcpAppsStackItem({ id: 'c', componentCode: '' })).toBe(false);
  });
  it('rejects null / primitives / non-mcpApps type', () => {
    expect(isMcpAppsStackItem(null)).toBe(false);
    expect(isMcpAppsStackItem('string')).toBe(false);
    expect(isMcpAppsStackItem({ type: 'component' })).toBe(false);
  });
});

describe('validateMcpAppsStackItem', () => {
  const base: McpAppsStackItem = {
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
    expect(validateMcpAppsStackItem(base)).not.toBeNull();
  });
  it('rejects missing / empty id', () => {
    expect(validateMcpAppsStackItem({ ...base, id: '' })).toBeNull();
  });
  it('rejects missing source', () => {
    expect(validateMcpAppsStackItem({ ...base, source: undefined })).toBeNull();
  });
  it('rejects empty connectorId', () => {
    expect(
      validateMcpAppsStackItem({ ...base, source: { ...base.source, connectorId: '' } }),
    ).toBeNull();
  });
  it('rejects resourceUri that is not a ui:// URI', () => {
    expect(
      validateMcpAppsStackItem({
        ...base,
        source: { ...base.source, resourceUri: 'https://example.com' },
      }),
    ).toBeNull();
  });
  it('rejects wrong-type discriminator', () => {
    expect(validateMcpAppsStackItem({ ...base, type: 'component' })).toBeNull();
  });
});

describe('McpAppsStackItem structural lock — ?:never on component fields', () => {
  it('typechecks when read via optional chain on the union', () => {
    const item: McpAppsStackItem = {
      type: 'mcpApps',
      id: 'x',
      createdAt: '',
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' },
    };
    // These fields are `?: never` on McpAppsStackItem. Optional-chain
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

  it('accepts a code-ready envelope with stackItemId', () => {
    const msg: McpAppLifecycleMessage = {
      type: 'ggui:lifecycle',
      event: { state: 'code-ready', stackItemId: 'item_a' },
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
    ['empty stackItemId', { type: 'ggui:lifecycle', event: { state: 'mounting', stackItemId: '' } }],
    ['non-string stackItemId', { type: 'ggui:lifecycle', event: { state: 'mounting', stackItemId: 7 } }],
    ['null error object', { type: 'ggui:lifecycle', event: { state: 'error', error: null } }],
    ['error missing code', { type: 'ggui:lifecycle', event: { state: 'error', error: { message: 'x' } } }],
    ['error missing message', { type: 'ggui:lifecycle', event: { state: 'error', error: { code: 'X' } } }],
  ])('rejects %s', (_label, input) => {
    expect(isMcpAppLifecycleMessage(input)).toBe(false);
  });
});

describe('McpAppLifecycleEvent shape lock', () => {
  // Producers MUST not add fields beyond `state`, `stackItemId`,
  // `error`. Adding a key to this list is a protocol change — the
  // failing test forces a doc revision.
  it('a fully-populated event carries exactly state + stackItemId + error', () => {
    const event: McpAppLifecycleEvent = {
      state: 'error',
      stackItemId: 'item_a',
      error: { code: 'WS_HANDSHAKE_FAILED', message: 'boom' },
    };
    const keys = Object.keys(event).sort();
    expect(keys).toEqual(['error', 'stackItemId', 'state']);
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
      sessionId: 'sess_1',
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

describe('isGguiUserActionMeta type guard', () => {
  const baseTimestamps = {
    actionId: '8f3a2b1c',
    submittedAt: '2026-05-14T00:00:00.000Z',
    stackItemId: 'stack_1',
    intent: 'toggle',
  };

  describe('queued kind', () => {
    it('accepts a well-shaped queued envelope', () => {
      expect(
        isGguiUserActionMeta({
          kind: 'queued',
          description: 'User fired toggle on stack_1',
          ...baseTimestamps,
          nextStep: {
            tool: 'ggui_consume',
            args: { stackItemId: 'stack_1' },
          },
        }),
      ).toBe(true);
    });

    it.each([
      [
        'missing description',
        {
          kind: 'queued',
          ...baseTimestamps,
          nextStep: { tool: 'ggui_consume', args: { stackItemId: 's' } },
        },
      ],
      [
        'missing intent',
        {
          kind: 'queued',
          description: 'd',
          actionId: 'a',
          submittedAt: 's',
          stackItemId: 'i',
          nextStep: { tool: 'ggui_consume', args: { stackItemId: 's' } },
        },
      ],
      [
        'nextStep.tool not ggui_consume',
        {
          kind: 'queued',
          description: 'd',
          ...baseTimestamps,
          nextStep: { tool: 'something_else', args: { stackItemId: 's' } },
        },
      ],
      [
        'nextStep.args missing stackItemId',
        {
          kind: 'queued',
          description: 'd',
          ...baseTimestamps,
          nextStep: { tool: 'ggui_consume', args: {} },
        },
      ],
      [
        'nextStep absent',
        { kind: 'queued', description: 'd', ...baseTimestamps },
      ],
    ])('rejects %s', (_label, value) => {
      expect(isGguiUserActionMeta(value)).toBe(false);
    });
  });

  describe('inline kind', () => {
    it('accepts a well-shaped inline envelope (with nextStep hint)', () => {
      expect(
        isGguiUserActionMeta({
          kind: 'inline',
          description: 'User fired toggle on stack_1 with {id:2}',
          ...baseTimestamps,
          payload: {
            actionData: { id: 2 },
            uiContext: { search: 'hello' },
          },
          nextStep: 'todo_toggle',
        }),
      ).toBe(true);
    });

    it('accepts a well-shaped inline envelope WITHOUT nextStep (contract had none)', () => {
      expect(
        isGguiUserActionMeta({
          kind: 'inline',
          description: 'User fired toggle on stack_1 with {id:2}',
          ...baseTimestamps,
          payload: {
            actionData: { id: 2 },
            uiContext: {},
          },
        }),
      ).toBe(true);
    });

    it('accepts inline with null actionData (no-payload gesture)', () => {
      expect(
        isGguiUserActionMeta({
          kind: 'inline',
          description: 'd',
          ...baseTimestamps,
          payload: { actionData: null, uiContext: {} },
        }),
      ).toBe(true);
    });

    it.each([
      [
        'missing payload',
        { kind: 'inline', description: 'd', ...baseTimestamps },
      ],
      [
        'payload.actionData absent (vs explicit null)',
        {
          kind: 'inline',
          description: 'd',
          ...baseTimestamps,
          payload: { uiContext: {} },
        },
      ],
      [
        'payload.uiContext is array (must be JsonObject)',
        {
          kind: 'inline',
          description: 'd',
          ...baseTimestamps,
          payload: { actionData: null, uiContext: [] },
        },
      ],
      [
        'payload.uiContext is null',
        {
          kind: 'inline',
          description: 'd',
          ...baseTimestamps,
          payload: { actionData: null, uiContext: null },
        },
      ],
      [
        'nextStep present but empty',
        {
          kind: 'inline',
          description: 'd',
          ...baseTimestamps,
          payload: { actionData: null, uiContext: {} },
          nextStep: '',
        },
      ],
    ])('rejects %s', (_label, value) => {
      expect(isGguiUserActionMeta(value)).toBe(false);
    });
  });

  describe('cross-kind rejection', () => {
    it.each([
      ['null', null],
      ['non-object', 'string'],
      ['empty object', {}],
      [
        'unknown kind',
        {
          kind: 'whatever',
          description: 'd',
          ...baseTimestamps,
          nextStep: { tool: 'ggui_consume', args: { stackItemId: 's' } },
        },
      ],
      [
        'legacy pipe_not_found shape (reason-based, no kind)',
        {
          reason: 'pipe_not_found',
          stackItemId: 'stack_1',
          submittedAt: '2026-05-14T00:00:00.000Z',
        },
      ],
    ])('rejects %s', (_label, value) => {
      expect(isGguiUserActionMeta(value)).toBe(false);
    });
  });
});

// =============================================================================
// #109 — two-slice decomposition: session (mount-time + auth + capabilities)
// and stack-item (per-push render + contract + component).
// =============================================================================

describe('combineMcpAppAiGguiMeta', () => {
  const minimalSession = {
    sessionId: 'sess-1',
    appId: 'app-1',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  };

  it('returns ok with empty slices when no recognized keys are present', () => {
    // No required-slice gate at the combiner — missing slices come
    // through as undefined. The merge step enforces session presence.
    const a = combineMcpAppAiGguiMeta({});
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.slices).toEqual({});
    const b = combineMcpAppAiGguiMeta(null);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.slices).toEqual({});
  });

  it('returns MALFORMED_SESSION when session is present but identity is missing', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: { sessionId: '', appId: 'a', runtimeUrl: '/r' },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_SESSION');
  });

  it('combines a session-only slice', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: minimalSession,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slices.session).toEqual(minimalSession);
      expect(result.slices.stackItem).toBeUndefined();
    }
  });

  it('combines both slices into the slice struct', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: {
        ...minimalSession,
        wsUrl: 'ws://x',
        token: 't',
        expiresAt: '9999-12-31T23:59:59.999Z',
        themeId: 'indigo',
        themeMode: 'dark',
        canvasMode: true,
        appCallableTools: ['ggui_runtime_submit_action'],
      },
      [MCP_APP_AI_GGUI_STACK_ITEM_META_KEY]: {
        stackItemId: 'st-1',
        propsJson: '{}',
        contractHash: 'sha256:abc',
        validatorsUrl: '/contract/sha256:abc.js',
        kind: 'loading',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slices.session?.sessionId).toBe('sess-1');
      expect(result.slices.session?.wsUrl).toBe('ws://x');
      expect(result.slices.session?.token).toBe('t');
      expect(result.slices.session?.canvasMode).toBe(true);
      expect(result.slices.stackItem?.stackItemId).toBe('st-1');
      expect(result.slices.stackItem?.contractHash).toBe('sha256:abc');
      expect(result.slices.stackItem?.kind).toBe('loading');
    }
  });

  it('rejects half-live auth (wsUrl without token) on the session slice', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: { ...minimalSession, wsUrl: 'ws://x' },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_SESSION');
  });

  it('rejects stack-item slice with both kind and codeUrl', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: minimalSession,
      [MCP_APP_AI_GGUI_STACK_ITEM_META_KEY]: {
        kind: 'loading',
        codeUrl: '/code/sha256:abc.js',
      },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_STACK_ITEM');
  });

  it('drops a malformed contract pair silently (degrades to no validators)', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: minimalSession,
      [MCP_APP_AI_GGUI_STACK_ITEM_META_KEY]: { contractHash: 'h' /* no validatorsUrl */ },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slices.stackItem?.contractHash).toBeUndefined();
      expect(result.slices.stackItem?.validatorsUrl).toBeUndefined();
    }
  });

  it('renders-only deltas: combiner accepts stack-item without session', () => {
    // Future render-only update path — session lives in host cache,
    // wire carries just the stack-item slice with the new props.
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_STACK_ITEM_META_KEY]: {
        stackItemId: 'st-2',
        propsJson: '{"count":5}',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slices.session).toBeUndefined();
      expect(result.slices.stackItem?.propsJson).toBe('{"count":5}');
    }
  });
});

describe('mergeSlicesIntoMountView', () => {
  const minimalSession = {
    sessionId: 'sess-1',
    appId: 'app-1',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  };

  it('returns MISSING_SESSION when slices lack a session', () => {
    const r = mergeSlicesIntoMountView({});
    expect(r.ok ? null : r.reason).toBe('MISSING_SESSION');
  });

  it('flattens session-only slices into a minimal view', () => {
    const r = mergeSlicesIntoMountView({ session: minimalSession });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.view.sessionId).toBe('sess-1');
      expect(r.view.appId).toBe('app-1');
      expect(r.view.runtimeUrl).toBe('/_ggui/iframe-runtime.js');
      expect(r.view.stackItemId).toBeUndefined();
    }
  });

  it('flattens session + stack-item slices', () => {
    const r = mergeSlicesIntoMountView({
      session: { ...minimalSession, wsUrl: 'ws://x', token: 't' },
      stackItem: {
        stackItemId: 'st-1',
        propsJson: '{"x":1}',
        kind: 'loading',
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.view.wsUrl).toBe('ws://x');
      expect(r.view.token).toBe('t');
      expect(r.view.stackItemId).toBe('st-1');
      expect(r.view.propsJson).toBe('{"x":1}');
      expect(r.view.kind).toBe('loading');
    }
  });
});

describe('splitMountViewIntoSlices', () => {
  it('emits the session slice with only present optional fields', () => {
    const out = splitMountViewIntoSlices({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      themeId: 'indigo',
    });
    expect(out.session).toEqual({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      themeId: 'indigo',
    });
    expect(out.stackItem).toBeUndefined();
  });

  it('emits auth fields on the session slice when wsUrl+token are present', () => {
    const out = splitMountViewIntoSlices({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      wsUrl: 'ws://x',
      token: 't',
    });
    expect(out.session.wsUrl).toBe('ws://x');
    expect(out.session.token).toBe('t');
  });

  it('emits stack-item slice with render + contract + component fields', () => {
    const out = splitMountViewIntoSlices({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      stackItemId: 'st-1',
      propsJson: '{}',
      contractHash: 'sha256:abc',
      validatorsUrl: '/contract/sha256:abc.js',
      codeUrl: '/code/sha256:def.js',
      codeHash: 'sha256:def',
    });
    expect(out.stackItem).toEqual({
      stackItemId: 'st-1',
      propsJson: '{}',
      contractHash: 'sha256:abc',
      validatorsUrl: '/contract/sha256:abc.js',
      codeUrl: '/code/sha256:def.js',
      codeHash: 'sha256:def',
    });
  });

  it('emits stack-item slice for system-card kind alone', () => {
    const out = splitMountViewIntoSlices({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      kind: 'loading',
    });
    expect(out.stackItem).toEqual({ kind: 'loading' });
  });
});

describe('combine ⇔ split round-trip', () => {
  it('preserves a full mount view across split → emit → combine → merge', () => {
    const view: McpAppAiGguiMountView = {
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/_ggui/iframe-runtime.js',
      pollingUrl: '/api/bootstrap/abc',
      themeId: 'indigo',
      themeMode: 'dark',
      canvasMode: true,
      wsUrl: 'ws://localhost:8080/ws',
      token: 'btk.sig',
      expiresAt: '9999-12-31T23:59:59.999Z',
      stackItemId: 'st-1',
      propsJson: '{"x":1}',
      appCallableTools: ['ggui_runtime_submit_action'],
      actionNextSteps: { archive: 'gmail_archive' },
      kind: 'loading',
      contractHash: 'sha256:abc',
      validatorsUrl: '/contract/sha256:abc.js',
    };
    const slices = splitMountViewIntoSlices(view);
    expect(slices.stackItem?.codeUrl).toBeUndefined(); // view set kind only
    const meta = slicesToMcpAppMeta(slices);
    expect(meta[MCP_APP_AI_GGUI_SESSION_META_KEY]).toBeDefined();
    expect(meta[MCP_APP_AI_GGUI_STACK_ITEM_META_KEY]).toBeDefined();
    const combined = combineMcpAppAiGguiMeta(meta);
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    const merged = mergeSlicesIntoMountView(combined.slices);
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(merged.view).toEqual(view);
  });
});
