/**
 * ggui#1261 — a patch the engine refuses (overlap, line bounds) before anything applies is a
 * PATCH_INVALID, and says so in the log. It used to return a bare `FAILED:` with no log line, and
 * the turn classifier (PASS / PATCH_INVALID / DIFF_FAIL / else) then counted it as a
 * SELF_CHECK_FAIL that never ran: Exp 011's stuck cell lost turn 3 that way, invisibly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "../tools";
import { AgentWorkspace } from "../workspace";

describe("executeTool — apply_changes the engine refuses", () => {
  let ws: AgentWorkspace;
  const commitMeta = new Map();
  const code = `interface Props { x: number; }
export default function C(props: Props) {
  return <div aria-label="c">{props.x}</div>;
}`;

  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
    commitMeta.clear();
    await executeTool(ws, "write", { code, commit_message: "seed" }, commitMeta);
  });
  afterEach(() => vi.restoreAllMocks());

  it("an overlapping pair of changes is PATCH_INVALID, logged as REJECTED, and nothing is applied", async () => {
    const log = vi.spyOn(console, "log");
    const before = ws.read();
    const result = await executeTool(
      ws,
      "apply_changes",
      {
        changes: [
          { startLine: 2, endLine: 3, code: ["export default function C(props: Props) {", "  return <div>{props.x}</div>;"], description: "a" },
          { startLine: 3, endLine: 4, code: ["  return <span>{props.x}</span>;", "}"], description: "b" },
        ],
        commit_message: "overlap",
      },
      commitMeta,
    );
    expect(result.error).toBe(true);
    expect(result.result.startsWith("PATCH_INVALID:")).toBe(true);
    expect(result.result).toContain("overlap");
    expect(log.mock.calls.some((c) => String(c[0]).startsWith("[coding-agent] apply_changes: REJECTED |"))).toBe(true);
    expect(ws.read()).toBe(before);
  });

  it("a range past the end of the file is PATCH_INVALID too", async () => {
    const result = await executeTool(
      ws,
      "apply_changes",
      { changes: [{ startLine: 40, endLine: 41, code: ["x"], description: "past the end" }], commit_message: "oob" },
      commitMeta,
    );
    expect(result.error).toBe(true);
    expect(result.result.startsWith("PATCH_INVALID:")).toBe(true);
  });
});
