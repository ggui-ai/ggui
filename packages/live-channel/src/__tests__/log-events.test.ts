import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHANNEL_LOG_EVENTS } from '../index.js';

/**
 * The transports' log events are ONE list (#1383). A card's telemetry sends each name as a health event with no
 * detail, and a host that admits only a closed set of names checks against the same list. So the list must be a
 * reading of what the transports log: every `channel_*` literal in a transport source is on it, and every name on it
 * is logged somewhere. The `ChannelLogger` methods take the list's union, so a new literal in a logger call fails the
 * typecheck before it reaches this test; the scan pins the other direction (a listed name nothing logs).
 */
const SOURCES = ['registry.ts', 'ws-transport.ts', 'sse-transport.ts', 'polling-transport.ts'];

function loggedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of SOURCES) {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', file), 'utf8');
    for (const m of src.matchAll(/['"`](channel_[a-z_]+)['"`]/g)) names.add(m[1]!);
  }
  return names;
}

describe('CHANNEL_LOG_EVENTS', () => {
  it('names exactly the channel_* events the transports log', () => {
    expect([...loggedNames()].sort()).toEqual([...CHANNEL_LOG_EVENTS].sort());
  });

  it('has no duplicates', () => {
    expect(new Set(CHANNEL_LOG_EVENTS).size).toBe(CHANNEL_LOG_EVENTS.length);
  });
});
