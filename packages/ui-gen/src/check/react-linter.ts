// packages/ui-gen/src/check/react-linter.ts
//
// React linter — runs eslint-plugin-react-hooks via ESLint's Linter API.
//
// Exposed on `@ggui-ai/ui-gen/check` so `createUiGenerator` can invoke
// the same lint gate as the hosted generation path.
//
// Dep surface: the linter imports the `Linter` / `Rule` types from
// `eslint` at module load and lazily imports `@typescript-eslint/parser`,
// `eslint-plugin-react-hooks`, and `eslint-plugin-react` inside
// `getLinter()` — those four packages are runtime deps of this package.
//
// Catches Rules of Hooks violations that the TS type-checker misses:
//   - Hooks inside conditionals, loops, nested functions
//   - Hooks after early returns
//   - Missing/extra dependencies in useEffect/useMemo/useCallback
//
// Also carries the core ESLint `no-unused-vars` rule to
// catch wire hooks the LLM declared but never consumed — an unused
// `const submit = useAction('submit')` ships a subscription with no
// render/callback wiring and will not actually drive the UI. Rule 14
// (`wire_preservation`) in self-check.ts catches the DELETION case;
// this lint pass catches the ABANDONMENT case. Together they seal
// bidirectional contract completeness: contract -> code.
//
// Uses the lightweight Linter API (no file system, no config resolution).
// Runs in parallel with the TS type-checker during self-check.

import { Linter, type Rule } from 'eslint';

export interface ReactLintDiagnostic {
  rule: string;
  line: number;
  message: string;
  fix: string;
  severity: 'error' | 'warning';
}

// Singleton Linter instance — reused across calls.
let linterInstance: Linter | null = null;

async function getLinter(): Promise<Linter> {
  if (!linterInstance) {
    linterInstance = new Linter();

    // Register @typescript-eslint/parser so ESLint can parse TS/TSX
    const tsParser = await import('@typescript-eslint/parser');
    linterInstance.defineParser('@typescript-eslint/parser', tsParser as Linter.Parser);

    // Register react-hooks plugin rules
    const reactHooksPlugin = await import('eslint-plugin-react-hooks');
    const hooksRules = reactHooksPlugin.default?.rules ?? reactHooksPlugin.rules;
    for (const [name, rule] of Object.entries(hooksRules)) {
      linterInstance.defineRule(`react-hooks/${name}`, rule as Rule.RuleModule);
    }

    // Register eslint-plugin-react rules
    const reactPlugin = await import('eslint-plugin-react');
    const reactRules = reactPlugin.default?.rules ?? reactPlugin.rules;
    for (const [name, rule] of Object.entries(reactRules)) {
      linterInstance.defineRule(`react/${name}`, rule as Rule.RuleModule);
    }
  }
  return linterInstance;
}

/**
 * Lint TSX code for React hooks violations.
 * Returns diagnostics with line numbers and fix suggestions.
 */
export async function lintReactHooks(code: string): Promise<ReactLintDiagnostic[]> {
  const linter = await getLinter();

  let messages: Linter.LintMessage[];
  try {
    const config: Linter.LegacyConfig = {
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      rules: {
        'react-hooks/rules-of-hooks': 2,
        'react-hooks/exhaustive-deps': 1,
        // React rules
        'react/jsx-no-undef': 2,           // undefined JSX components
        'react/jsx-key': 1,                // missing key in lists
        'react/no-direct-mutation-state': 2, // direct state mutation
        // An unused `const submit = useAction('submit')` is a
        // dead contract wire. Narrow the rule to variable bindings we
        // care about: skip function args (LLMs legitimately omit unused
        // params), skip destructured `rest` collectors, respect a `_`-
        // prefix escape hatch for intentionally-ignored declarations,
        // and silence the caught-error slot (async error handling can
        // leave `catch (err)` unused at a boundary).
        'no-unused-vars': [2, {
          vars: 'all',
          args: 'none',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        }],
      },
      settings: {
        react: { version: '19.0' },
      },
    };
    messages = linter.verify(code, config, { filename: 'component.tsx' });
  } catch {
    // Parser not available or code too malformed — skip
    return [];
  }

  const diagnostics: ReactLintDiagnostic[] = [];

  // Rules surfaced from the Linter run. `no-unused-vars` is the core
  // ESLint rule (no plugin prefix) — admitted alongside react-hooks/
  // and react/ rules so the no-unused-vars diagnostic reaches self_check.
  const ADMITTED_RULES = (id: string): boolean =>
    id.startsWith('react-hooks/') ||
    id.startsWith('react/') ||
    id === 'no-unused-vars';

  for (const msg of messages) {
    // Skip parser errors — caught by TS type-checker
    if (!msg.ruleId) continue;
    if (!ADMITTED_RULES(msg.ruleId)) continue;

    diagnostics.push({
      rule: msg.ruleId,
      line: msg.line,
      message: msg.message,
      fix: generateReactFix(msg.ruleId, msg.message),
      severity: resolveSeverity(msg, code),
    });
  }

  return diagnostics;
}

