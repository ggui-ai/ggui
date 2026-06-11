/**
 * Tests for the esbuild-backed compile wrapper that turns raw JSX/TSX
 * from `createUiGenerator` into browser-ready ESM.
 *
 * Real esbuild — no mocks. `compileComponentCode` is a pure transform
 * and esbuild is a compulsory host dep for the OSS `ggui serve` flow,
 * so the integration test is the honest unit.
 */
import { describe, expect, it } from 'vitest';
import type {
  UiGenerateInput,
  UiGenerator,
  UiGenerateResult,
} from '@ggui-ai/mcp-server-core';
import {
  CompileComponentCodeError,
  compileComponentCode,
  withBrowserCompile,
} from './compile.js';

// ─── Fixtures ────────────────────────────────────────────────────

function fakeInput(): UiGenerateInput {
  return {
    request: { sessionId: 's1', prompt: 'weather card' },
    llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
    providerKey: { provider: 'anthropic', key: 'ignored' },
    blueprints: {
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
  };
}

function fakeGenerator(impl: () => Promise<UiGenerateResult>): UiGenerator {
  return {
    slug: 'ui-gen-default-test',
    tier: 'default',
    model: 'test',
    generate: impl,
  };
}

// ─── compileComponentCode ────────────────────────────────────────

describe('compileComponentCode', () => {
  it('desugars JSX to jsx-runtime calls (automatic runtime)', async () => {
    const src = `import React from 'react';\nexport default function C() { return <div>hi</div>; }`;
    const out = await compileComponentCode(src);
    // Automatic JSX runtime injects an import from "react/jsx-runtime".
    expect(out).toContain('react/jsx-runtime');
    // The raw <div> JSX token must be gone — that's the whole point.
    expect(out).not.toMatch(/<div>hi<\/div>/);
    // Default export survives (esbuild emits `export { X as default }`
    // rather than `export default function X`, so anchor on the binding).
    expect(out).toMatch(/\bas default\b/);
  });

  it('strips TypeScript types from TSX input', async () => {
    const src = `import React from 'react';\ntype Props = { name: string };\nexport default function Hello(props: Props) { return <span>{props.name}</span>; }`;
    const out = await compileComponentCode(src);
    // `type` declarations do not survive a type-stripping transform.
    expect(out).not.toMatch(/type Props =/);
    // Function body expression `props.name` survives as a property access.
    expect(out).toContain('props.name');
    // Default export binding survives.
    expect(out).toMatch(/Hello as default/);
  });

  it('preserves static ESM imports for the renderer to rewrite later', async () => {
    const src = `import React from 'react';\nimport { Card } from '@ggui-ai/design/primitives';\nexport default function C() { return <Card>ok</Card>; }`;
    const out = await compileComponentCode(src);
    // esbuild normalizes specifier quotes; the identity that matters is
    // that bare specifiers survive untouched for the renderer's
    // data-URL shim to resolve at mount time. Quote style is irrelevant.
    expect(out).toMatch(/from ["']react\/jsx-runtime["']/);
    expect(out).toMatch(/from ["']@ggui-ai\/design\/primitives["']/);
  });

  it('rejects empty input with a CompileComponentCodeError', async () => {
    await expect(compileComponentCode('')).rejects.toBeInstanceOf(
      CompileComponentCodeError,
    );
  });

  it('wraps esbuild parse failures in CompileComponentCodeError', async () => {
    // Unbalanced JSX — esbuild must reject.
    const src = `export default function C() { return <div><span></div>; }`;
    await expect(compileComponentCode(src)).rejects.toBeInstanceOf(
      CompileComponentCodeError,
    );
  });
});

// ─── withBrowserCompile — happy path ──────────────────────────────

describe('withBrowserCompile', () => {
  it('compiles componentCode on success and preserves the raw source on sourceCode', async () => {
    const rawSource = `import React from 'react';\nexport default function Weather() { return <div>sunny</div>; }`;
    const upstream = fakeGenerator(async () => ({
      ok: true as const,
      response: {
        sessionId: 'p-1',
        componentCode: rawSource,
        sourceCode: rawSource,
      },
      metadata: {
        provider: 'anthropic',
        generator: 'ui-gen-default-test',
        model: 'claude-opus-4-7',
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 42,
        cacheHit: false,
        attempts: 1,
      },
    }));
    const wrapped = withBrowserCompile(upstream);
    const out = await wrapped.generate(fakeInput());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // componentCode is compiled — no raw JSX token.
    expect(out.response.componentCode).not.toMatch(/<div>sunny<\/div>/);
    expect(out.response.componentCode).toContain('react/jsx-runtime');
    // sourceCode holds the original JSX for downstream consumers
    // (bench, blueprint cache seed, debugging).
    expect(out.response.sourceCode).toBe(rawSource);
    // Metadata passthrough.
    expect(out.metadata.latencyMs).toBe(42);
  });

  it('forwards upstream failures untouched', async () => {
    const upstream = fakeGenerator(async () => ({
      ok: false as const,
      error: {
        code: 'PRODUCTION_FAILED' as const,
        message: 'provider fail',
        details: { kind: 'provider-fail' },
      },
    }));
    const wrapped = withBrowserCompile(upstream);
    const out = await wrapped.generate(fakeInput());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toBe('provider fail');
  });

  it('funnels compile failures into a PRODUCTION_FAILED result (never throws)', async () => {
    const rawSource = `export default function Bad() { return <div><span></div>; }`;
    const upstream = fakeGenerator(async () => ({
      ok: true as const,
      response: {
        sessionId: 'p-bad',
        componentCode: rawSource,
        sourceCode: rawSource,
      },
      metadata: {
        provider: 'anthropic',
        generator: 'ui-gen-default-test',
        model: 'claude-opus-4-7',
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 1,
        cacheHit: false,
        attempts: 1,
      },
    }));
    const wrapped = withBrowserCompile(upstream);
    const out = await wrapped.generate(fakeInput());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('PRODUCTION_FAILED');
    expect(out.error.message).toContain('did not compile');
    const details = out.error.details;
    expect(details && typeof details === 'object' && !Array.isArray(details)
      ? details.kind
      : undefined).toBe('compile-failed');
    // Metadata is passed through from the upstream success so consumers
    // can see how much work the provider did before the compile broke.
    expect(out.metadata?.latencyMs).toBe(1);
  });

  it('does not call upstream stream() implicitly — generate path only compiles', async () => {
    let streamCalls = 0;
    const upstream: UiGenerator = {
      slug: 'ui-gen-default-test',
      tier: 'default',
      model: 'test',
      async generate() {
        return {
          ok: true as const,
          response: {
            sessionId: 'p-s',
            componentCode: `export default () => null;`,
            sourceCode: `export default () => null;`,
          },
          metadata: {
            provider: 'anthropic',
            generator: 'ui-gen-default-test',
            model: 'claude-opus-4-7',
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
            cacheHit: false,
            attempts: 1,
          },
        };
      },
      async *stream() {
        streamCalls += 1;
        yield { type: 'done' as const, result: { ok: false, error: { code: 'PRODUCTION_FAILED', message: 'n/a' } } };
      },
    };
    const wrapped = withBrowserCompile(upstream);
    expect(typeof wrapped.stream).toBe('function');
    await wrapped.generate(fakeInput());
    // Calling generate must not route through stream.
    expect(streamCalls).toBe(0);
  });
});
