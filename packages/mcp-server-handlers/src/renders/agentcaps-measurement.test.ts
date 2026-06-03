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

  it("defaults to the authored phase — bare [ggui:agentcaps] tag (no :effective)", () => {
    const write = vi.fn();
    emitAgentCaps(contract, { enabled: true, write });
    const lines = write.mock.calls.map((c) => String(c[0]));
    expect(lines.every((l) => l.startsWith('[ggui:agentcaps]'))).toBe(true);
    expect(lines.some((l) => l.includes('[ggui:agentcaps:effective]'))).toBe(false);
  });

  it("phase:'effective' prefixes each line with [ggui:agentcaps:effective]", () => {
    const write = vi.fn();
    emitAgentCaps(contract, { enabled: true, phase: 'effective', write });
    expect(write).toHaveBeenCalledTimes(2);
    const lines = write.mock.calls.map((c) => String(c[0]));
    // Every line carries the effective tag (NOT the bare authored tag).
    expect(lines.every((l) => l.startsWith('[ggui:agentcaps:effective]'))).toBe(true);
    // The per-tool measurement payload is unchanged from the authored shape.
    expect(
      lines.some(
        (l) => l.includes('tool=todo_add') && l.includes('serverInfo.name=todo'),
      ),
    ).toBe(true);
  });

  it("phase:'authored' is explicitly equivalent to the default tag", () => {
    const write = vi.fn();
    emitAgentCaps(contract, { enabled: true, phase: 'authored', write });
    const lines = write.mock.calls.map((c) => String(c[0]));
    expect(lines.every((l) => l.startsWith('[ggui:agentcaps]'))).toBe(true);
    expect(lines.some((l) => l.includes('[ggui:agentcaps:effective]'))).toBe(false);
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
