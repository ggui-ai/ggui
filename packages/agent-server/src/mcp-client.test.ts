/**
 * Unit tests for the self-contained MCP client helpers — the
 * `initialize` / `tools/list` RPCs and the `buildAgentCatalog`
 * discovery pass that folds them into the canonical
 * `AgentToolEntry` catalog the agent stamps into its handshake draft.
 *
 * `global.fetch` is stubbed (same idiom as
 * `tool-result-interceptor.test.ts`) so no live MCP is needed; the
 * mocked-fetch path is the gate for the wire-shape contract. SSE-framed
 * responses are exercised too, since the real ggui MCP negotiates
 * `text/event-stream`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SERVER_CLIENT_VERSION,
  buildAgentCatalog,
  callMcpInitialize,
  callMcpToolsList,
} from './mcp-client.js';

describe('CLIENT_INFO version parity', () => {
  it('advertised clientInfo.version matches package.json', async () => {
    // The 0.4.0-rc.0 cut found this constant still at 0.3.0 with only a
    // "keep in sync with package.json" comment guarding it — the same
    // docstring-without-mechanism class as STDLIB_GADGETS_VERSION,
    // which DOES have a parity test and therefore failed the release
    // gate loudly. This is the missing mechanism for the client
    // identity every `initialize` advertises.
    const pkg = (await import('../package.json', {
      with: { type: 'json' },
    })) as { default: { version: string } };
    expect(AGENT_SERVER_CLIENT_VERSION).toBe(pkg.default.version);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(body: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const INIT_RESULT = {
  jsonrpc: '2.0',
  id: 1,
  result: { serverInfo: { name: '@x/todo', version: '0.0.1' } },
};

const TOOLS_RESULT = {
  jsonrpc: '2.0',
  id: 2,
  result: {
    tools: [
      {
        name: 'todo_add',
        inputSchema: { type: 'object', properties: {} },
        description: 'add',
      },
    ],
  },
};

describe('callMcpInitialize', () => {
  it('returns the serverInfo from the initialize result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(INIT_RESULT));
    vi.stubGlobal('fetch', fetchMock);

    const serverInfo = await callMcpInitialize({
      url: 'http://localhost:9999/mcp',
      bearer: 'dev',
    });

    expect(serverInfo).toEqual({ name: '@x/todo', version: '0.0.1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as { method: string };
    expect(sent.method).toBe('initialize');
  });

  it('parses an SSE-framed initialize response identically', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(INIT_RESULT));
    vi.stubGlobal('fetch', fetchMock);

    const serverInfo = await callMcpInitialize({
      url: 'http://localhost:9999/mcp',
      bearer: 'dev',
    });
    expect(serverInfo).toEqual({ name: '@x/todo', version: '0.0.1' });
  });

  it('throws on an RPC error envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      callMcpInitialize({ url: 'http://localhost:9999/mcp', bearer: 'dev' }),
    ).rejects.toThrow(/boom/);
  });

  it('throws when the result has no valid serverInfo {name, version}', async () => {
    // serverInfo present but missing `version` → not a valid identity.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: '@x/todo' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      callMcpInitialize({ url: 'http://localhost:9999/mcp', bearer: 'dev' }),
    ).rejects.toThrow(/serverInfo/);
  });
});

describe('callMcpToolsList', () => {
  it('returns the tools array from the tools/list result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(TOOLS_RESULT));
    vi.stubGlobal('fetch', fetchMock);

    const tools = await callMcpToolsList({
      url: 'http://localhost:9999/mcp',
      bearer: 'dev',
    });

    expect(tools).toEqual([
      {
        name: 'todo_add',
        inputSchema: { type: 'object', properties: {} },
        description: 'add',
      },
    ]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as { method: string };
    expect(sent.method).toBe('tools/list');
  });

  it('parses an SSE-framed tools/list response identically', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(TOOLS_RESULT));
    vi.stubGlobal('fetch', fetchMock);
    const tools = await callMcpToolsList({
      url: 'http://localhost:9999/mcp',
      bearer: 'dev',
    });
    expect(tools[0]?.name).toBe('todo_add');
  });

  it('throws when the result has no tools array', async () => {
    // result present but `tools` omitted (malformed / version-mismatched).
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 2, result: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      callMcpToolsList({ url: 'http://localhost:9999/mcp', bearer: 'dev' }),
    ).rejects.toThrow(/tools/);
  });
});

describe('buildAgentCatalog', () => {
  it('builds the NESTED AgentToolEntry catalog keyed by bare tool name', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const sent = JSON.parse(init.body as string) as { method: string };
      return Promise.resolve(
        sent.method === 'initialize'
          ? jsonResponse(INIT_RESULT)
          : jsonResponse(TOOLS_RESULT),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await buildAgentCatalog({
      todo: { url: 'http://localhost:9999/mcp', bearer: 'dev' },
    });

    expect(catalog).toEqual({
      todo_add: {
        serverInfo: { name: '@x/todo', version: '0.0.1' },
        toolInfo: {
          inputSchema: { type: 'object', properties: {} },
          description: 'add',
        },
      },
    });
  });

  it('omits description/outputSchema from toolInfo when the tool has none', async () => {
    const toolsNoDesc = {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [{ name: 'todo_bare', inputSchema: { type: 'object' } }],
      },
    };
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const sent = JSON.parse(init.body as string) as { method: string };
      return Promise.resolve(
        sent.method === 'initialize'
          ? jsonResponse(INIT_RESULT)
          : jsonResponse(toolsNoDesc),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await buildAgentCatalog({
      todo: { url: 'http://localhost:9999/mcp', bearer: 'dev' },
    });
    expect(catalog.todo_bare).toEqual({
      serverInfo: { name: '@x/todo', version: '0.0.1' },
      toolInfo: { inputSchema: { type: 'object' } },
    });
    expect(catalog.todo_bare?.toolInfo).not.toHaveProperty('description');
    expect(catalog.todo_bare?.toolInfo).not.toHaveProperty('outputSchema');
  });

  it('flags a duplicate bare tool name across servers and keeps the first', async () => {
    // server A → serverInfo @a, tool dup; server B → serverInfo @b, tool dup.
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string) as { method: string };
      const isA = url.includes('9001');
      if (sent.method === 'initialize') {
        return Promise.resolve(
          jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: {
              serverInfo: { name: isA ? '@a/srv' : '@b/srv', version: '1' },
            },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              {
                name: 'dup',
                inputSchema: { type: 'object' },
                description: isA ? 'from A' : 'from B',
              },
            ],
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const catalog = await buildAgentCatalog({
      a: { url: 'http://localhost:9001/mcp', bearer: 'dev' },
      b: { url: 'http://localhost:9002/mcp', bearer: 'dev' },
    });

    // First server (a) wins; the b entry is dropped with a warning.
    expect(catalog.dup?.serverInfo?.name).toBe('@a/srv');
    expect(catalog.dup?.toolInfo.description).toBe('from A');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('dup'))).toBe(
      true,
    );
  });
});

// ── ggui#405 — relay network-failure semantics ─────────────────────────────
//
// callMcpToolsCall only throws on network-level failures; HTTP error
// bodies parse into envelopes. Of the throw class, only provably
// PRE-SEND failures (DNS / connect-refused / connect-timeout) retry —
// the pending-event pipe does not dedupe on entry id, so an ambiguous
// mid-flight failure must never be replayed.

import { callMcpToolsCall, describeFetchError } from './mcp-client.js';

function networkError(code: string): TypeError {
  const cause = Object.assign(new Error(`connect ${code} 1.2.3.4:443`), {
    code,
  });
  return new TypeError('fetch failed', { cause });
}

describe('describeFetchError', () => {
  it('walks the cause chain collecting messages + codes', () => {
    const { message, codes } = describeFetchError(networkError('ECONNREFUSED'));
    expect(message).toBe('fetch failed ← connect ECONNREFUSED 1.2.3.4:443');
    expect(codes).toEqual(['ECONNREFUSED']);
  });
});

describe('callMcpToolsCall network-failure semantics', () => {
  const CALL = {
    url: 'https://pod.example/apps/x',
    bearer: 'k',
    name: 'ggui_runtime_submit_action',
    arguments: {},
  };

  it('retries a pre-send failure (ECONNREFUSED) and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(networkError('ECONNREFUSED'))
      .mockResolvedValue(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const rpc = await callMcpToolsCall(CALL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rpc.error).toBeUndefined();
  });

  it('does NOT retry an ambiguous mid-flight failure — throws with the cause chain', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError('terminated'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callMcpToolsCall(CALL)).rejects.toThrow(
      /tools\/call ggui_runtime_submit_action .* failed: terminated/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded retries and reports the attempt count', async () => {
    const fetchMock = vi.fn().mockRejectedValue(networkError('ENOTFOUND'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callMcpToolsCall(CALL)).rejects.toThrow(
      /failed after 3 attempts: fetch failed ← connect ENOTFOUND/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
