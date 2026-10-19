// ggui#1769 — a long-lived host's first generation stalled the event loop for ~1 s on two pieces of cold work:
// the provider SDK the router imports lazily, and a type-checker VFS warmed in a different bundle copy than the
// one generation runs. These pin both fixes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { preloadProviderSdks } from './llm-router.js';

describe('preloadProviderSdks (ggui#1769)', () => {
  it('loads every SDK the router imports lazily, and reports none missing here', async () => {
    const r = await preloadProviderSdks();
    expect([...r.loaded].sort()).toEqual(['@anthropic-ai/bedrock-sdk', '@anthropic-ai/claude-agent-sdk', '@google/genai', 'openai']);
    expect(r.missing).toEqual([]);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  }, 60000);

  it('covers every lazy SDK import in the router (a new lazy import must join the preload)', () => {
    const src = readFileSync(new URL('./llm-router.ts', import.meta.url), 'utf8');
    const preloadAt = src.indexOf('export async function preloadProviderSdks');
    const lazy = new Set([...src.slice(0, preloadAt).matchAll(/await import\('(@?[a-z][^']*)'\)/g)].map((m) => m[1]));
    const preloaded = new Set([...src.slice(preloadAt).matchAll(/import\('(@?[a-z][^']*)'\)/g)].map((m) => m[1]));
    expect(lazy.size).toBeGreaterThan(0);
    for (const s of lazy) expect(preloaded.has(s), s).toBe(true);
  });
});

describe('one module instance per bundle (ggui#1769)', () => {
  it('the bundler splits shared modules, so every entry shares one type checker and one VFS', () => {
    const cfg = readFileSync(new URL('../../tsup.config.ts', import.meta.url), 'utf8');
    expect(cfg).toMatch(/^\s*splitting: true,$/m);
  });
});
