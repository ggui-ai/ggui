import { describe, it, expect, vi } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { classifyServerName, emitAgentCaps } from './agentcaps-measurement.js';

describe('classifyServerName', () => {
  const ctx = { realName: '@ggui-samples/mcp-todo', configKey: 'todo' };

  it('omitted when no serverInfo.name', () => {
    expect(classifyServerName(undefined, ctx)).toBe('omitted');
  });
  it('canonical when it matches the real initialize name', () => {
    expect(classifyServerName('@ggui-samples/mcp-todo', ctx)).toBe('canonical');
  });
  it('config-key when it matches the mcp__<server>__ prefix handle', () => {
    expect(classifyServerName('todo', ctx)).toBe('config-key');
  });
  it('fabricated when it is neither the real name nor the config key', () => {
    expect(classifyServerName('todo-mcp-server', ctx)).toBe('fabricated');
  });
});

describe('emitAgentCaps', () => {
  const contract: DataContract = {
    agentCapabilities: {
      tools: {
        todo_add: { serverInfo: { name: 'todo' }, toolInfo: { inputSchema: { type: 'object', properties: {} } } },
        todo_list: { toolInfo: { inputSchema: { type: 'object', properties: {} } } },
      },
    },
  };

  it('emits one [ggui:agentcaps] line per tool when the env flag is set', () => {
    const write = vi.fn();
    emitAgentCaps(contract, { enabled: true, write });
    expect(write).toHaveBeenCalledTimes(2);
    const lines = write.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('[ggui:agentcaps]') && l.includes('tool=todo_add') && l.includes('serverInfo.name=todo'))).toBe(true);
    expect(lines.some((l) => l.includes('tool=todo_list') && l.includes('serverInfo.name=-'))).toBe(true);
  });

  it('emits nothing when disabled (default)', () => {
    const write = vi.fn();
    emitAgentCaps(contract, { enabled: false, write });
    expect(write).not.toHaveBeenCalled();
  });

  it('emits nothing when there are no agent tools', () => {
    const write = vi.fn();
    emitAgentCaps({ propsSpec: { properties: {} } }, { enabled: true, write });
    expect(write).not.toHaveBeenCalled();
  });
});
