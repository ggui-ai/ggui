/**
 * Vitest setup file — runs once before each test file.
 *
 * Installs `globalThis.IS_REACT_ACT_ENVIRONMENT = true` so React 19
 * recognizes the jsdom test environment as act-capable. Without this
 * flag the the renderer specs see "The current testing
 * environment is not configured to support act(...)" warnings on
 * every render cycle.
 */
export {};

// React 19 reads this flag off `globalThis` to detect a test env.
// The flag is NOT declared on `Window`/`typeof globalThis` in React's
// public types; we widen via an ambient global declaration. The
// wrapping `declare global` block works ONLY inside a module (the
// `export {}` above turns this file into one).
declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
