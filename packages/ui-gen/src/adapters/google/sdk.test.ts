/**
 * ggui#1132 — an explicitly passed key must WIN, and the adapter must not
 * write an env var it does not own.
 *
 * The hazard: `GOOGLE_GENAI_API_KEY` is first in the ADK's own resolution
 * order (GOOGLE_GENAI_API_KEY || GOOGLE_API_KEY || GEMINI_API_KEY), so a
 * stale ambient value beats the fresh key the caller passed if the adapter
 * merely "writes if absent". The fix is precedence at the source: hand the
 * key to the model directly and leave process.env alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const ctor = vi.hoisted(() => ({ gemini: [] as unknown[], agent: [] as unknown[] }));

vi.mock('@google/adk', () => {
  class Gemini {
    constructor(params: unknown) {
      ctor.gemini.push(params);
    }
  }
  class LlmAgent {
    constructor(params: unknown) {
      ctor.agent.push(params);
    }
  }
  const registered: Array<{ name: string; execute: (args: unknown) => Promise<string> }> = [];
  class FunctionTool {
    constructor(p: { name: string; execute: (args: unknown) => Promise<string> }) {
      registered.push(p);
    }
  }
  class InMemoryRunner {
    sessionService = { createSession: async () => ({ id: 's1' }) };
    constructor(_p: unknown) {}
    async *runAsync() {
      // The loop only completes when the compile tool produced code — drive it
      // the way the model would, so the assertions after the loop are reached.
      for (const t of registered) if (t.name === 'compile_component') await t.execute({});
      yield { content: { parts: [{ text: 'done' }] }, usageMetadata: undefined };
    }
  }
  return { Gemini, LlmAgent, FunctionTool, InMemoryRunner, isFinalResponse: () => true };
});

import { runAdkLoop } from './sdk.js';
import type { ToolDefinition } from '../types';

const COMPILE_TOOL: ToolDefinition = {
  name: 'compile_component',
  description: 'test compile tool',
  inputSchema: z.object({}),
  handler: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ success: true, compiledCode: 'export default 1' }) }],
  }),
};

describe('runAdkLoop key precedence (ggui#1132)', () => {
  const ORIGINAL = process.env.GOOGLE_GENAI_API_KEY;
  beforeEach(() => {
    ctor.gemini.length = 0;
    ctor.agent.length = 0;
    process.env.GOOGLE_GENAI_API_KEY = 'stale-ambient';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GOOGLE_GENAI_API_KEY;
    else process.env.GOOGLE_GENAI_API_KEY = ORIGINAL;
  });

  it('hands the passed key to the model directly, so a stale ambient GOOGLE_GENAI_API_KEY cannot win', async () => {
    await runAdkLoop({
      model: 'gemini-test',
      apiKey: 'fresh-passed',
      systemPrompt: 'sys',
      userPrompt: 'user',
      tools: [COMPILE_TOOL],
    });
    expect(ctor.gemini).toHaveLength(1);
    expect(ctor.gemini[0]).toMatchObject({ model: 'gemini-test', apiKey: 'fresh-passed' });
    // the agent receives the INSTANCE, not the bare model string
    expect((ctor.agent[0] as { model: unknown }).model).not.toBe('gemini-test');
  });

  it('never writes GOOGLE_GENAI_API_KEY — the adapter does not own that variable', async () => {
    await runAdkLoop({
      model: 'gemini-test',
      apiKey: 'fresh-passed',
      systemPrompt: 'sys',
      userPrompt: 'user',
      tools: [COMPILE_TOOL],
    });
    expect(process.env.GOOGLE_GENAI_API_KEY).toBe('stale-ambient');
  });

  it('with no key passed, defers to the ADK own env resolution (no instance, no write)', async () => {
    delete process.env.GOOGLE_GENAI_API_KEY;
    await runAdkLoop({ model: 'gemini-test', systemPrompt: 'sys', userPrompt: 'user', tools: [COMPILE_TOOL] });
    expect(ctor.gemini).toHaveLength(0);
    expect(process.env.GOOGLE_GENAI_API_KEY).toBeUndefined();
  });
});
