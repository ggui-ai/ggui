/**
 * Contract: the server-level instructions presets state facts about tools,
 * and the tools' own descriptions are the source of those facts. Every
 * `ggui_*` name a preset mentions must be a registered tool on the booted
 * server's `tools/list`, and every fact a preset states about a tool must be
 * a substring the tool's description ALSO carries — so a renamed or retired
 * tool, or a reworded outcome vocabulary, reds the preset the same push
 * instead of drifting silently for an agent's whole session (ggui#845,
 * #803 leg 6). The fact list is the protocol's (co-signed on the issue).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGguiServer, type GguiServer } from './server.js';
import { MCP_INSTRUCTIONS_PRESETS } from './instructions-presets.js';

/** A fact both surfaces must carry verbatim, keyed by the tool it is about. */
interface PresetFact {
  readonly tool: string;
  readonly shared: ReadonlyArray<string>;
}
interface FactDrift {
  readonly tool: string;
  readonly fact: string;
}
interface PresetDrift {
  /** `ggui_*` names the preset uses that are not on `tools/list`. */
  readonly unknownTools: ReadonlyArray<string>;
  /** Facts the tool carries that the preset does not state. */
  readonly missingFromPreset: ReadonlyArray<FactDrift>;
  /** Facts the preset states that the tool's description no longer carries. */
  readonly missingFromTool: ReadonlyArray<FactDrift>;
}

/** A tool name as a preset spells it — `ggui_*` (the literal glob) does not match. */
const TOOL_NAME = /\bggui_[a-z0-9_]+\b/g;

function presetDrift(
  preset: string,
  toolsByName: ReadonlyMap<string, string>,
  facts: ReadonlyArray<PresetFact>,
): PresetDrift {
  const named = new Set(preset.match(TOOL_NAME) ?? []);
  const unknownTools = [...named].filter((name) => !toolsByName.has(name)).sort();
  const missingFromPreset: FactDrift[] = [];
  const missingFromTool: FactDrift[] = [];
  for (const { tool, shared } of facts) {
    const description = toolsByName.get(tool);
    if (description === undefined) {
      if (!unknownTools.includes(tool)) unknownTools.push(tool);
      continue;
    }
    for (const fact of shared) {
      if (!preset.includes(fact)) missingFromPreset.push({ tool, fact });
      if (!description.includes(fact)) missingFromTool.push({ tool, fact });
    }
  }
  return { unknownTools, missingFromPreset, missingFromTool };
}

const NO_DRIFT: PresetDrift = { unknownTools: [], missingFromPreset: [], missingFromTool: [] };

/**
 * The facts protocol co-signed on ggui#845 (issuecomment-5556084052), each
 * a literal BOTH surfaces carry verbatim. T-rows the ruling struck were
 * fixed on both surfaces before being pinned here; preset-only claims
 * (`_meta["ai.ggui/render"]`, `updated:false`) and the loop posture are
 * deliberately not pinned.
 */
const PRESET_FACTS: ReadonlyArray<PresetFact> = [
  {
    tool: 'ggui_render',
    shared: [
      // T1 / A7 — the three-outcome response; a refusal carries only `refusal`
      '`rendered` | `failed` | `refused`',
      'carries only `refusal`',
      // T3 — the refusal is five keys; `handshake: 'intact'` is REQUIRED
      "{code, message, fix, retry, handshake: 'intact'}",
      // T4 — the retry rule is by `retry` class; `fixBy` scopes only `after-fix`
      'an `after-fix` refusal is yours to retry only when its `fixBy` is `caller`',
      'a `later` refusal retries after the delay it names',
      // T2 — missing vs unknown handshakeId; since #880 the slug LEADS the wire
      // text (`HandshakeNotFoundError` is a `DomainError`), so the literal is
      // observable and pinned on both surfaces beside `not found`
      'call without `handshakeId` is rejected at input validation (-32602)',
      'not found',
      '`handshake_not_found`',
      // T6 — what consumes the handshake and what leaves it intact
      'a `rendered` or `failed` render consumes the handshake; a `refused` render or a recoverable validation error leaves it intact',
      // A13 — nextStep only with a non-empty actionSpec
      'non-empty actionSpec',
    ],
  },
  {
    tool: 'ggui_handshake',
    // T5 (the wire also admits optional top-level `forceCreate` — noted, not pinned); D1 — the two honest exceptions
    shared: [
      '{intent, blueprintDraft: {contract, variance?, generator?}}',
      'handshakeId',
      "`action: 'declined'`",
      'starting with `PARTIAL`',
    ],
  },
  {
    tool: 'ggui_consume',
    // T7 (optional `client` — noted, not pinned), T8 the seven-key entry, T9 the literal only, A12
    shared: [
      '{events, status}',
      '{type: "action", sessionId, intent, actionData, uiContext, actionId, firedAt}',
      'status:"expired"',
      '`timeout` is an integer in [0, 25] seconds (default 0',
    ],
  },
  {
    tool: 'ggui_get_session',
    // T10 + T11
    shared: [
      'variant',
      'id, appId, eventSequence, createdAt, lastActivityAt, expiresAt',
      'contextSnapshot',
      '(the last-known contextSpec values) when the render has one',
    ],
  },
  // A4 — the two mutation modes, pinned on `kind:` + the mode names, never the quote style
  { tool: 'ggui_amend', shared: ['kind:', 'replace', 'merge', 'RFC 7396'] },
  { tool: 'ggui_update', shared: ['kind:', 'replace', 'merge', 'RFC 7396'] },
  // D3 — list_sessions takes the host pair explicitly
  { tool: 'ggui_list_sessions', shared: ['`hostName` + `hostSessionId`'] },
];

