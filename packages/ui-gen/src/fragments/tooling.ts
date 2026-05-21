// packages/ui-gen/src/fragments/tooling.ts
//
// tooling-axis fragments. The contract carries two tooling surfaces:
//
//   - `agentCapabilities.tools` — catalog of agent-invoked tools the
//     contract references via `actionSpec[*].nextStep` and
//     `streamSpec[*].source.tool`. NO component-side hook surface.
//   - `clientCapabilities.gadgets` — catalog of browser-capability
//     gadget hooks (geolocation, mic, camera, clipboard, file picker,
//     notifications). The component imports + calls these hooks
//     from `@ggui-ai/gadgets` (or the third-party package named in
//     `entry.package`).
//
// The `wired` / `client` / `both` axis values map onto these surfaces
// by what the contract carries; the prompt text steers the LLM toward
// the correct patterns.

import type { HarnessFragment } from "./types.js";

export const toolingFragments: Record<string, HarnessFragment> = {
  none: {
    axis: "tooling",
    value: "none",
    cacheTier: "axisDelta",
    // Nothing to say — contract carries no agentCapabilities.tools /
    // clientCapabilities.gadgets.
  },
  wired: {
    axis: "tooling",
    value: "wired",
    cacheTier: "axisDelta",
    promptText:
      "## Tooling: agent-side tools (catalog only)\nThe contract declares `agentCapabilities.tools[X]` for tools the AGENT invokes — the component never calls these directly. References surface via `actionSpec[Y].nextStep = 'X'` (the agent's next-turn hint forwarded on action events) and `streamSpec[Z].source.tool = 'X'` (the runtime polls / subscribes the tool, deliveries land on the stream channel). Author UI controls fire actions via `useAction`; data feeds appear via `useStream`. The `useWiredTool` hook from before 2026-05-11 is RETIRED.",
  },
  client: {
    axis: "tooling",
    value: "client",
    cacheTier: "axisDelta",
    promptText:
      "## Tooling: gadgets (browser-capability hooks)\nThe contract declares `clientCapabilities.gadgets[X]` for browser-capability gadget hooks the UI mounts. The boilerplate has pre-emitted a direct import per gadget package — `import { useFoo, useBar } from '<package>';` — above a `// DO NOT EDIT` banner (STDLIB hooks come from `@ggui-ai/gadgets`, third-party hooks from the package on `clientCapabilities.gadgets[*].package`). Call the imported hook inside the component (`const loc = useGeolocation();`) and trigger via `.start()` from a UI control. Read `.value` / `.status` to render. If the agent needs to observe the result, thread `.value` into a `contextSpec` slot or an `actionSpec` payload. Library hooks are UI-owned lifecycle; the agent never invokes them. **KEEP every pre-emitted gadget import — do NOT delete it and do NOT change its package**; self_check rejects the code with `gadget_preservation:<hook>` if a gadget import disappears. The pre-2026-05-11 `useClientTool(name, handler)` shape is RETIRED, as is the `@ggui-ai/client-tools` package name (renamed to `@ggui-ai/gadgets`).",
  },
  both: {
    axis: "tooling",
    value: "both",
    cacheTier: "axisDelta",
    promptText:
      "## Tooling: both surfaces present\nThe contract declares BOTH `agentCapabilities.tools` (agent-invoked catalog; referenced via `actionSpec.nextStep` / `streamSpec.source.tool` — NO component hook) AND `clientCapabilities.gadgets` (browser-capability gadget hooks the component direct-imports — the boilerplate pre-emits `import { useCamera } from '@ggui-ai/gadgets';` (STDLIB) or `import { useFoo } from '<package>';` (third-party) above a `// DO NOT EDIT` banner). Don't conflate: agentCapabilities entries are catalog declarations the agent uses, NOT component hooks. clientCapabilities entries DO emit component-side hook calls (e.g., `const cam = useCamera();`).",
  },
};
