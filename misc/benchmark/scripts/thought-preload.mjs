// thought-preload.mjs — per-call Gemini thought-token capture for bench runs.
//
// Standing precondition for the thought-token gate (see Experiments 45/46 in
// docs/harness-modes/experiments.md): the shared GoogleRawAdapter (`raw.ts`)
// reads only `total_input_tokens` / `total_output_tokens`, NOT
// `usage.total_thought_tokens`, so thinking-budget regressions are invisible
// to normal bench output. This preload captures the full token split without
// editing shared code.
//
// Usage — load via `--import` in front of any bench entrypoint, from
// oss/misc/benchmark/:
//
//   GGUI_THOUGHT_LOG=/tmp/thought.jsonl \
//     node --import tsx --import ./scripts/thought-preload.mjs scripts/bench-n.mjs …
//
// Appends one JSON line per Interactions.create call to $GGUI_THOUGHT_LOG
// (default /tmp/thought.jsonl): { ts, model, in, out, thought }.
//
// How it works: patches the ESM @google/genai Interactions.create — the
// SAME module instance the GoogleRawAdapter dynamically imports via ESM
// `import('@google/genai')` (resolves to dist/node/index.mjs under the node
// export condition). ESM modules are singletons per resolved URL, so importing
// that exact file here yields the identical class the adapter uses (the CJS
// `require` copy is a DIFFERENT instance — dual-package hazard — which is why
// a require-based patch silently misses every call).
// Non-invasive: no shared-code edit; pure runtime interception in the bench
// process.
import { appendFileSync } from 'fs';

const LOG = process.env.GGUI_THOUGHT_LOG || '/tmp/thought.jsonl';

try {
  // dist/node/index.mjs is the `node` ESM condition target the adapter gets.
  const specifier = new URL(
    '../../../packages/ui-gen/node_modules/@google/genai/dist/node/index.mjs',
    import.meta.url,
  ).href;
  const mod = await import(specifier);
  const GoogleGenAI = mod.GoogleGenAI || mod.default?.GoogleGenAI;
  if (!GoogleGenAI) {
    process.stderr.write('[thought-preload] GoogleGenAI not found on ESM module\n');
  } else {
    const inst = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || 'x',
    });
    const proto = Object.getPrototypeOf(inst.interactions);
    const real = proto.create;
    if (typeof real === 'function' && !real.__patched) {
      const patched = async function (...a) {
        const r = await real.apply(this, a);
        try {
          const u = r?.usage || {};
          appendFileSync(
            LOG,
            JSON.stringify({
              ts: Date.now(),
              model: a?.[0]?.model ?? null,
              in: u.total_input_tokens ?? 0,
              out: u.total_output_tokens ?? 0,
              thought: u.total_thought_tokens ?? 0,
            }) + '\n',
          );
        } catch {}
        return r;
      };
      patched.__patched = true;
      proto.create = patched;
      process.stderr.write(
        '[thought-preload] patched ESM Interactions.create — logging to ' + LOG + '\n',
      );
    } else {
      process.stderr.write('[thought-preload] create already patched or missing\n');
    }
  }
} catch (e) {
  process.stderr.write('[thought-preload] failed: ' + (e?.message || e) + '\n');
}
