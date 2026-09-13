import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OPS_GENERATE_BLUEPRINT_INTENT_MAX_CHARS, opsGenerateBlueprintInputSchema } from './ops-blueprint';
import { variantKey } from '../registry/variant-key';

// ggui#1046 — `intent`: the generation prompt as a NON-identity field. `seedPrompt`
// is a variance key (cache identity); a prompt that must not move the key rides
// `intent`. Precedence at the handler: intent > seedPrompt > placeholder (this
// release) → placeholder deleted next release (VERSION-POLICY §3.6).
const CONTRACT = {"propsSpec": {"properties": {"note": {"schema": {"description": "free-text note"}}}}, "streamSpec": {"ticks": {"schema": {"description": "local timer ticks"}}}} as const;

describe('opsGenerateBlueprintInputSchema.intent (ggui#1046)', () => {
  it('accepts an intent, trimmed, and keeps the previous-release payload (contract + seedPrompt, no intent) valid', () => {
    const withIntent = opsGenerateBlueprintInputSchema.parse({ contract: CONTRACT, intent: '  a weekly kanban board with drag between columns  ' });
    expect(withIntent.intent).toBe('a weekly kanban board with drag between columns');
    const previous = opsGenerateBlueprintInputSchema.parse({ contract: CONTRACT, seedPrompt: 'weekly kanban' });
    expect('intent' in previous).toBe(false);
  });

  it('bounds intent at the ONE exported constant and refuses a non-string, naming the member', () => {
    expect(OPS_GENERATE_BLUEPRINT_INTENT_MAX_CHARS).toBe(2000);
    expect(opsGenerateBlueprintInputSchema.safeParse({ contract: CONTRACT, intent: 'i'.repeat(2000) }).success).toBe(true);
    for (const bad of ['i'.repeat(2001), 42, null]) {
      const r = opsGenerateBlueprintInputSchema.safeParse({ contract: CONTRACT, intent: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['intent']);
    }
  });

  it('is NOT identity: variantKey over the variance members is the same with and without an intent', () => {
    const a = opsGenerateBlueprintInputSchema.parse({ contract: CONTRACT, seedPrompt: 'weekly kanban', aesthetic: 'calm' });
    const b = opsGenerateBlueprintInputSchema.parse({ contract: CONTRACT, seedPrompt: 'weekly kanban', aesthetic: 'calm', intent: 'a board' });
    const variance = (p: typeof a) => ({ persona: p.persona, aesthetic: p.aesthetic, context: p.context, seedPrompt: p.seedPrompt });
    expect(variantKey(variance(b))).toBe(variantKey(variance(a)));
  });

  it('describes intent for every self-hoster (tools/list) without naming a product, lane or host', () => {
    const text = opsGenerateBlueprintInputSchema.shape.intent.description ?? '';
    expect(text).toMatch(/not part of (the )?(cache )?identity/i);
    expect(text).not.toMatch(/lane|relay|host timeout|platform|console/i);
  });

  it('is representable as JSON Schema (maxLength surfaced)', () => {
    const js = z.toJSONSchema(opsGenerateBlueprintInputSchema) as { properties?: Record<string, { maxLength?: number }> };
    expect(js.properties?.['intent']?.maxLength).toBe(2000);
  });
});
