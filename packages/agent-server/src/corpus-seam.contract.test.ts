/**
 * Corpus seam contract (#426 Spec A): does agent-server's tool-result
 * seam recognize the `_meta.ui` bootstrap in REAL framework streams?
 * Stimulus: pinned cassettes (realism) + AgEvent-validated synthetics
 * (base). Oracle: ggui's own seam functions — never AgJSON validity.
 *
 * FIXTURES stability contract — asserted here: event types, tool-result
 * presence, scenario intent (which legs carry the ui bootstrap and how
 * many times, read machine-readably from the golden). NEVER asserted:
 * prose, ids, token counts, timestamps, per-run metadata.
 */
import { describe, expect, it } from 'vitest';
import { AgEvent, reduce, toWire } from '@silverprotocol/core';
import { goldenUiToolDones, loadLeg } from './testing/corpus.js';
/** ggui's seam predicate — the interceptor's REAL detection logic,
 * imported from src (one logic, two callers; a re-implemented copy in
 * a test would drift and test nothing). */
import { toolResultCarriesUiResource } from './tool-result-interceptor.js';

const LEGS = [
  ['app-spec-gemini36', 'adk'],
  ['app-spec-structured-result', 'openai'],
  ['app-update-sonnet5', 'claude'],
  ['partials-sonnet5', 'claude'],
] as const;

type Framework = (typeof LEGS)[number][1];

/** Narrow an unknown to a plain object, else undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Collect the tool results a ggui adapter for each framework would
 * hand the seam, straight from the framework-native frames. Each
 * collector is grounded on the REAL pinned `.native.json` shapes:
 *
 * - claude: `user` frames carry the MCP CallToolResult verbatim at
 *   `frame.tool_use_result` (keys: content, _meta, structuredContent).
 * - adk: tool results ride at
 *   `frame.content.parts[].functionResponse.response` — the MCP
 *   CallToolResult verbatim (content, structuredContent, _meta).
 * - openai: `run_item_stream_event` frames with `name: 'tool_output'`
 *   carry the framework-flattened result at `item.rawItem`; the
 *   MCP-side extras (structuredContent — and `_meta`, were the SDK to
 *   forward it) ride the `item.customData` channel. Collect customData
 *   when present, else the rawItem.
 */
function nativeToolResults(native: unknown[], framework: Framework): unknown[] {
  const results: unknown[] = [];
  for (const frame of native) {
    const f = asRecord(frame);
    if (f === undefined) continue;
    if (framework === 'claude') {
      if (f.type === 'user' && f.tool_use_result !== undefined) {
        results.push(f.tool_use_result);
      }
    } else if (framework === 'adk') {
      const parts = asRecord(f.content)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const response = asRecord(asRecord(part)?.functionResponse)?.response;
        if (response !== undefined) results.push(response);
      }
    } else {
      if (f.type !== 'run_item_stream_event' || f.name !== 'tool_output') {
        continue;
      }
      const item = asRecord(f.item);
      if (item === undefined) continue;
      results.push(item.customData ?? item.rawItem);
    }
  }
  return results;
}

describe('cassette realism tier', () => {
  for (const [scenario, fw] of LEGS) {
    it(`${scenario}/${fw}: seam finds exactly the ui-bearing results the golden declares`, () => {
      const leg = loadLeg(scenario, fw);
      const results = nativeToolResults(leg.native, fw);
      // Scenario intent (stable set): every consumed leg exercises at
      // least one tool call — the collector never comes back empty, so
      // a zero `found` below means the PREDICATE said no, not that the
      // collector missed the frames.
      expect(results.length).toBeGreaterThan(0);
      const found = results.filter(toolResultCarriesUiResource).length;
      // The golden is machine-readable stable-set INPUT: the seam must
      // find exactly as many ui-bearing tool results in the native
      // frames as the golden declares tool.done events carrying the
      // `_meta.ui` bootstrap. (Grounded: app-spec-gemini36 declares 1,
      // app-update-sonnet5 declares 2; the structured-result and
      // partials legs declare 0 — for those the equality is the
      // false-positive check on a real stream.)
      expect(found).toBe(goldenUiToolDones(leg.agjson));
    });
  }

  it('the corpus exercises the positive arm (non-vacuity)', () => {
    // Guard against a silent corpus refresh degrading every leg to the
    // zero case: across the four pinned legs the goldens must declare
    // at least one `_meta.ui`-bearing tool completion.
    const total = LEGS.reduce(
      (n, [scenario, fw]) =>
        n + goldenUiToolDones(loadLeg(scenario, fw).agjson),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});

describe('synthetic contract tier (AgEvent-validated stimulus)', () => {
  it('error/abort arms: seam predicate stays false-negative-free and never throws', () => {
    // Producer stance: synthetics must be spec-valid (strict parse).
    // Shapes mirror the pinned corpus (message-bracketed tool call);
    // the tool completes with outcome 'error' BEFORE the turn errors —
    // a dangling tool.start makes the 0.4.1 fold demand a resync,
    // which would be an incoherent stimulus.
    const stream = [
      { type: 'turn.start', seq: 0, turnId: 't_syn', threadId: 'th_syn' },
      {
        type: 'message.start',
        seq: 1,
        id: 'm_syn',
        turnId: 't_syn',
        threadId: 'th_syn',
        role: 'assistant',
      },
      {
        type: 'tool.start',
        seq: 2,
        turnId: 't_syn',
        toolCallId: 'c_syn',
        name: 'render_card',
        messageId: 'm_syn',
      },
      { type: 'message.end', seq: 3, id: 'm_syn' },
      {
        type: 'tool.done',
        seq: 4,
        turnId: 't_syn',
        toolCallId: 'c_syn',
        content: [{ type: 'text', text: 'tool exploded' }],
        outcome: 'error',
        isError: true,
        messageId: 'c_syn:result',
      },
      { type: 'turn.error', seq: 5, turnId: 't_syn', message: 'boom' },
      { type: 'turn.abort', seq: 6, turnId: 't_syn' },
    ].map((e) => AgEvent.parse(e));
    // Fold-check the stimulus is coherent (stimulus-side only):
    expect(reduce(stream).needsResync).toBe(false);
    // Oracle in ours: no ui-bearing tool result exists in this stream
    // (the lone tool.done is an error result with no _meta) → the seam
    // finds nothing and throws on nothing, event by event.
    for (const ev of stream) {
      expect(() => toolResultCarriesUiResource(toWire(ev))).not.toThrow();
      expect(toolResultCarriesUiResource(toWire(ev))).toBe(false);
    }
  });

  it('forward-compat: unknown ext.* events do not confuse the seam', () => {
    const ev = AgEvent.parse({
      type: 'ext.somevendor.mystery',
      seq: 0,
      payload: { x: 1 },
    });
    expect(toolResultCarriesUiResource(toWire(ev))).toBe(false);
  });

  it('hostile-shape stimulus: predicate is total over junk inputs', () => {
    // The seam sees whatever the adapter hands it; the predicate must
    // be a total function — false, never a throw — on shapes that are
    // not CallToolResults at all.
    for (const junk of [
      undefined,
      null,
      42,
      'string',
      [],
      {},
      { _meta: null },
      { _meta: { ui: null } },
      { _meta: { ui: { resourceUri: '' } } },
      { _meta: { ui: { resourceUri: 7 } } },
    ]) {
      expect(() => toolResultCarriesUiResource(junk)).not.toThrow();
      expect(toolResultCarriesUiResource(junk)).toBe(false);
    }
  });
});
