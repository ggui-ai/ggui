import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';

/**
 * Per-variant console tagging for paired cell processes (ggui#1282).
 *
 * A bench cell process runs several variants CONCURRENTLY, and the harness's
 * console lines (`[simple] turn …`, `[coding-agent] apply_changes …`,
 * `[<provider>] callTools cache: …`, `SAME_EXCHANGE_BREAK …`) carry no
 * variant identity — two same-provider arms even share one prefix — so a log
 * reader cannot attribute a line to an arm. Running each variant's cell inside
 * {@link runWithVariantTag} and installing {@link installVariantConsoleTag}
 * once prefixes every line written in that cell — including everything it
 * awaits — with `[v:<variantId>] `. Lines written outside any cell are left
 * exactly as they were. Scoped to the bench runner: the generator's own
 * logging is not changed.
 */

/** The cell a line belongs to: its arm, and the prompt (commit) when the caller names one. */
interface CellTag {
  readonly variantId: string;
  readonly commitId: string | undefined;
}

const variantStore = new AsyncLocalStorage<CellTag>();

/**
 * Run `fn` so every console line written inside it (and in what it awaits) carries this variant's
 * tag, and the cell's prompt after it when `commitId` is given. An arm runs its prompts concurrently,
 * so the arm alone cannot attribute a line to a cell.
 */
export function runWithVariantTag<T>(variantId: string, fn: () => Promise<T>, commitId?: string): Promise<T> {
  return variantStore.run({ variantId, commitId }, fn);
}

/** The variant whose cell is running in the current async context, if any. */
export function currentVariantTag(): string | undefined {
  return variantStore.getStore()?.variantId;
}

/** The tag a line carries — exported so log readers match the exact form. */
export function variantTagPrefix(variantId: string): string {
  return `[v:${variantId}] `;
}

/** The cell tag that follows the variant tag when a cell named its prompt: `[c:<commitId>] `. */
export function cellTagPrefix(commitId: string): string {
  return `[c:${commitId}] `;
}

const TAGGED_METHODS = ['log', 'info', 'warn', 'error'] as const;
const installed = new WeakMap<Console, () => void>();

/**
 * Wrap `target`'s log / info / warn / error so a line written inside a
 * variant's context carries {@link variantTagPrefix} at the start of EVERY
 * line (a multi-line message is tagged per line, so a line-oriented reader
 * still attributes each one). Lines outside any context pass through
 * untouched. Idempotent per console: a second install returns the first
 * install's restore function instead of wrapping twice.
 *
 * @returns a function that restores the console's original methods.
 */
export function installVariantConsoleTag(target: Console = console): () => void {
  const existing = installed.get(target);
  if (existing !== undefined) return existing;
  const originals = TAGGED_METHODS.map((m) => [m, target[m]] as const);
  for (const [m, original] of originals) {
    target[m] = (...args: Parameters<Console['log']>): void => {
      const tag = variantStore.getStore();
      if (tag === undefined) {
        original.apply(target, args);
        return;
      }
      const prefix = variantTagPrefix(tag.variantId) + (tag.commitId !== undefined ? cellTagPrefix(tag.commitId) : '');
      original.call(
        target,
        format(...args)
          .split('\n')
          .map((line) => prefix + line)
          .join('\n'),
      );
    };
  }
  const restore = (): void => {
    for (const [m, original] of originals) target[m] = original;
    installed.delete(target);
  };
  installed.set(target, restore);
  return restore;
}
