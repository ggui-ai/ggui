// ggui#1187 follow-up — the SAME input-gated Send as
// render-check.action-input-priming.test.ts, but WITHOUT the vitest
// happy-dom environment: this file runs in the node environment, so
// `runRenderCheck` installs happy-dom itself (`setupHappyDom`) exactly as the
// pod's check worker does — `window`, `document`, `HTMLElement`, `Event`, …
// on `globalThis`, and NOT `HTMLInputElement` / `HTMLTextAreaElement` /
// `HTMLSelectElement` / `CSS`. The green fixture test answered a different
// question (vitest's environment supplies those globals); the image asked
// this one, and the probe kept warning on every chat cell. RED before the
// realm-independent priming, GREEN after.

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

describe("runRenderCheck — input-gated action wiring in the worker realm (ggui#1187)", () => {
  it("primes the input without the element constructors on globalThis and does not false-warn", async () => {
    expect(typeof (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement, "precondition: node env, no DOM globals").toBe("undefined");
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
    expect(wiringIssue, `priming diagnostic: ${JSON.stringify(result.issues.map((i) => i.diagnostics?.inputPriming))}`).toBeUndefined();
  }, 30000);
});
