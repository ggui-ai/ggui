// ggui#1714 — the tool surface every Agent SDK query() in this package gets.
import { describe, expect, it } from 'vitest';
import { sdkToolPins } from './sdk-tool-pins.js';

describe('sdkToolPins (ggui#1714)', () => {
  it('by default: no built-ins, no host settings, every configured server approved by name', () => {
    expect(sdkToolPins({ mcpServers: { ggui: { type: 'stdio', command: 'node' } } })).toEqual({
      tools: [],
      settingSources: [],
      allowedTools: ['mcp__ggui'],
    });
  });

  it('an explicit allow-list replaces the server-wide default', () => {
    expect(sdkToolPins({ mcpServers: { ggui: { type: 'stdio', command: 'node' } }, allowedTools: ['mcp__ggui__compile_component'] }).allowedTools).toEqual([
      'mcp__ggui__compile_component',
    ]);
  });

  it('no servers and no allow-list approves nothing', () => {
    expect(sdkToolPins({})).toEqual({ tools: [], settingSources: [], allowedTools: [] });
  });

  it('built-ins are an opt-in, offered and approved together', () => {
    const pins = sdkToolPins({ allowedTools: ['mcp__ggui__x'], builtinTools: ['Write'] });
    expect(pins.tools).toEqual(['Write']);
    expect(pins.allowedTools).toEqual(['mcp__ggui__x', 'Write']);
  });
});
