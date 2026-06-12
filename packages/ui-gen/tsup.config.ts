import { defineConfig } from 'tsup';

/**
 * Bundler config for `@ggui-ai/ui-gen` — the UI generation harness.
 *
 * Distribution model:
 *   - Published under the open `@ggui-ai/*` scope, Apache-2.0.
 *   - Source maps ON, minification OFF — readable builds, debuggable in
 *     consumer stack traces.
 *   - Both `src/` and `dist/` ship in the tarball (see package.json `files`)
 *     so consumers can step through source if they want.
 *
 * Subpath entrypoints (adapters, harness, evaluation,
 * design-system-docs, render-check, wire/primitive docs) are registered
 * in the `entry` array below.
 */
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/classifier/index.ts',
    'src/fragments/index.ts',
    'src/compose.ts',
    'src/hash.ts',
    'src/llm.ts',
    'src/policy.ts',
    'src/workflows.ts',
    'src/patch.ts',
    'src/tools.ts',
    'src/boilerplate.ts',
    'src/provider-adapter.ts',
    'src/provider-adapter-contract.ts',
    'src/providers/index.ts',
    'src/compile.ts',
    'src/check/index.ts',
    'src/validation/index.ts',
    'src/validation/ui-compiler.ts',
    'src/design-system-docs.ts',
    // Blueprint validator orchestrator.
    'src/blueprint-validator.ts',
    // Advanced generator (published `./advanced` subpath — see
    // docs/protocol/migrations/2026-05-12-advanced-generator.md). Was
    // never listed here; the exports-map target only resolved because a
    // stale pre-tsup `dist/advanced/` orphan kept shipping. Clean
    // builds (rm -rf dist) exposed the gap.
    'src/advanced/index.ts',
    // Harness cluster.
    'src/harness/index.ts',
    'src/harness/types-public.ts',
    'src/harness/runtime.ts',
    'src/harness/prompts.ts',
    'src/harness/result-types.ts',
    'src/harness/llm-trace-sink.ts',
    'src/harness/validator-trace-sink.ts',
    'src/harness/check/runtime-render/index.ts',
    // Evaluation cluster.
    'src/evaluation/index.ts',
    'src/evaluation/types.ts',
    'src/evaluation/types-public.ts',
    'src/evaluation/loop.ts',
    'src/evaluation/evaluator.ts',
    'src/evaluation/mcp-server.ts',
    'src/evaluation/prompts.ts',
    'src/evaluation/axis-checks/index.ts',
    'src/evaluation/axis-checks/registry.ts',
    // Adapters cluster.
    'src/adapters/index.ts',
    'src/adapters/base.ts',
    'src/adapters/types.ts',
    'src/adapters/generation-dispatch.ts',
    'src/adapters/provider-router.ts',
    'src/adapters/claude/raw.ts',
    'src/adapters/openai/raw.ts',
    'src/adapters/google/raw.ts',
    // Tool docs.
    'src/tools/get-wire.ts',
    'src/tools/get-primitives-ts.ts',
    'src/tools/render-check.ts',
    // render-check.ts spawns this as a subprocess (`spawn(node, [workerPath])`),
    // so tsup can't statically pick it up via import-graph traversal —
    // it needs to be listed as an explicit entry to land in dist/.
    'src/tools/render-check-worker.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  minify: false,
  clean: true,
  treeshake: true,
  splitting: false,
  target: 'node22',
  // The runtime-render probe was crashing with `Dynamic require of
  // "events" is not supported` and `Window2 is not a constructor`.
  // Root cause: tsup was bundling happy-dom + react-testing
  // into `generation-dispatch.js` (891 inlined references); esbuild
  // can't transform happy-dom's internal CJS `require('events')` to
  // ESM, leaves a runtime-throwing stub. The Window2 collision was
  // bundler renaming Window after happy-dom + Anthropic SDK Window
  // class names collided.
  //
  // Fix: keep these packages EXTERNAL so Node's native loader resolves
  // them at runtime against `packages/ui-gen/node_modules/...` (where
  // they're declared as deps). All three packages are CJS-friendly via
  // Node's interop layer when loaded natively, but break when bundled.
  external: [
    'happy-dom',
    '@testing-library/react',
    '@testing-library/user-event',
    // esbuild is also a dep (used at runtime by `compile.ts` via dynamic
    // import) — keeping external avoids bundling its native binary
    // resolution paths.
    'esbuild',
    // Heavy provider SDKs + the visual-evaluator browser driver. All
    // three are loaded via lazy `await import(...)` at adapter / probe
    // time and are declared optional peerDependencies — tsup only
    // auto-externalizes dependencies/peerDependencies it can see, and
    // bundling these inlined their full transitive trees (~67MB of the
    // 84.7MB unpacked tarball: @google/adk pulls @mikro-orm/core +
    // lodash-es + google-auth-library; @openai/agents pulls
    // @openai/agents-core; puppeteer-core pulls chromium-bidi +
    // devtools-protocol). Consumers that use the Google / OpenAI
    // adapters or the visual evaluator install the SDK themselves.
    '@google/adk',
    '@openai/agents',
    'puppeteer-core',
  ],
});