/** The presets that explain the protocol (minimal is identity-only; off is empty). */
const PROTOCOL_PRESETS = ['default', 'aggressive', 'always'] as const;

describe('presetDrift — the detector itself', () => {
  const tools: ReadonlyMap<string, string> = new Map([
    ['ggui_render', 'READ `outcome` FIRST — one of `rendered` | `failed` | `refused`.'],
    ['ggui_consume', 'Returns `{events, status}`. Exit only when status:"expired".'],
  ]);
  const facts: ReadonlyArray<PresetFact> = [
    { tool: 'ggui_render', shared: ['`rendered` | `failed` | `refused`'] },
    { tool: 'ggui_consume', shared: ['{events, status}', 'status:"expired"'] },
  ];

  it('names a retired tool, a fact the preset dropped, and a fact the tool dropped — by line', () => {
    const stalePreset =
      'Call ggui_handshake_v1 first. ggui_render: outcome is one of `rendered` | `failed`. ' +
      'ggui_consume returns `{events, status}`; stop on status:"expired".';
    const staleTools = new Map(tools);
    staleTools.set('ggui_consume', 'Returns `{events, status}`. Exit when the session ends.');
    expect(presetDrift(stalePreset, staleTools, facts)).toEqual({
      unknownTools: ['ggui_handshake_v1'],
      missingFromPreset: [{ tool: 'ggui_render', fact: '`rendered` | `failed` | `refused`' }],
      missingFromTool: [{ tool: 'ggui_consume', fact: 'status:"expired"' }],
    });
  });

  it('reports a fact about a tool that is not registered as an unknown tool', () => {
    const preset =
      'ggui_render outcome is one of `rendered` | `failed` | `refused`; ' +
      'ggui_consume returns `{events, status}` until status:"expired".';
    expect(
      presetDrift(preset, tools, [...facts, { tool: 'ggui_amend', shared: ['in place'] }]),
    ).toEqual({ ...NO_DRIFT, unknownTools: ['ggui_amend'] });
  });

  it('a preset in agreement with the tools has no drift; `ggui_*` the glob is not a name', () => {
    const preset =
      'Every ggui_* tool: ggui_render outcome is one of `rendered` | `failed` | `refused`; ' +
      'ggui_consume returns `{events, status}` until status:"expired".';
    expect(presetDrift(preset, tools, facts)).toEqual(NO_DRIFT);
  });
});

describe('the instructions presets agree with the registered tool surface (ggui#845)', () => {
  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => silentLogger,
  };
  let server: GguiServer;
  let client: Client;
  let toolsByName: ReadonlyMap<string, string>;

  beforeAll(async () => {
    // The full render family on the data plane: render + handshake need
    // `mcpApps`; emit needs `renderChannel`. This is the surface a real
    // agent's `tools/list` sees after `initialize` carried the preset.
    server = createGguiServer({
      logger: silentLogger,
      renderChannel: true,
      mcpApps: { wsUrl: 'ws://localhost/ws' },
      wsTokenSecret: 'test-secret-for-presets-contract',
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('server.address() did not return AddressInfo');
    client = new Client({ name: 'presets-contract', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
        requestInit: { headers: { authorization: 'Bearer t' } },
      }),
    );
    const { tools } = await client.listTools();
    toolsByName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it.each(PROTOCOL_PRESETS)('the %s preset names only registered tools and restates their facts verbatim', (name) => {
    expect(presetDrift(MCP_INSTRUCTIONS_PRESETS[name], toolsByName, PRESET_FACTS)).toEqual(NO_DRIFT);
  });

  it('the minimal preset names no tool the server lacks', () => {
    expect(presetDrift(MCP_INSTRUCTIONS_PRESETS.minimal, toolsByName, []).unknownTools).toEqual([]);
  });
});
