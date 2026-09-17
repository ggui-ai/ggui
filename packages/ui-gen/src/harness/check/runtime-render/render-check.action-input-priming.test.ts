// @vitest-environment happy-dom
// ggui#1187 — the action-wiring probe must prime form inputs before its
// synthetic dispatch, or a WIRED Send button gated on a non-empty input
// (the chat-interface shape) false-warns "did not dispatch it". RED before
// the priming fix, GREEN after. The genuinely-unwired case must still warn
// (guarded by the existing runtime-render.test.ts broken-wiring test).

import { describe, it, expect } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import { runRenderCheck } from "./render-check.js";

const CHAT_CARD = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

interface Props { title: string; }

export default function Component(props: Props) {
  const sendMessage = useAction('sendMessage');
  const [text, setText] = useState('');
  const onSend = () => {
    if (text.trim().length === 0) return; // input-gated: a no-op on empty
    sendMessage({ text });
    setText('');
  };
  return (
    <div>
      <h1>{props.title}</h1>
      <input
        aria-label="message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message"
      />
      <button onClick={onSend}>Send</button>
    </div>
  );
}
`;

describe("runRenderCheck — input-gated action wiring (ggui#1187)", () => {
  it("does not false-warn on a wired Send that requires a non-empty input", async () => {
    const contract: DataContract = {
      propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
      actionSpec: { sendMessage: { label: "Send" } },
    };
    const result = await runRenderCheck({
      sourceCode: CHAT_CARD,
      mockupProps: { title: "Chat" },
      contract,
    });
    const wiringIssue = result.issues.find(
      (i) => i.check === "action-wiring" && i.subject === "sendMessage",
    );
    expect(wiringIssue).toBeUndefined();
  }, 30000);
});
