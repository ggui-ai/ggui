// ggui#1127 — the stop reason a vision call reports, normalized. A salvaged judge answer's cause is read from it,
// never from the answer's length, so each provider's mapping is pinned, and absence stays absence (unknown).
import { describe, expect, it } from 'vitest';
import { anthropicFinishReason, googleFinishReason } from './llm-router';

describe('vision stop reasons, normalized (ggui#1127)', () => {
  it('Anthropic: end_turn and stop_sequence stop, max_tokens is the cap, refusal is a safety stop, absence stays absent', () => {
    expect(anthropicFinishReason('end_turn')).toBe('stop');
    expect(anthropicFinishReason('stop_sequence')).toBe('stop');
    expect(anthropicFinishReason('max_tokens')).toBe('length');
    expect(anthropicFinishReason('refusal')).toBe('content-filter');
    expect(anthropicFinishReason('tool_use')).toBe('other');
    expect(anthropicFinishReason(null)).toBeUndefined();
    expect(anthropicFinishReason(undefined)).toBeUndefined();
  });

  it('Google: STOP stops, MAX_TOKENS is the cap, the safety family is a safety stop, absence stays absent', () => {
    expect(googleFinishReason('STOP')).toBe('stop');
    expect(googleFinishReason('MAX_TOKENS')).toBe('length');
    for (const r of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']) {
      expect(googleFinishReason(r)).toBe('content-filter');
    }
    expect(googleFinishReason('OTHER')).toBe('other');
    expect(googleFinishReason(undefined)).toBeUndefined();
  });
});
