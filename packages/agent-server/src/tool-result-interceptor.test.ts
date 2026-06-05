import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  interceptToolResult,
  selectMcpServerForResource,
} from './tool-result-interceptor.js';
import type { NormalizedMessage } from './types.js';

const TOOL_RESULT_WITH_URI: NormalizedMessage = {
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [{ type: 'text', text: 'rendered' }],
      },
    ],
  },
  tool_use_result: {
    content: [{ type: 'text', text: 'rendered' }],
    structuredContent: { sessionId: 'r_1' },
    _meta: {
      ui: {
        resourceUri: 'ui://ggui/render/r_1',
        displayMode: 'inline',
      },
    },
  },
};

const TOOL_RESULT_NO_URI: NormalizedMessage = {
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu_2',
        content: [{ type: 'text', text: 'ok' }],
      },
    ],
  },
  tool_use_result: {
    content: [{ type: 'text', text: 'ok' }],
  },
};

const ASSISTANT_MSG: NormalizedMessage = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hi' }] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('selectMcpServerForResource', () => {
  const SERVERS = {
    ggui: { url: 'http://localhost:6781/mcp', bearer: 'dev' },
    todo: { url: 'http://localhost:6782/mcp', bearer: 'dev' },
  };

  it('matches the URI host against server keys when possible', () => {
    expect(selectMcpServerForResource('ui://todo/x/y', SERVERS)).toEqual(
      SERVERS.todo,
    );
  });

  it('falls back to `ggui` when host doesnt match', () => {
    expect(selectMcpServerForResource('ui://mystery/x', SERVERS)).toEqual(
      SERVERS.ggui,
    );
  });

  it('falls back to the first entry when neither match nor `ggui` exists', () => {
    expect(
      selectMcpServerForResource('ui://x', { foo: SERVERS.todo }),
    ).toEqual(SERVERS.todo);
  });

  it('returns undefined on empty server map', () => {
    expect(selectMcpServerForResource('ui://x', {})).toBeUndefined();
  });
});

describe('interceptToolResult', () => {
  const SERVERS = {
    ggui: { url: 'http://localhost:6781/mcp', bearer: 'dev' },
  };

  it('passes assistant messages through unchanged', async () => {
    const out = await interceptToolResult({
      message: ASSISTANT_MSG,
      mcpServers: SERVERS,
    });
    expect(out).toBe(ASSISTANT_MSG);
  });

  it('passes tool results without a resourceUri through unchanged', async () => {
    const out = await interceptToolResult({
      message: TOOL_RESULT_NO_URI,
      mcpServers: SERVERS,
    });
    expect(out).toBe(TOOL_RESULT_NO_URI);
  });

  it('inlines the resource under _meta.ui.resource on a hit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            contents: [
              {
                uri: 'ui://ggui/render/r_1',
                mimeType: 'text/html',
                text: '<html><body>hello</body></html>',
                _meta: {
                  ui: { csp: { connectDomains: ['http://localhost:6781'] } },
                },
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await interceptToolResult({
      message: TOOL_RESULT_WITH_URI,
      mcpServers: SERVERS,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (out.type !== 'user') throw new Error('expected user message');
    const ui = (out.tool_use_result?._meta as { ui: { resource: { text?: string; mimeType?: string } } } | undefined)?.ui;
    expect(ui?.resource?.text).toBe('<html><body>hello</body></html>');
    expect(ui?.resource?.mimeType).toBe('text/html');
  });

  it('leaves the original message untouched (immutability)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            contents: [
              {
                uri: 'ui://ggui/render/r_1',
                text: '<html></html>',
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const before = JSON.stringify(TOOL_RESULT_WITH_URI);
    await interceptToolResult({
      message: TOOL_RESULT_WITH_URI,
      mcpServers: SERVERS,
    });
    expect(JSON.stringify(TOOL_RESULT_WITH_URI)).toBe(before);
  });

  it('passes the message through on resources/read failure (logs + fail-honest)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { message: 'not found' },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const logs: string[] = [];
    const out = await interceptToolResult({
      message: TOOL_RESULT_WITH_URI,
      mcpServers: SERVERS,
      log: (line) => logs.push(line),
    });

    expect(out).toBe(TOOL_RESULT_WITH_URI);
    expect(logs.some((l) => l.includes('resources/read'))).toBe(true);
  });

  it('is idempotent — second pass with resource already inlined skips fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const alreadyInlined: NormalizedMessage = {
      type: 'user',
      message: { content: [] },
      tool_use_result: {
        _meta: {
          ui: {
            resourceUri: 'ui://ggui/render/r_1',
            resource: { uri: 'ui://ggui/render/r_1', text: '<x/>' },
          },
        },
      },
    };
    const out = await interceptToolResult({
      message: alreadyInlined,
      mcpServers: SERVERS,
    });
    expect(out).toBe(alreadyInlined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forceReinline re-fetches even when already inlined, overwriting with current state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            contents: [
              {
                uri: 'ui://ggui/render/r_1',
                mimeType: 'text/html',
                text: '<html>FRESH</html>',
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const stale: NormalizedMessage = {
      type: 'user',
      message: { content: [] },
      tool_use_result: {
        _meta: {
          ui: {
            resourceUri: 'ui://ggui/render/r_1',
            resource: {
              uri: 'ui://ggui/render/r_1',
              text: '<html>STALE</html>',
            },
          },
        },
      },
    };
    const out = await interceptToolResult({
      message: stale,
      mcpServers: SERVERS,
      forceReinline: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (out.type !== 'user') throw new Error('expected user message');
    const ui = (
      out.tool_use_result?._meta as
        | { ui: { resource: { text?: string } } }
        | undefined
    )?.ui;
    expect(ui?.resource?.text).toBe('<html>FRESH</html>');
  });
});
