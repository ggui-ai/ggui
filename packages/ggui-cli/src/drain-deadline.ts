/**
 * Bounded drain for the CLI's success path.
 *
 * `main()` resolves with an exit code and the process is expected to end on
 * its own: every command closes its handles, and a hard `process.exit()`
 * while the local embedding model is loaded aborts under ONNX Runtime's
 * parked worker threads (#855). The drain is the contract — this is what
 * happens if a future change leaks a handle: instead of a process that
 * never ends (strictly worse for an operator than the abort it replaced),
 * the deadline names the live resources on stderr and hard-exits with the
 * code. The timer is unref'd so the deadline itself never keeps the loop
 * alive; a drained loop exits before it fires and nothing is written.
 */
export const DRAIN_DEADLINE_MS = 5_000;

export interface DrainDeadlineDeps {
  readonly exitCode: number;
  readonly deadlineMs: number;
  readonly exit: (code: number) => void;
  readonly stderr: (line: string) => void;
  readonly setTimer: (fn: () => void, ms: number) => { unref: () => void };
  /** `process.getActiveResourcesInfo()` — what still keeps the loop alive. */
  readonly liveResources: () => readonly string[];
}

export function armDrainDeadline(deps: DrainDeadlineDeps): void {
  const timer = deps.setTimer(() => {
    const live = deps.liveResources();
    deps.stderr(
      `ggui: shutdown did not drain within ${deps.deadlineMs}ms — live resources: ${live.length > 0 ? live.join(', ') : '(none reported)'}; exiting ${deps.exitCode}\n`,
    );
    deps.exit(deps.exitCode);
  }, deps.deadlineMs);
  timer.unref();
}
