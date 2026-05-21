# @ggui-ai/ui-visual-tester

Behavioral validator for [ggui](https://ggui.ai)-generated component code.

Structural validators (schema checks, wire-preservation, compile/lint)
confirm that a component is _shaped_ correctly. They cannot tell you
whether a button actually _does_ anything when clicked. This package
closes that gap.

`validateContractBehavior` renders a component in a real Chromium tab
via Playwright, drives every action declared in its contract, and
classifies each one:

- **context-bound** actions (no `nextStep`) must mutate DOM bound to
  contract state.
- **agent-bound** actions (with `nextStep`) must dispatch to the agent.
- ambiguous actions accept either signal.

Failures are reported per-action (`action-no-effect`,
`action-not-rendered`, `render-failed`, `timeout`).

## Install

```bash
pnpm add @ggui-ai/ui-visual-tester
pnpm add -D playwright-core   # optional peer dependency
```

`playwright-core` is an **optional peer dependency** — the validator
does not import it directly. The caller injects the module, which keeps
the default install free of the ~300MB Chromium binary.

## Usage

```ts
import { chromium } from "playwright-core";
import { validateContractBehavior } from "@ggui-ai/ui-visual-tester";

const result = await validateContractBehavior({
  componentCode,
  contract,
  playwright: { chromium },
});

if (!result.ok) {
  for (const failure of result.failures) {
    console.error(failure.kind, failure.actionName, failure.diagnostic);
  }
}
```

Calling `validateContractBehavior` without a `playwright` module throws
`PlaywrightNotAvailableError` with a clear pointer — Chromium is opt-in
by design.

## License

Apache-2.0
