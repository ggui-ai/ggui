/**
 * Scenario 4 — `ggui_runtime_sync_context` rejects oversize snapshots
 * with `code: 'CONTEXT_TOO_LARGE'`.
 *
 * PIPE-2 (2026-05-12) decision: contextSpec is observable state for
 * the agent, NOT content storage. Snapshots exceeding the bounds
 * REJECT (not truncate) so authors notice and route bulky data
 * through propsSpec / streamSpec / a tool call.
 *
 * Bounds enforced (from `@ggui-ai/protocol`):
 *   - `CONTEXT_SLOT_VALUE_MAX_BYTES` = 16 KB per slot value
 *   - `CONTEXT_SNAPSHOT_MAX_BYTES`   = 64 KB total snapshot
 *   - `CONTEXT_SNAPSHOT_MAX_SLOTS`   = 50 entries
 *
 * The handler runs the size gate BEFORE the render-existence check,
 * so this scenario does NOT need a real handshake/render — any non-empty
 * renderId/appId pair with an oversize snapshot trips the rejection
 * path. That's why this scenario runs without an LLM.
 */
import { describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';

const MCP_URL = `http://localhost:${process.env.GGUI_PORT ?? 6781}/mcp`;

function makeArgs(snapshot: Record<string, unknown>): Record<string, unknown> {
  return {
    renderId: 'rnd-fake-for-size-check',
    appId: 'builder',
    snapshot,
  };
}

describe('Scenario 4 — CONTEXT_TOO_LARGE rejection', () => {
  test('rejects per-slot value above 16 KB', async () => {
    const big = 'a'.repeat(17 * 1024); // 17 KB single string slot
    const resp = await callTool(
      MCP_URL,
      'ggui_runtime_sync_context',
      makeArgs({ blob: big }),
    );
    expect(resp.error).toBeUndefined();
    const structured = resp.result?.structuredContent as {
      ok: boolean;
      code?: string;
      message?: string;
    };
    expect(structured.ok).toBe(false);
    expect(structured.code).toBe('CONTEXT_TOO_LARGE');
    expect(structured.message ?? '').toMatch(/blob/);
  });

  test('rejects total snapshot above 64 KB (when each slot is under 16 KB)', async () => {
    // 5 × 15 KB = 75 KB total. Each slot under the per-slot cap.
    const fifteenKb = 'b'.repeat(15 * 1024);
    const snapshot: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) snapshot[`slot${i}`] = fifteenKb;

    const resp = await callTool(
      MCP_URL,
      'ggui_runtime_sync_context',
      makeArgs(snapshot),
    );
    expect(resp.error).toBeUndefined();
    const structured = resp.result?.structuredContent as {
      ok: boolean;
      code?: string;
      message?: string;
    };
    expect(structured.ok).toBe(false);
    expect(structured.code).toBe('CONTEXT_TOO_LARGE');
    expect(structured.message ?? '').toMatch(/total exceeds/);
  });

  test('rejects snapshot with more than 50 slots', async () => {
    const snapshot: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) snapshot[`s${i}`] = i;

    const resp = await callTool(
      MCP_URL,
      'ggui_runtime_sync_context',
      makeArgs(snapshot),
    );
    expect(resp.error).toBeUndefined();
    const structured = resp.result?.structuredContent as {
      ok: boolean;
      code?: string;
      message?: string;
    };
    expect(structured.ok).toBe(false);
    expect(structured.code).toBe('CONTEXT_TOO_LARGE');
    expect(structured.message ?? '').toMatch(/60 slots; max 50/);
  });
});
