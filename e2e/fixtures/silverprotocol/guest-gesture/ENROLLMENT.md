# Enrollment draft: `guest-gesture` (Layer-B, ggui-authored)

> Draft of record for the silverprotocol/workspace filing. The controller posts
> this text upstream after the ggui-side merge; until enrollment lands, the
> transcript homes here (same directory family as `fixtures.lock.json`, same
> stable/incidental discipline as the pinned corpus). Post-enrollment the lock
> covers it like any corpus member and this local copy retires.

## Scenario intent

One complete client→host **gesture round-trip** on an MCP-Apps render:

1. `ggui_render` tool result — the MCP-Apps bootstrap (`_meta.ui.resourceUri`
   entry point, `ai.ggui/render` slice, `structuredContent` with the
   `nextStep → ggui_consume` hint).
2. The user acts on the rendered iframe → `tools/call
ggui_runtime_submit_action` (`kind: "dispatch"` envelope: intent +
   actionData + uiContext snapshot).
3. The server accepts but reports `consumerPresent: false` (no `ggui_consume`
   long-poll listening) → the iframe rings the **pure doorbell**: a
   `ui/message` whose text is the full agent directive and whose content-block
   `_meta["ai.ggui/userAction"]` is the structured mirror. Pointer-only — the
   gesture payload never travels inline (exactly-once by construction).
4. A fresh agent turn obeys the directive: `tools/call ggui_consume` drains the
   pipe; the result carries the gesture as a `ConsumeEventEntry`
   (`{type:"action", intent, actionData, uiContext, actionId, firedAt}`).

## Why Layer-B (authored, not captured)

This is the one scenario no agent framework's **server-side stream** contains:
the round-trip originates in the client iframe and re-enters through the host,
so Claude Agent SDK / ADK / OpenAI Agents captures structurally cannot carry
it. Per the negotiated Phase-4 terms, authorship of this leg landed on ggui's
side. It is authored **from real shapes** (see `ggui.provenance.json` for the
per-frame source map): the runtime IS the framework here, and every frame is
the byte shape the shipping code path emits — which is how it meets the
"real framework wire" half of the acceptance filter.

## Stable set for this transcript (safe to assert)

- **Frame types + ordering**: tool result → `tools/call` → result →
  `ui/message` → `tools/call` → result (the six-frame round-trip above).
- **Tool / method names**: `ggui_runtime_submit_action`, `ggui_consume`,
  `ui/message`; `nextStep.tool === "ggui_consume"` on both the render
  `structuredContent` and the `ai.ggui/userAction` mirror.
- **Scenario intent**: exactly one gesture; the doorbell fires only on
  `consumerPresent: false`; the consume result drains exactly that gesture.
- **Structural shape**: `_meta.ui.resourceUri` present on the render result;
  the doorbell's content block carries non-empty `text` AND
  `_meta["ai.ggui/userAction"]` with `kind: "user-action"`; the consume entry
  is `{type:"action", sessionId, intent, actionData, uiContext, actionId,
firedAt}`.
- **Correlation equalities**: ONE `sessionId` threads render → gesture →
  doorbell → consume; the gesture's `actionId` reappears on the doorbell
  mirror and the drained entry. (Stable as _equalities across frames_; the
  literal values are incidental.)

## Incidental (never assert)

Directive prose wording (ggui tunes it; the _forwarding_ of the text is the
behavior, not its content), all literal ids (`sessionId`, `actionId`,
`blueprintId`, JSON-RPC ids), hashes (`contractHash`, `variantKey`),
timestamps, `propsJson` content, cache-marker details, timeout values.

## Acceptance-filter case ("real framework wire + spec-relevant to any consumer")

- **Real framework wire**: every frame is the exact envelope ggui's shipping
  runtime/server emits (per-frame source map in `ggui.provenance.json`); the
  `ui/message` frame is a verbatim copy of the production `postToParent` call.
  For a client-originated scenario there is no other honest capture point —
  the iframe runtime is the wire producer.
- **Spec-relevant to any consumer**: every MCP-Apps host that mounts an
  interactive iframe faces this loop — a user gesture that must reach the
  agent through the host (`ui/message` per SEP-1865) followed by a tool call
  that retrieves it. The doorbell/drain split (pointer over `ui/message`,
  payload over `tools/call`) is the generic exactly-once answer any consumer
  can test against, not a ggui-only quirk.
