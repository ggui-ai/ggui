// ggui#1934 — the bench stops before any cell when the render worker cannot run a check. A runner image
// missing a served design specifier crashes every check's worker, and per cell that reads as an
// `unverified` warn that scores as a passing probe; the warm-up gate makes it a stopped run instead.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RENDER_WORKER_WARM_OK, gateRenderWorker } from "./runner.js";

describe("the render worker gate (ggui#1934)", () => {
  it("passes and logs the receipt line when the worker warms", async () => {
    const lines: string[] = [];
    await gateRenderWorker(async () => ({ ok: true, ms: 480 }), (l) => lines.push(l));
    expect(lines).toEqual([`${RENDER_WORKER_WARM_OK} in 480ms`]);
  });

  it("stops the run and logs the worker's reason when it cannot run a check", async () => {
    const lines: string[] = [];
    const reason = "render-no-throw unverified: render check worker exited 1 — ERR_PACKAGE_PATH_NOT_EXPORTED";
    await expect(gateRenderWorker(async () => ({ ok: false, ms: 510, kind: "blocking", reason }), (l) => lines.push(l))).rejects.toThrow(
      /render worker warm-up failed \(blocking\); the run stopped before any cell/,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("FAILED (blocking)");
    expect(lines[0]).toContain(reason);
  });

  it("an incomplete warm-up logs a WARN without the ok receipt and the run proceeds", async () => {
    const lines: string[] = [];
    const reason = "render check did not finish within 20000 ms";
    await expect(gateRenderWorker(async () => ({ ok: false, ms: 20010, kind: "incomplete", reason }), (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines).toEqual([`[benchmark] render worker warm: INCOMPLETE in 20010ms — ${reason}; proceeding`]);
    expect(lines[0]).not.toContain(RENDER_WORKER_WARM_OK);
  });

  it("a spawn failure stops the run", async () => {
    await expect(gateRenderWorker(async () => ({ ok: false, ms: 3, kind: "spawn", reason: "no node binary" }), () => {})).rejects.toThrow(/\(spawn\)/);
  });

  it("bench.mjs awaits the gate before the run starts", () => {
    const src = readFileSync(new URL("../../scripts/bench.mjs", import.meta.url), "utf8");
    const gate = src.indexOf("await gateRenderWorker();");
    const run = src.indexOf("await runner.run(");
    expect(gate).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(gate);
  });

  it("the default warm-up is the real worker spawn and warms here", async () => {
    const lines: string[] = [];
    await gateRenderWorker(undefined, (l) => lines.push(l));
    expect(lines[0]).toMatch(/^\[benchmark\] render worker warm: ok in \d+ms$/);
  }, 30000);
});
