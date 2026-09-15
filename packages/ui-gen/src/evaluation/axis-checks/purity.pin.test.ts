/**
 * Pin (ggui#1122): the axis-check family stays PURE and SYNCHRONOUS.
 *
 * That property is the whole reason the deterministic family can move to
 * `autoCommit` — where `runTier0Checks` already runs on every served
 * generation — instead of staying behind the eval round's gate, whose other
 * half fires an LLM and a browser. Cloud's warning when the shape was agreed,
 * and the reason this file exists: it "is easy to lose quietly the first time
 * someone needs one check to look something up".
 *
 * Synchronicity is already held by the type — `AxisCheck.run(input):
 * EvalIssue[]` cannot be satisfied by an async function — so the runtime
 * assertion below is a belt, not the braces. **Purity is what nothing else
 * guards**: a check can `readFileSync`, shell out or open a socket
 * synchronously and still typecheck. The import walk is the guard.
 *
 * Scope stated honestly: this walks the family's OWN sources. What
 * `@ggui-ai/design` or `@ggui-ai/protocol` do inside is their surface's
 * business; the pin is that no axis check reaches for I/O itself.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../classifier/index.js";
import { REGISTRY } from "./registry.js";
import { runGatedAxisChecks } from "./dispatch.js";
import type { AxisCheckInput } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Builtins an axis check may import: pure computation only, no I/O. */
const ALLOWED_BUILTINS = new Set(["node:crypto"]);

/** A module specifier that names a Node builtin, `node:`-prefixed or bare. */
const BUILTIN_RE =
  /^(?:node:)?(?:assert|async_hooks|buffer|child_process|cluster|console|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(?:\/.*)?$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(HERE);

const input = (sourceCode: string): AxisCheckInput => ({
  sourceCode,
  compiledCode: "compiled",
  originalPrompt: "a booking form with a list",
  classification: classifyAxes({ contract: {}, prompt: "a booking form with a list" }),
});

const FIXTURE = `
export default function Component(props: Props) {
  const submit = useAction<ActionSubmitPayload>('submit');
  return (<Card><Stack>
    <Heading level={1}>{props.title}</Heading>
    {props.items.map((i) => (<Text key={i.id}>{i.label}</Text>))}
    <Button onClick={() => submit({ id: props.id })}>Send</Button>
  </Stack></Card>);
}`;

describe("axis checks are pure and synchronous (ggui#1122)", () => {
  it("the family imports no I/O-capable builtin — every builtin it reaches for is on the pure allowlist", () => {
    expect(FILES.length).toBeGreaterThan(5);
    const offences: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (BUILTIN_RE.test(spec) && !ALLOWED_BUILTINS.has(spec)) {
          offences.push(`${file.slice(HERE.length + 1)} imports ${spec}`);
        }
      }
      // A dynamic import or a `require` re-opens every door the walk above closes.
      for (const m of src.matchAll(/\b(?:require|import)\s*\(/g)) {
        if (!/import\s*\(\s*["']\.\//.test(src.slice(m.index!, m.index! + 40))) {
          offences.push(`${file.slice(HERE.length + 1)} uses ${m[0].trim()}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("no check's `run` is an async function, and the whole registry returns an array rather than a thenable", () => {
    for (const check of REGISTRY) {
      expect(
        Object.getPrototypeOf(check.run).constructor.name,
        `${check.id}.run must be synchronous`,
      ).not.toBe("AsyncFunction");
    }
    const result = runGatedAxisChecks(REGISTRY, input(FIXTURE));
    expect(Array.isArray(result.issues)).toBe(true);
    expect(Array.isArray(result.firedIds)).toBe(true);
    // A thenable would sail through `Array.isArray` on the wrapper but not here.
    expect(typeof (result as unknown as { then?: unknown }).then).toBe("undefined");
  });

  it("the whole registry over one source is fast enough to sit in the commit path", () => {
    // Not a benchmark — a smoke ceiling. Auto-commit runs on every turn of
    // every served generation; a check that blocks for a second belongs
    // nowhere near it, and this is the line that would notice.
    const started = performance.now();
    for (let i = 0; i < 20; i++) runGatedAxisChecks(REGISTRY, input(FIXTURE));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
