# @ggui-ai/blueprint-probe

> Dev / CI runtime probe for ggui blueprint manifests.

A development and continuous-integration tool that catches blueprints
which throw on initial render — hook misuse, destructuring of `undefined`,
missing prop coercions — at publish/CI time instead of at iframe-load
time.

The static gates in `@ggui-ai/registry-core`'s `checkConformance()` catch
syntax errors and shape mismatches. This probe goes one step further: it
actually compiles the blueprint, calls its default export through React's
server renderer (`renderToString`), and reports a failure if the first
render throws.

## Not a production runtime dependency

This package **executes blueprint code** via Node's `vm` module. `vm` is
not a security boundary — a malicious blueprint can climb the prototype
chain to host globals. Treat `blueprint-probe` as a dev / CI tool:

- Use it in CI, local publish flows, and authoring tooling.
- Do **not** wire it into a production path that handles untrusted
  blueprints without an additional isolation layer (a separate process
  with no secrets in its environment, or a true V8 isolate such as
  `isolated-vm`).

## Usage

```ts
import { blueprintProbeRunner } from "@ggui-ai/blueprint-probe";

const result = await blueprintProbeRunner.probe(blueprintManifest);
if (!result.ok) {
  console.error(result.errors);
}
```

`blueprintProbeRunner` implements the `BlueprintProbeRunner` interface
from `@ggui-ai/registry-core`. Wire it into the publish flow as the
optional `blueprintProbe` deps slot so static gates always run while the
runtime probe stays opt-in (it pulls `react-dom` into the import graph).

## Caveats

This is a **best-effort smoke check**, not a guarantee:

- `renderToString` is server-side — there is no `window`/`document`, and
  `useEffect` does not fire. Blueprints that synchronously touch
  `document.*`/`window.*` during render may false-positive (probe fails,
  iframe would render fine). Blueprints that surface a runtime error only
  inside `useEffect` may false-negative.
- Treat probe success as "no obvious render-time crash" — not "guaranteed
  to work in the iframe runtime".
