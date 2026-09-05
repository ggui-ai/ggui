/**
 * SPEC examples ↔ schema (ggui#803 leg 8). `check-spec-drift.mjs` compares
 * TS interfaces to SPEC §4.2/§4.3 and cannot see a zod-derived shape, so
 * `GguiRenderOutput`'s `nextStep.args` had no gate: SPEC showed
 * `{ sessionId }` while the schema requires `timeout` too (the
 * consume-recovery hint — an agent copying a timeout-less hint gets an
 * instant empty drain). This pin reads every `nextStep` example in SPEC
 * that carries `args` and asserts each names every REQUIRED key of the
 * schema's `args` object.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { renderOutputSchema } from "./mcp";

const SPEC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "docs",
  "protocol",
  "SPEC.md"
);

function requiredArgKeys(): string[] {
  const nextStep = renderOutputSchema.shape.nextStep;
  const inner = nextStep instanceof z.ZodOptional ? nextStep.unwrap() : nextStep;
  const args = (inner as z.ZodObject<z.ZodRawShape>).shape.args as z.ZodObject<z.ZodRawShape>;
  return Object.entries(args.shape)
    .filter(([, s]) => !(s instanceof z.ZodOptional))
    .map(([k]) => k);
}

// `docs/protocol/SPEC.md` lives outside the published `oss/` subtree: in the
// public mirror there is no SPEC to read, so the pin skips there BY NAME and
// runs in the monorepo, where the SPEC and the schema move together.
describe.skipIf(!existsSync(SPEC))(
  "SPEC nextStep examples name every required args key the schema demands (ggui#803 leg 8) — monorepo only: the SPEC is not in the published subtree",
  () => {
    it("the schema requires at least sessionId and timeout on nextStep.args", () => {
      expect(requiredArgKeys()).toEqual(expect.arrayContaining(["sessionId", "timeout"]));
    });

    it("every SPEC nextStep example with args carries the required keys", () => {
      const spec = readFileSync(SPEC, "utf8");
      const examples = [...spec.matchAll(/nextStep:\s*\{[^}]*?args:\s*\{([^}]*)\}/g)];
      expect(examples.length, "SPEC carries nextStep examples").toBeGreaterThan(0);
      const required = requiredArgKeys();
      const missing = examples
        .map((m) => ({ text: m[0].replace(/\s+/g, " ").slice(0, 120), keys: m[1] }))
        .filter((e) => required.some((k) => !new RegExp(`\\b${k}\\s*:`).test(e.keys)));
      expect(missing, JSON.stringify(missing)).toEqual([]);
    });
  }
);
