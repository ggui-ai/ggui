/**
 * `matchesMcpToolFilters` unit tests — one case per row of the
 * search-filter semantics table (MCP discovery spec §2).
 */
import { describe, expect, it } from 'vitest';
import { matchesMcpToolFilters } from './mcp-tool-filters.js';
import type { McpToolBinding } from '@ggui-ai/artifact-manifest';

const BINDINGS: ReadonlyArray<McpToolBinding> = [
  { server: 'weather-server', tool: 'get_weather' },
  { tool: 'get_forecast' },
  { server: 'other-server', tool: 'get_forecast' },
];

describe('matchesMcpToolFilters', () => {
  it('matches everything when no filter is set', () => {
    expect(matchesMcpToolFilters(BINDINGS, {})).toBe(true);
    expect(matchesMcpToolFilters(undefined, {})).toBe(true);
    expect(matchesMcpToolFilters([], {})).toBe(true);
  });

  it('tool-only matches any entry with that tool name, with or without a server', () => {
    expect(matchesMcpToolFilters(BINDINGS, { tool: 'get_weather' })).toBe(true);
    expect(matchesMcpToolFilters(BINDINGS, { tool: 'get_forecast' })).toBe(true);
    expect(matchesMcpToolFilters(BINDINGS, { tool: 'get_alerts' })).toBe(false);
  });

  it('server-only matches entries declaring that server; bare entries never match', () => {
    expect(matchesMcpToolFilters(BINDINGS, { server: 'weather-server' })).toBe(true);
    expect(matchesMcpToolFilters([{ tool: 'get_forecast' }], { server: 'weather-server' })).toBe(
      false,
    );
    expect(matchesMcpToolFilters(BINDINGS, { server: 'unknown-server' })).toBe(false);
  });

  it('tool+server matches only an entry with exactly that pair', () => {
    expect(matchesMcpToolFilters(BINDINGS, { server: 'weather-server', tool: 'get_weather' })).toBe(
      true,
    );
    // Cross product of independently-present values is NOT enough:
    // get_forecast exists, weather-server exists, no entry pairs them.
    expect(
      matchesMcpToolFilters(BINDINGS, { server: 'weather-server', tool: 'get_forecast' }),
    ).toBe(false);
  });

  it('is case-sensitive exact on both dimensions', () => {
    expect(matchesMcpToolFilters(BINDINGS, { tool: 'Get_Weather' })).toBe(false);
    expect(matchesMcpToolFilters(BINDINGS, { server: 'Weather-Server' })).toBe(false);
  });

  it('never matches artifacts without bindings when a filter is set', () => {
    expect(matchesMcpToolFilters(undefined, { tool: 'get_weather' })).toBe(false);
    expect(matchesMcpToolFilters([], { tool: 'get_weather' })).toBe(false);
    expect(matchesMcpToolFilters(undefined, { server: 'weather-server' })).toBe(false);
  });
});
