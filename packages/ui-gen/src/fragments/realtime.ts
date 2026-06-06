// packages/ui-gen/src/fragments/realtime.ts
//
// Realtime-axis fragments. Stream semantics drive whether you merge,
// append, replace, or do nothing. "mixed" needs per-event kind dispatch.

import type { HarnessFragment } from "./types.js";

export const realtimeFragments: Record<string, HarnessFragment> = {
  none: {
    axis: "realtime",
    value: "none",
    cacheTier: "axisDelta",
  },
  merge: {
    axis: "realtime",
    value: "merge",
    cacheTier: "axisDelta",
    promptText:
      "## Realtime: merge\nStream events carry an id; merge into LOCAL STATE. Subscribing alone is not enough — the local list must update on each event for the DOM to re-render.\n\n```tsx\nconst stream = useStream<UpdateT>('streamName');\nconst [items, setItems] = useState(props.items);\nuseEffect(() => {\n  if (!stream.latest) return;\n  setItems((prev) => prev.map((it) => it.id === stream.latest!.id ? { ...it, ...stream.latest } : it));\n}, [stream.latest]);\n// Render `items.map(...)` — NOT props.items, NOT stream.all.\n```\n\nNever append — stream=merge means the entity already exists locally.",
  },
  append: {
    axis: "realtime",
    value: "append",
    cacheTier: "axisDelta",
    promptText:
      "## Realtime: append\nStream events are new entities; APPEND to local state. Subscribing alone is not enough — the local list must update for the DOM to re-render.\n\n```tsx\nconst stream = useStream<EventT>('streamName');\nconst [items, setItems] = useState(props.items);\nuseEffect(() => {\n  if (!stream.latest) return;\n  setItems((prev) => [...prev, stream.latest!]);\n}, [stream.latest]);\n// Render `items.map(...)` — NOT props.items, NOT stream.all (which accumulates only post-mount).\n```\n\nUse head for newest-first, tail for chat-style. Cap list length if needed. Do not dedupe unless the contract guarantees at-most-once.",
  },
  status: {
    axis: "realtime",
    value: "status",
    cacheTier: "axisDelta",
    promptText:
      "## Realtime: status\nStream replaces a singleton (e.g., marketStatus, rideStatus). `stream.latest` is the current value — bind directly into JSX, no local state needed for the singleton itself:\n\n```tsx\nconst statusStream = useStream<StatusT>('streamName');\nconst status = statusStream.latest;\n// Render `<Badge>{status?.state ?? 'loading'}</Badge>`.\n```\n\nIf you also need the timestamp of the last update, derive it from `useEffect` on `statusStream.latest`.",
  },
  presence: {
    axis: "realtime",
    value: "presence",
    cacheTier: "axisDelta",
    promptText:
      "## Realtime: presence\nEphemeral per-user state (typing, cursors, online). Do NOT persist to a list. Sync into a `Set` and clear entries based on the active flag or a timeout:\n\n```tsx\nconst stream = useStream<{ sender: string; active: boolean }>('streamName');\nconst [active, setActive] = useState<Set<string>>(new Set());\nuseEffect(() => {\n  if (!stream.latest) return;\n  setActive((prev) => {\n    const next = new Set(prev);\n    if (stream.latest!.active) next.add(stream.latest!.sender);\n    else next.delete(stream.latest!.sender);\n    return next;\n  });\n}, [stream.latest]);\n```",
  },
  mixed: {
    axis: "realtime",
    value: "mixed",
    cacheTier: "axisDelta",
    promptText:
      "## Realtime: mixed\nMultiple stream channels with DIFFERENT semantics. Each `streamKinds` entry in the contract maps to one of: merge, append, status, presence. Subscribe + sync to local state PER CHANNEL — subscribing alone never re-renders the DOM.\n\nExample (chat-interface — message=append, typing=presence):\n\n```tsx\nconst messages = useStream<MessageT>('message');\nconst typing = useStream<TypingT>('typing');\nconst [messageList, setMessageList] = useState(props.messages);\nconst [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());\n\nuseEffect(() => {\n  if (!messages.latest) return;\n  setMessageList((prev) => [...prev, messages.latest!]);\n}, [messages.latest]);\n\nuseEffect(() => {\n  if (!typing.latest) return;\n  setTypingUsers((prev) => {\n    const next = new Set(prev);\n    if (typing.latest!.active) next.add(typing.latest!.sender);\n    else next.delete(typing.latest!.sender);\n    return next;\n  });\n}, [typing.latest]);\n```\n\nDo NOT treat all events the same. Do NOT skip the local-state sync — `useStream` alone won't trigger DOM updates of your derived view.",
    boilerplateMarker: [
      "",
      "  // ── Mixed stream handlers ──",
      "  // One useStream + useEffect+setState per channel — see realtime fragment.",
      "",
    ].join("\n"),
  },
};
