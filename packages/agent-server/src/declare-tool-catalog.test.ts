/**
 * Unit tests for the cross-framework tool-catalog declaration:
 *
 *   - `toDeclarationCatalog` — pure projection of the canonical
 *     {@link AgentToolEntry} catalog (from `buildAgentCatalog`) down to
 *     the `{ bareToolName -> { name, version? } }` map the ggui tool
 *     `ggui_runtime_declare_tool_catalog` accepts. Entries with no
 *     `serverInfo` are omitted (no canonical identity to declare).
 *
 *   - `declareToolCatalog` — fires that map at ggui via an injectable
 *     `call` (defaults to the real `callMcpToolsCall`) on the agent's
 *     own ggui connection. Non-fatal: a transport / RPC failure is
 *     caught + logged, never thrown (Tier-2 fallback — the agent still
 *     works without canonicalization).
 *
 * No live MCP is needed: the `call` seam is stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentToolEntry } from '@ggui-ai/protocol';
import { declareToolCatalog, toDeclarationCatalog } from './declare-tool-catalog.js';

describe('toDeclarationCatalog', () => {
  it('projects each entry down to its serverInfo {name, version?}', () => {
    const catalog: Record<string, AgentToolEntry> = {
      todo_add: {
        serverInfo: { name: '@ggui-samples/mcp-todo', version: '0.0.1' },
        toolInfo: { inputSchema: { type: 'object', properties: {} }, description: 'add' },
      },
    };
    expect(toDeclarationCatalog(catalog)).toEqual({
      todo_add: { name: '@ggui-samples/mcp-todo', version: '0.0.1' },
    });
  });

  it('omits the `version` key entirely when the entry has no version', () => {
    const catalog: Record<string, AgentToolEntry> = {
      todo_add: {
        serverInfo: { name: '@ggui-samples/mcp-todo' },
        toolInfo: { inputSchema: { type: 'object' } },
      },
    };
    const out = toDeclarationCatalog(catalog);
    expect(out).toEqual({ todo_add: { name: '@ggui-samples/mcp-todo' } });
    // `.strict()` on the ggui-side schema rejects an explicit
    // `version: undefined`, so the key must be ABSENT, not undefined.
    expect(out.todo_add).not.toHaveProperty('version');
  });

  it('omits entries that have no serverInfo (no canonical identity to declare)', () => {
    const catalog: Record<string, AgentToolEntry> = {
      with_identity: {
        serverInfo: { name: '@x/srv', version: '1' },
        toolInfo: { inputSchema: { type: 'object' } },
      },
      no_identity: {
        toolInfo: { inputSchema: { type: 'object' } },
      },
    };
    const out = toDeclarationCatalog(catalog);
    expect(out).toEqual({ with_identity: { name: '@x/srv', version: '1' } });
    expect(out).not.toHaveProperty('no_identity');
  });

  it('returns an empty map for an empty catalog', () => {
    expect(toDeclarationCatalog({})).toEqual({});
  });
});

describe('declareToolCatalog', () => {
  const CATALOG: Record<string, AgentToolEntry> = {
    todo_add: {
      serverInfo: { name: '@ggui-samples/mcp-todo', version: '0.0.1' },
      toolInfo: { inputSchema: { type: 'object', properties: {} }, description: 'add' },
    },
  };

  it('calls ggui_runtime_declare_tool_catalog once on the ggui connection with the derived map', async () => {
    const call = vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} });

    await declareToolCatalog({
      ggui: { url: 'http://localhost:9999/mcp', bearer: 'dev' },
      catalog: CATALOG,
      call,
    });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith({
      url: 'http://localhost:9999/mcp',
      bearer: 'dev',
      name: 'ggui_runtime_declare_tool_catalog',
      arguments: {
        toolCatalog: { todo_add: { name: '@ggui-samples/mcp-todo', version: '0.0.1' } },
      },
    });
  });

  it('does not throw when the call rejects — logs instead (non-fatal, Tier-2 fallback)', async () => {
    const call = vi.fn().mockRejectedValue(new Error('mcp down'));
    const log = vi.fn();

    await expect(
      declareToolCatalog({
        ggui: { url: 'http://localhost:9999/mcp', bearer: 'dev' },
        catalog: CATALOG,
        call,
        log,
      }),
    ).resolves.toBeUndefined();

    expect(call).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/mcp down/);
  });

  it('does not throw when ggui returns a JSON-RPC error envelope — logs instead', async () => {
    const call = vi
      .fn()
      .mockResolvedValue({ jsonrpc: '2.0', id: 1, error: { message: 'bad catalog' } });
    const log = vi.fn();

    await expect(
      declareToolCatalog({
        ggui: { url: 'http://localhost:9999/mcp', bearer: 'dev' },
        catalog: CATALOG,
        call,
        log,
      }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/bad catalog/);
  });
});
