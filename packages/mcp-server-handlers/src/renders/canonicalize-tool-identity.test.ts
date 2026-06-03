import { describe, it, expect } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { canonicalizeToolIdentity, type ToolIdentityCatalog } from './canonicalize-tool-identity.js';

const CATALOG: ToolIdentityCatalog = {
  todo_add: { name: '@ggui-samples/mcp-todo', version: '0.0.1' },
  todo_list: { name: '@ggui-samples/mcp-todo', version: '0.0.1' },
};

describe('canonicalizeToolIdentity', () => {
  it('overwrites an authored config-key serverInfo.name with the canonical name', () => {
    const c: DataContract = {
      agentCapabilities: {
        tools: { todo_add: { serverInfo: { name: 'todo' }, toolInfo: { inputSchema: { type: 'object', properties: {} } } } },
      },
    };
    const out = canonicalizeToolIdentity(c, CATALOG);
    expect(out.agentCapabilities?.tools.todo_add.serverInfo).toEqual({ name: '@ggui-samples/mcp-todo', version: '0.0.1' });
  });

  it('fills an omitted serverInfo from the catalog', () => {
    const c: DataContract = {
      agentCapabilities: { tools: { todo_list: { toolInfo: { inputSchema: { type: 'object', properties: {} } } } } },
    };
    const out = canonicalizeToolIdentity(c, CATALOG);
    expect(out.agentCapabilities?.tools.todo_list.serverInfo?.name).toBe('@ggui-samples/mcp-todo');
  });

  it('leaves a tool absent from the catalog untouched', () => {
    const c: DataContract = {
      agentCapabilities: { tools: { other_tool: { serverInfo: { name: 'x' }, toolInfo: { inputSchema: { type: 'object', properties: {} } } } } },
    };
    const out = canonicalizeToolIdentity(c, CATALOG);
    expect(out.agentCapabilities?.tools.other_tool.serverInfo).toEqual({ name: 'x' });
  });

  it('is a no-op when the catalog is empty or there are no agent tools', () => {
    const c: DataContract = { propsSpec: { properties: {} } };
    expect(canonicalizeToolIdentity(c, {})).toEqual(c);
    expect(canonicalizeToolIdentity(c, CATALOG)).toEqual(c);
  });

  it('does not mutate the input contract', () => {
    const c: DataContract = {
      agentCapabilities: { tools: { todo_add: { serverInfo: { name: 'todo' }, toolInfo: { inputSchema: { type: 'object', properties: {} } } } } },
    };
    const snapshot = JSON.parse(JSON.stringify(c));
    canonicalizeToolIdentity(c, CATALOG);
    expect(c).toEqual(snapshot);
  });
});
