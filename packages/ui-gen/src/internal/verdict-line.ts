/**
 * How an isolated worker that runs generated component code (the
 * runtime-render check's, the render smoke test's) hands its verdict to its
 * host.
 *
 * The worker's stdout is shared with the component: card code runs in the
 * worker's own realm with Node's `console`, so a card that logs even one line
 * would corrupt a verdict read as "the whole of stdout". The verdict
 * therefore goes out on one line carrying {@link VERDICT_PREFIX}, and the
 * host reads the LAST such line, ignoring everything else.
 */

/** The prefix of the verdict line. Not a string a card would print by accident. */
export const VERDICT_PREFIX = '@@ggui-render-check-verdict@@';

/** The worker's verdict line, newline-terminated. */
export function formatVerdictLine(value: unknown): string {
  return `${VERDICT_PREFIX} ${JSON.stringify(value)}\n`;
}

/**
 * The value on the last verdict line in `stdout`, or `undefined` when no
 * line carries the prefix. A prefixed line that is not JSON throws, so the
 * host can report it as such.
 */
export function parseVerdictLine<Verdict>(stdout: string): Verdict | undefined {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.startsWith(`${VERDICT_PREFIX} `)) return JSON.parse(line.slice(VERDICT_PREFIX.length + 1)) as Verdict;
  }
  return undefined;
}
