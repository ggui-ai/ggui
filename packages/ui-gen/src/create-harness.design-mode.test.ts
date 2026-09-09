/**
 * `createHarness({ designMode, canvas })` — the harness is the carrier
 * from which every leg reads the mode: the HOW leg's prompt builder
 * receives it, the WHAT leg's boilerplate is rendered with it, and
 * `harness.designMode` is what the coding turn (tier-0 gate), run-check
 * (axis checks) and eval round (criteria) consume.
 *
 * Constrained stays byte-identical: same id, same prompt, same
 * boilerplate whether the option is omitted or passed explicitly.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { classifyAxes } from './classifier/index.js';
import { createHarness } from './create-harness.js';
import type { SystemPromptBuilder } from './harness/types-public.js';

const contract: DataContract = {
  propsSpec: { properties: { title: { required: true, schema: { type: 'string' } } } },
  actionSpec: { save: { label: 'Save' } },
};
const prompt = 'a note editor with a save button';
const classification = classifyAxes({ contract, prompt });

describe('createHarness — designMode', () => {
  it('defaults to constrained and is byte-identical whether omitted or explicit', () => {
    const omitted = createHarness({ classification, contract, prompt, shellType: 'chat', screen: 'mobile' });
    const explicit = createHarness({
      classification,
      contract,
      prompt,
      shellType: 'chat',
      screen: 'mobile',
      designMode: 'constrained',
      canvas: 'xl',
    });
    expect(omitted.designMode).toBe('constrained');
    expect(explicit.designMode).toBe('constrained');
    expect(explicit.id).toBe(omitted.id);
    expect(explicit.how.systemPrompt).toBe(omitted.how.systemPrompt);
    expect(explicit.what.boilerplate).toBe(omitted.what.boilerplate);
    expect(omitted.meta.overrides).not.toContain('designMode:free');
  });

  it('free: the mode + canvas reach the injected prompt builder, and the harness carries the mode', () => {
    const seen: Parameters<SystemPromptBuilder>[0][] = [];
    const builder: SystemPromptBuilder = (input) => {
      seen.push(input);
      return `prompt:${input.designMode ?? 'none'}:${input.canvas ?? 'none'}`;
    };
    const harness = createHarness({
      classification,
      contract,
      prompt,
      shellType: 'fullscreen',
      screen: 'desktop',
      designMode: 'free',
      canvas: 'lg',
      systemPromptBuilder: builder,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.designMode).toBe('free');
    expect(seen[0]!.canvas).toBe('lg');
    expect(harness.designMode).toBe('free');
    expect(harness.how.systemPrompt).toBe('prompt:free:lg');
    expect(harness.meta.overrides).toContain('designMode:free');
  });

  it('free: the default builder renders the free prompt and the WHAT leg renders the free boilerplate', () => {
    const free = createHarness({ classification, contract, prompt, shellType: 'chat', screen: 'mobile', designMode: 'free' });
    const constrained = createHarness({ classification, contract, prompt, shellType: 'chat', screen: 'mobile' });
    expect(free.how.systemPrompt).toContain('## Design freedom');
    expect(free.how.systemPrompt).toContain('renders on the `xs-card` canvas');
    expect(constrained.how.systemPrompt).not.toContain('## Design freedom');
    expect(free.what.boilerplate).not.toMatch(/^import .* from '@ggui-ai\/design'/m);
    expect(constrained.what.boilerplate).toMatch(/^import .* from '@ggui-ai\/design'/m);
    // Same wire hook line in both.
    const hookLine = "const save = useAction<ActionSavePayload>('save');";
    expect(free.what.boilerplate).toContain(hookLine);
    expect(constrained.what.boilerplate).toContain(hookLine);
    expect(free.id).not.toBe(constrained.id);
  });

  it('derive() keeps the design mode', () => {
    const free = createHarness({ classification, contract, prompt, designMode: 'free' });
    const derived = free.derive({ useFallbackTools: true });
    expect(derived.designMode).toBe('free');
    const spy = vi.fn();
    spy(derived.how.systemPrompt.includes('## Design freedom'));
    expect(spy).toHaveBeenCalledWith(true);
  });
});
