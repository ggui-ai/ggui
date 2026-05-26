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
  MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY,
  MCP_APP_AI_GGUI_SESSION_META_KEY,
  MCP_APP_AI_GGUI_AUTH_META_KEY,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  MCP_APP_AI_GGUI_CONTRACT_META_KEY,
  MCP_APP_AI_GGUI_COMPONENT_META_KEY,
  MCP_APP_LIFECYCLE_STATES,
  SUBMIT_ACTION_KINDS,
  combineMcpAppAiGguiMeta,
  readMcpAppAiGguiContractMeta,
  splitBootstrapMeta,
  deriveContextName,
  hasPushBootstrapMeta,
  isGguiUserActionMeta,
  isMcpAppsStackItem,
  isMcpAppLifecycleMessage,
  isGguiSubmitActionInput,
  validateMcpAppsStackItem,
  type GguiBootstrapMeta,
  type McpAppLifecycleEvent,
  type McpAppLifecycleMessage,
  type McpAppLifecycleState,
  type McpAppsStackItem,
  type PushResultMeta,
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

describe('hasPushBootstrapMeta type guard', () => {
  const validBootstrap: GguiBootstrapMeta = {
    wsUrl: 'ws://localhost:8080/ws',
    token: 'btk.signature',
    expiresAt: '2026-05-01T00:00:00.000Z',
    sessionId: 'sess-1',
    appId: 'app-1',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  };
  const validMeta: PushResultMeta = {  [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: validBootstrap  };

  it('accepts a well-shaped PushResultMeta', () => {
    expect(hasPushBootstrapMeta(validMeta)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['primitive', 'string'],
    ['empty object', {}],
    ['missing ggui.bootstrap', {}],
    ['wsUrl not a string', {  [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, wsUrl: 123 }  }],
    ['token not a string', {  [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, token: null }  }],
    ['expiresAt not a string', {  [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, expiresAt: 0 }  }],
    ['sessionId missing', {  [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { wsUrl: 'w', token: 't', expiresAt: 'e', appId: 'a', runtimeUrl: '/_ggui/iframe-runtime.js' }  }],
    ['appId missing', {  [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { wsUrl: 'w', token: 't', expiresAt: 'e', sessionId: 's', runtimeUrl: '/_ggui/iframe-runtime.js' }  }],
    // C8 (2026-04-23) — runtimeUrl is load-bearing for thin-shell boot.
    ['runtimeUrl missing', {  [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { wsUrl: 'w', token: 't', expiresAt: 'e', sessionId: 's', appId: 'a' }  }],
    ['runtimeUrl not a string', {  [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, runtimeUrl: 42 }  }],
  ])('rejects %s', (_label, input) => {
    expect(hasPushBootstrapMeta(input)).toBe(false);
  });

  // Slice 1 (2026-05-07) — `appCallableTools` is OPTIONAL on the wire.
  // Legacy bootstraps without the field MUST still pass; well-typed
  // arrays of strings MUST pass; arrays containing non-strings MUST
  // fail (catches a producer that mistakenly serializes objects).
  it('accepts a bootstrap with a string[] appCallableTools', () => {
    const meta: PushResultMeta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          appCallableTools: ['ggui_runtime_submit_action', 'foo_tool'],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(true);
  });

  it('accepts a bootstrap with an empty appCallableTools array', () => {
    const meta = {
       [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, appCallableTools: [] } ,
    };
    expect(hasPushBootstrapMeta(meta)).toBe(true);
  });

  it('accepts a bootstrap WITHOUT appCallableTools (back-compat)', () => {
    // Pre-Slice-1 bootstrap — no appCallableTools field at all. Must
    // still pass; consumers default to `[]`.
    expect(hasPushBootstrapMeta(validMeta)).toBe(true);
  });

  it('rejects appCallableTools containing non-strings', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          appCallableTools: ['ok', 42, 'also_ok'],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('rejects appCallableTools that is not an array', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, appCallableTools: 'ggui_runtime_submit_action' },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  // Slice 2 (2026-05-07) — `actionNextSteps` is OPTIONAL on the wire.
  // Same back-compat + shape posture as `appCallableTools`: legacy
  // bootstraps without the field MUST still pass; well-typed
  // `Record<string, string>` MUST pass; records with non-string
  // values MUST fail.
  it('accepts a bootstrap with a Record<string, string> actionNextSteps', () => {
    const meta: PushResultMeta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          actionNextSteps: { archive: 'gmail_archive', send: 'gmail_send' },
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(true);
  });

  it('accepts a bootstrap with an empty actionNextSteps object', () => {
    const meta = {
       [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, actionNextSteps: {} } ,
    };
    expect(hasPushBootstrapMeta(meta)).toBe(true);
  });

  it('accepts a bootstrap WITHOUT actionNextSteps (back-compat)', () => {
    // Pre-Slice-2 bootstrap — no actionNextSteps field at all. Must
    // still pass; consumers default to `{}`.
    expect(hasPushBootstrapMeta(validMeta)).toBe(true);
  });

  it('rejects actionNextSteps containing non-string values', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          actionNextSteps: { archive: 'gmail_archive', invalid: 42 },
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('rejects actionNextSteps that is an array', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          actionNextSteps: ['archive', 'send'],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('rejects actionNextSteps that is null', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, actionNextSteps: null },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  // Slice 8 (2026-05-08) — `contextSlots` is OPTIONAL on the wire.
  // Each entry MUST carry non-empty `name`, non-empty `contextName`,
  // and an object `schema`. Optional `default` (any JsonValue) and
  // optional `debounceMs` (number) ride along.
  it('accepts a bootstrap with a well-shaped contextSlots array', () => {
    const meta: PushResultMeta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          contextSlots: [
            {
              name: 'currentStep',
              contextName: 'CurrentStepContext',
              schema: { type: 'number' },
              default: 0,
            },
            {
              name: 'draftText',
              contextName: 'DraftTextContext',
              schema: { type: 'string' },
              default: '',
              debounceMs: 500,
            },
          ],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(true);
  });

  it('accepts a bootstrap with an empty contextSlots array', () => {
    const meta = {
       [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, contextSlots: [] } ,
    };
    expect(hasPushBootstrapMeta(meta)).toBe(true);
  });

  it('accepts a bootstrap WITHOUT contextSlots (back-compat)', () => {
    expect(hasPushBootstrapMeta(validMeta)).toBe(true);
  });

  it('rejects contextSlots that is not an array', () => {
    const meta = {
       [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: { ...validBootstrap, contextSlots: {} } ,
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('rejects contextSlots entry missing name', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          contextSlots: [
            { contextName: 'XContext', schema: { type: 'number' } },
          ],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('rejects contextSlots entry with empty name', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          contextSlots: [
            { name: '', contextName: 'XContext', schema: { type: 'number' } },
          ],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('rejects contextSlots entry missing contextName', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          contextSlots: [
            { name: 'currentStep', schema: { type: 'number' } },
          ],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('rejects contextSlots entry missing schema', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          contextSlots: [
            { name: 'currentStep', contextName: 'CurrentStepContext' },
          ],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('rejects contextSlots entry with non-number debounceMs', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          contextSlots: [
            {
              name: 'currentStep',
              contextName: 'CurrentStepContext',
              schema: { type: 'number' },
              default: 0,
              debounceMs: 'fast',
            },
          ],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  // Slice 12 (2026-05-08) — `default` is now REQUIRED on every
  // contextSlots entry. The runtime owns useState per slot; a missing
  // Provider seed would force the runtime to silently fabricate one.
  it('rejects contextSlots entry missing default (Slice 12)', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          contextSlots: [
            {
              name: 'currentStep',
              contextName: 'CurrentStepContext',
              schema: { type: 'number' },
              // No `default` — should reject.
            },
          ],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(false);
  });

  it('accepts contextSlots entry with default: null (literal null is a JsonValue)', () => {
    const meta = {
      
        [MCP_APP_AI_GGUI_BOOTSTRAP_META_KEY]: {
          ...validBootstrap,
          contextSlots: [
            {
              name: 'maybeNullable',
              contextName: 'MaybeNullableContext',
              schema: { type: 'object' },
              default: null,
            },
          ],
        },
    };
    expect(hasPushBootstrapMeta(meta)).toBe(true);
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

describe('GguiBootstrapMeta structural lock', () => {
  // Intentional key-set enumeration — any addition or rename must
  // revisit the design-lock rule about structuredContent-vs-_meta
  // separation. GguiBootstrapMeta is the CANONICAL shape view code
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
    const meta: GguiBootstrapMeta = {
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

describe('non-leak lock: PushResultMeta is not structuredContent', () => {
  it('is imported via the integrations/mcp-apps subpath, not the root', () => {
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
// #109 — decomposed per-window meta keys (split / combine helpers).
// =============================================================================

describe('combineMcpAppAiGguiMeta', () => {
  const minimalSession = {
    sessionId: 'sess-1',
    appId: 'app-1',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  };

  it('returns MISSING_SESSION when no session slice is present', () => {
    expect(combineMcpAppAiGguiMeta({}).ok).toBe(false);
    expect(combineMcpAppAiGguiMeta(null).ok).toBe(false);
    const result = combineMcpAppAiGguiMeta({});
    expect(result.ok ? null : result.reason).toBe('MISSING_SESSION');
  });

  it('returns MALFORMED_SESSION when session is present but identity is missing', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: { sessionId: '', appId: 'a', runtimeUrl: '/r' },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_SESSION');
  });

  it('combines a session-only slice into a minimal bootstrap', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: minimalSession,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bootstrap).toEqual(minimalSession);
  });

  it('combines all five slices into the aggregated shape', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: {
        ...minimalSession,
        themeId: 'indigo',
        themeMode: 'dark',
        canvasMode: true,
      },
      [MCP_APP_AI_GGUI_AUTH_META_KEY]: {
        wsUrl: 'ws://x',
        token: 't',
        expiresAt: '9999-12-31T23:59:59.999Z',
      },
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: {
        stackItemId: 'st-1',
        propsJson: '{}',
        appCallableTools: ['ggui_runtime_submit_action'],
      },
      [MCP_APP_AI_GGUI_CONTRACT_META_KEY]: {
        contractHash: 'sha256:abc',
        validatorsUrl: '/contract/sha256:abc.js',
      },
      [MCP_APP_AI_GGUI_COMPONENT_META_KEY]: { kind: 'loading' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bootstrap.sessionId).toBe('sess-1');
      expect(result.bootstrap.wsUrl).toBe('ws://x');
      expect(result.bootstrap.token).toBe('t');
      expect(result.bootstrap.stackItemId).toBe('st-1');
      expect(result.bootstrap.kind).toBe('loading');
      expect(result.bootstrap.canvasMode).toBe(true);
    }
  });

  it('rejects half-live auth (wsUrl without token)', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: minimalSession,
      [MCP_APP_AI_GGUI_AUTH_META_KEY]: { wsUrl: 'ws://x' },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_AUTH');
  });

  it('rejects component slice with both kind and codeUrl', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: minimalSession,
      [MCP_APP_AI_GGUI_COMPONENT_META_KEY]: {
        kind: 'loading',
        codeUrl: '/code/sha256:abc.js',
      },
    });
    expect(result.ok ? null : result.reason).toBe('MALFORMED_COMPONENT');
  });

  it('intentionally ignores the contract slice (not assembled into bootstrap)', () => {
    const result = combineMcpAppAiGguiMeta({
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: minimalSession,
      [MCP_APP_AI_GGUI_CONTRACT_META_KEY]: {
        contractHash: 'sha256:abc',
        validatorsUrl: '/contract/sha256:abc.js',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bootstrap).not.toHaveProperty('compiledValidators');
  });
});

describe('readMcpAppAiGguiContractMeta', () => {
  it('returns null when the contract slice is absent', () => {
    expect(readMcpAppAiGguiContractMeta({})).toBeNull();
  });

  it('returns null for malformed contract slice', () => {
    expect(
      readMcpAppAiGguiContractMeta({
        [MCP_APP_AI_GGUI_CONTRACT_META_KEY]: { contractHash: 'h' },
      }),
    ).toBeNull();
  });

  it('returns {contractHash, validatorsUrl} on a well-shaped slice', () => {
    const out = readMcpAppAiGguiContractMeta({
      [MCP_APP_AI_GGUI_CONTRACT_META_KEY]: {
        contractHash: 'sha256:abc',
        validatorsUrl: '/contract/sha256:abc.js',
      },
    });
    expect(out).toEqual({
      contractHash: 'sha256:abc',
      validatorsUrl: '/contract/sha256:abc.js',
    });
  });
});

describe('splitBootstrapMeta', () => {
  it('emits the session slice with only present optional fields', () => {
    const out = splitBootstrapMeta({
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
    expect(out.auth).toBeUndefined();
    expect(out.render).toBeUndefined();
    expect(out.contract).toBeUndefined();
    expect(out.component).toBeUndefined();
  });

  it('emits auth slice when wsUrl+token are present together', () => {
    const out = splitBootstrapMeta({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      wsUrl: 'ws://x',
      token: 't',
    });
    expect(out.auth).toEqual({ wsUrl: 'ws://x', token: 't' });
  });

  it('emits render slice with present optional fields only', () => {
    const out = splitBootstrapMeta({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      stackItemId: 'st-1',
      propsJson: '{}',
    });
    expect(out.render).toEqual({ stackItemId: 'st-1', propsJson: '{}' });
  });

  it('emits contract slice only when opts.contract is provided', () => {
    const base = {
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
    };
    expect(splitBootstrapMeta(base).contract).toBeUndefined();
    const withContract = splitBootstrapMeta(base, {
      contract: {
        contractHash: 'sha256:abc',
        validatorsUrl: '/contract/sha256:abc.js',
      },
    });
    expect(withContract.contract).toEqual({
      contractHash: 'sha256:abc',
      validatorsUrl: '/contract/sha256:abc.js',
    });
  });

  it('emits component slice for static-component (codeUrl) and system-card (kind) modes', () => {
    const staticMode = splitBootstrapMeta({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      codeUrl: '/code/sha256:abc.js',
      codeHash: 'sha256:abc',
    });
    expect(staticMode.component).toEqual({
      codeUrl: '/code/sha256:abc.js',
      codeHash: 'sha256:abc',
    });
    const systemCard = splitBootstrapMeta({
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: '/r',
      kind: 'loading',
    });
    expect(systemCard.component).toEqual({ kind: 'loading' });
  });
});

describe('combine ⇔ split round-trip', () => {
  it('preserves a full bootstrap across split → emit → combine', () => {
    const bootstrap: GguiBootstrapMeta = {
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
    };
    const split = splitBootstrapMeta(bootstrap, {
      contract: {
        contractHash: 'sha256:abc',
        validatorsUrl: '/contract/sha256:abc.js',
      },
    });
    // Component slice has both kind and (absent) codeUrl — but bootstrap above
    // sets kind only; component must NOT also carry codeUrl.
    expect(split.component?.codeUrl).toBeUndefined();
    // Reconstruct a synthetic `_meta` from the slices and combine.
    const meta = {
      [MCP_APP_AI_GGUI_SESSION_META_KEY]: split.session,
      ...(split.auth ? { [MCP_APP_AI_GGUI_AUTH_META_KEY]: split.auth } : {}),
      ...(split.render ? { [MCP_APP_AI_GGUI_RENDER_META_KEY]: split.render } : {}),
      ...(split.contract ? { [MCP_APP_AI_GGUI_CONTRACT_META_KEY]: split.contract } : {}),
      ...(split.component
        ? { [MCP_APP_AI_GGUI_COMPONENT_META_KEY]: split.component }
        : {}),
    };
    const combined = combineMcpAppAiGguiMeta(meta);
    expect(combined.ok).toBe(true);
    if (combined.ok) expect(combined.bootstrap).toEqual(bootstrap);
    // contract slice flows through readContract, not combine.
    expect(readMcpAppAiGguiContractMeta(meta)).toEqual({
      contractHash: 'sha256:abc',
      validatorsUrl: '/contract/sha256:abc.js',
    });
  });
});
