/**
 * A first-party server never chooses a JSON-RPC error code the MCP SDK
 * already owns — least of all one the SDK mints LOCALLY on the client
 * (ggui#836 for -32000 ConnectionClosed; ggui#853 for -32001
 * RequestTimeout): a client reading the number could not tell the
 * server's state from its own transport failure. The five JSON-RPC
 * standard codes are the exception by construction — ggui re-exports
 * the standard, and those MUST equal the SDK's. Pinned so the next
 * collision reds the build instead of a prod log.
 */
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { MCP_ERROR_CODES, PLATFORM_ERROR_CODES } from './mcp.js';

/** JSON-RPC 2.0's own codes — shared with every implementation on purpose. */
const JSON_RPC_STANDARD = new Set([-32700, -32600, -32601, -32602, -32603]);

const sdkCodes = new Set(
  Object.values(ErrorCode).filter((value): value is number => typeof value === 'number'),
);
const sdkOwned = [...sdkCodes].filter((code) => !JSON_RPC_STANDARD.has(code));

const gguiChosen = [
  ...Object.entries(MCP_ERROR_CODES).filter(([, code]) => !JSON_RPC_STANDARD.has(code)),
  ...Object.entries(PLATFORM_ERROR_CODES),
];

describe('ggui-chosen error codes never collide with codes the MCP SDK owns (ggui#853)', () => {
  it('the SDK enum is the set it claims to be (guard against an empty import)', () => {
    expect(sdkCodes.has(-32000)).toBe(true); // ConnectionClosed — client-local
    expect(sdkCodes.has(-32001)).toBe(true); // RequestTimeout — client-local
    expect(sdkOwned.length).toBeGreaterThanOrEqual(2);
  });

  it("ggui's copies of the five JSON-RPC standard codes equal the SDK's", () => {
    for (const code of JSON_RPC_STANDARD) expect(sdkCodes.has(code)).toBe(true);
    expect(
      Object.values(MCP_ERROR_CODES).filter((code) => JSON_RPC_STANDARD.has(code)).sort(),
    ).toEqual([...JSON_RPC_STANDARD].sort());
  });

  it('no ggui-chosen code is a number the SDK owns', () => {
    const collisions = gguiChosen.filter(([, code]) => sdkCodes.has(code));
    expect(collisions).toEqual([]);
  });
});