/**
 * Resolve the self-check severity of a lint diagnostic.
 *
 * Most rules map straight from ESLint severity (2 → error, 1 → warning).
 * `no-unused-vars` is special-cased: it stays a hard `error` ONLY when
 * the unused binding is a CONTRACT WIRE — `const x = useAction(...)` /
 * `useStream(...)` / `useGguiContext(...)` — because an abandoned wire
 * ships a dead subscription. For every other unused binding (a local
 * helper the LLM declared mid-generation, a `useMemo` result, a state-
 * read gadget binding) it is downgraded to `warning`.
 *
 * Rationale: a half-wired local helper is transient coding state, not a
 * defect — blocking tier-0 self-check on it forces a whole coding-turn
 * round-trip and is the single largest turn-thrash driver on the
 * benchmark (kanban/chat hit the turn cap oscillating on `'handleNext'
 * is assigned a value but never used`). The dead-CONTRACT-wire case it
 * was built to catch is independently enforced at
 * `error` severity by `validateActionSpecConformance` /
 * `validateStreamSpecConformance` in contract-validation.ts, so the
 * downgrade loses no correctness coverage. The diagnostic still surfaces
 * as a `warn` and is fed back to the LLM during eval rounds.
 */
function resolveSeverity(
  msg: Linter.LintMessage,
  code: string,
): 'error' | 'warning' {
  const base: 'error' | 'warning' = msg.severity === 2 ? 'error' : 'warning';
  if (msg.ruleId !== 'no-unused-vars' || base !== 'error') return base;
  const name = msg.message.match(/'([^']+)'/)?.[1];
  if (name === undefined) return 'warning';
  // Escape regex metacharacters in the identifier (defensive — JS
  // identifiers can't contain them, but the message text is untrusted).
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Contract-wire binding. Two declaration shapes:
  //   - direct:       `const submit = useAction('submit')`
  //   - destructured: `const [step, setStep] = useGguiContext<number>('step')`
  // The destructured form covers `useGguiContext` (and a defensive
  // `useStream`), where the unused name is one tuple slot.
  const directRe = new RegExp(
    `\\bconst\\s+${safe}\\s*=\\s*use(Action|Stream|GguiContext)\\s*[<(]`,
  );
  const destructuredRe = new RegExp(
    `\\bconst\\s+\\[[^\\]]*\\b${safe}\\b[^\\]]*\\]\\s*=\\s*use(Action|Stream|GguiContext)\\s*[<(]`,
  );
  return directRe.test(code) || destructuredRe.test(code)
    ? 'error'
    : 'warning';
}

function generateReactFix(ruleId: string, message: string): string {
  if (ruleId === 'react-hooks/rules-of-hooks') {
    if (message.includes('called conditionally')) {
      return 'Move this hook to the top level of the component, before any early returns or conditionals. Hooks must run in the same order every render.';
    }
    return 'Hooks can only be called at the top level of a React function component or custom hook. Move it out of any conditional, loop, nested function, or callback.';
  }
  if (ruleId === 'react-hooks/exhaustive-deps') {
    return 'Add the missing dependencies to the dependency array, or remove the array to run on every render.';
  }
  if (ruleId === 'react/jsx-no-undef') {
    const match = message.match(/'(\w+)'/);
    const name = match?.[1] ?? 'Component';
    return `'${name}' is not defined. Import it from the design system or define it in the file.`;
  }
  if (ruleId === 'react/jsx-key') {
    return 'Add a unique "key" prop to each element rendered inside a .map() or iterator.';
  }
  if (ruleId === 'react/no-direct-mutation-state') {
    return 'Do not mutate state directly. Use setState or the setter from useState instead.';
  }
  if (ruleId === 'no-unused-vars') {
    // Extract the identifier name from the ESLint message shape:
    //   "'submit' is assigned a value but never used." (varsIgnorePattern also referenced)
    const match = message.match(/'([^']+)'/);
    const name = match?.[1] ?? 'variable';
    // Wire-hook shape — if the binding is an obvious contract wire, route
    // the LLM to the right remediation. Heuristic lives on the message
    // text because we only see the rule output here, not the AST.
    const isLikelyWireBinding = /\bconst\s+[A-Za-z_$][\w$]*\s*=\s*use(Action|Stream)\s*\(/.test(message);
    if (isLikelyWireBinding || /^(submit|cancel|search|progress|snapshot)$/.test(name)) {
      return `'${name}' is declared but never used. If this binding came from a wire hook (useAction / useStream) or a clientCapabilities hook (useGeolocation / useCamera / etc. from @ggui-ai/gadgets), consume it somewhere in the component — render its value in JSX, bind it to a callback prop, or use it in an effect. A contract-declared hook without consumption is a dead wire.`;
    }
    return `'${name}' is declared but never used. Remove the declaration, or consume it somewhere in the component. Prefix with '_' (e.g. '_${name}') to mark it intentionally unused.`;
  }
  return 'Fix the React violation.';
}
