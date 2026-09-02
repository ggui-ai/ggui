/**
 * #504 — the visual evaluator's provider calls must run through the
 * shared vision agent (`createVisionAgent`), not inline SDK clients.
 * Pinned the same way `llm-router.free-fns-route-override.test.ts`
 * pins #484: spy on the real Anthropic client factory and assert the
 * config's `routeOverride.apiKey` reaches construction — proving the
 * whole `VisualEvalConfig` → `createVisionAgent` → `AnthropicAgent`
 * → `createClient()` chain (including the `'claude'` → `'anthropic'`
 * provider mapping, which is what routes the call INTO that chain).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callMultimodalLLM } from './visual-evaluator.js';

describe('callMultimodalLLM — routes through createVisionAgent (#504)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'env-key-should-not-be-used';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("provider 'claude' threads routeOverride.apiKey to the real Anthropic client factory", async () => {
    const spy = vi.spyOn(
      await import('../adapters/claude/client.js'),
      'createAnthropicClient',
    );
    await callMultimodalLLM(
      {
        provider: 'claude',
        passThreshold: 70,
        routeOverride: { apiKey: 'override-key-visual-eval' },
      },
      'claude-haiku-4-5',
      'system prompt',
      Buffer.from('png-bytes'),
      'original prompt',
    ).catch(() => {
      // Expected — no real network access in this test; the assertion
      // is on how the client was CONSTRUCTED, not on a successful call.
    });
    expect(spy).toHaveBeenCalledWith('override-key-visual-eval');
  });
});

/**
 * ggui#613 — the judged render must look like the production render.
 * Two defects on the same path (both found by the #613 survey, both
 * live since the oss/ migration + the s4 fallback ban respectively):
 * the design-package alias resolved a pre-migration path that does not
 * exist (bundle breaks before tokens matter), and buildRenderHTML
 * injected NOTHING when the caller passed no cssTokens — under the
 * fallback ban every `var(--ggui-*)` in the generated component then
 * renders unset, and the multimodal judge grades broken-looking
 * output.
 */
describe('visual-eval render fidelity (ggui#613)', () => {
  it('the design-package dir the bundler aliases actually exists and is @ggui-ai/design', async () => {
    const { resolveDesignPackageDir } = await import('./visual-evaluator.js');
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const dir = resolveDesignPackageDir();
    const pkgPath = resolve(dir, 'package.json');
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    expect(pkg.name).toBe('@ggui-ai/design');
  });

  it('buildRenderHTML with NO cssTokens defaults to the design tokens — judged renders carry what production injects', async () => {
    const { buildRenderHTML } = await import('./visual-evaluator.js');
    const html = buildRenderHTML('/* bundled */');
    // Assert DECLARATIONS (name-colon), not var() usages — the page
    // chrome's own `var(--ggui-*, fallback)` references would match a
    // bare substring and green a broken default (caught writing this
    // test: the first cut asserted usage and passed pre-fix).
    expect(html).toMatch(/--ggui-color-primary-500:\s*\S/);
    expect(html).toMatch(/--ggui-font-family-sans:\s*\S/);
  });

  it('buildRenderHTML with explicit cssTokens uses them verbatim (caller override wins)', async () => {
    const { buildRenderHTML } = await import('./visual-evaluator.js');
    const html = buildRenderHTML('/* bundled */', ':root { --ggui-custom-probe: 1; }');
    expect(html).toContain('--ggui-custom-probe: 1');
  });
});
