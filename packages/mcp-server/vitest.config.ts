import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Heavy esbuild/render/compile tests cross vitest's 5000ms default
    // under cold-cache 2-core CI concurrency; match the genuine work
    // (mirrors @ggui-ai/ui-gen). A real hang still surfaces in-budget.
    //
    // LOOPBACK ROUND-TRIP CARVE-OUT (#458). This 30s is the budget for
    // tests that DO 30s of work. A second shape in this package does
    // none: ten middleware/route suites spin a throwaway
    // `app.listen(0)` per request and await one loopback round-trip,
    // finishing in single-digit milliseconds — and two of them
    // (`browser-cors`, `email-login`) have nonetheless burned the full
    // 30s under load from a concurrent run, then passed standalone
    // every time after.
    //
    // Those tests do not exceed the budget by doing more work — they do
    // none. They sit on a socket round-trip with no timeout of their
    // own, and `testTimeout` is wall-clock: it keeps running while the
    // process is descheduled. So the budget for this shape has to
    // exceed any wait a loaded box can impose on a round-trip that
    // itself will never give up, and 30s demonstrably does not. That
    // argument stands on the observed facts alone — a 15ms test that
    // burned 30s and then passed standalone — and does not depend on
    // knowing which wait it was.
    //
    // The exact mechanism is NOT established. Event-loop / CPU
    // starvation fits what we saw (the connection completes and sits
    // unaccepted, or the callback is descheduled, while wall-clock
    // runs). A dropped SYN retransmitted on the kernel's backoff would
    // also produce a ~30s wait, but is an unlikely candidate here: each
    // test connects once to its own fresh listener, whose accept queue
    // external load cannot fill. Do not harden either story into a
    // number without evidence.
    //
    // 60s is headroom over the ceiling these tests were observed to
    // hit, not a derived floor: nothing here proves 60s is enough, only
    // that 30s was not. If one of the ten times out again at exactly
    // 60s, that is the same signal a second time — capture what the
    // process was doing before widening it further.
    //
    // The carve-out is per-file (`vi.setConfig({ testTimeout })` at the
    // top of each of the ten), never here: raising the package budget
    // would blunt the hang detector for the heavy files, which are the
    // ones this 30s was chosen for. A new suite that boots a listener
    // per request wants the same line; one that boots once in a fixture
    // does not.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
