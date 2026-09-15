/**
 * Pin (ggui#1108, the MITIGATION leg): a control whose action the user means
 * ONCE, with nothing in the component disabling it after it fires, is one
 * double-click away from doing it twice. The check WARNS — terminality lives in
 * the request and the contract, never in a name, so a static rule may suspect
 * it and must not refuse over it.
 *
 * It is the eval third of a triad change; the prompt's `TERMINAL_ACTIONS`
 * section is the load-bearing leg, and the boilerplate's site hint the
 * smallest (a site comment alone moves generation by roughly nothing —
 * reliability Exp 002b, adoption 1/36).
 */
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS, findUnguardedTerminalControls } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.terminal_action_unguarded")!;
const input = (sourceCode: string): AxisCheckInput => ({
  sourceCode,
  compiledCode: "compiled",
  originalPrompt: "a booking form",
  classification: classifyAxes({ contract: {}, prompt: "a booking form" }),
});

const UNGUARDED = `
export default function C(props: Props) {
  const submitBooking = useAction<ActionSubmitBookingPayload>('submitBooking');
  return (<Card><Stack>
    <Input value={name} onChange={setName} />
    <Button onClick={() => submitBooking({ name })}>Confirm booking</Button>
  </Stack></Card>);
}`;

const GUARDED = `
export default function C(props: Props) {
  const [submitted, setSubmitted] = useState(false);
  const submitBooking = useAction<ActionSubmitBookingPayload>('submitBooking');
  return (<Card><Stack>
    <Button disabled={submitted} onClick={() => { submitBooking({ name }); setSubmitted(true); }}>
      {submitted ? 'Booking confirmed' : 'Confirm booking'}
    </Button>
  </Stack></Card>);
}`;

const REPEATABLE = `
export default function C(props: Props) {
  const sendMessage = useAction<ActionSendMessagePayload>('sendMessage');
  const addItem = useAction<ActionAddItemPayload>('addItem');
  return (<Stack>
    <Button onClick={() => sendMessage({ text })}>Send</Button>
    <Button onClick={() => addItem({ id })}>Add item</Button>
  </Stack>);
}`;

describe("universal.terminal_action_unguarded (ggui#1108 mitigation)", () => {
  it("WARNS on a terminal action with no guard anywhere in the component, naming what it saw", () => {
    expect(findUnguardedTerminalControls(UNGUARDED)).toEqual(["submitBooking", "Confirm booking"]);
    const issues = check.run(input(UNGUARDED));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ tier: 0, result: "warn", subcategory: "universal.terminal_action_unguarded" });
    expect(issues[0]!.description).toContain('"submitBooking"');
    expect(issues[0]!.fix).toMatch(/disabled=\{submitted\}/);
    // A warn, never a refusal: the component still passes the tier.
    expect(issues.some((i) => i.result === "fail")).toBe(false);
  });

  it("says nothing when the component guards its control — any guard, however written", () => {
    expect(findUnguardedTerminalControls(GUARDED)).toEqual([]);
    expect(check.run(input(GUARDED))).toEqual([]);
    const ariaGuard = UNGUARDED.replace("<Button onClick", "<Button aria-disabled={sent} onClick");
    expect(check.run(input(ariaGuard))).toEqual([]);
  });

  it("says nothing about actions the user CAN mean repeatedly (send, add, toggle, refresh)", () => {
    expect(findUnguardedTerminalControls(REPEATABLE)).toEqual([]);
    expect(check.run(input(REPEATABLE))).toEqual([]);
  });

  it("matches WORDS, not substrings: `bookmarkItem` and a `payload` are not bookings or payments", () => {
    const falseFriends = `
export default function C() {
  const bookmarkItem = useAction<ActionBookmarkItemPayload>('bookmarkItem');
  const payload = { x: 1 };
  return (<Button onClick={() => bookmarkItem(payload)}>Bookmark</Button>);
}`;
    expect(findUnguardedTerminalControls(falseFriends)).toEqual([]);
    // …while a camelCase terminal name IS caught, which a `\bsubmit\b` regex would miss.
    expect(findUnguardedTerminalControls(`const submitBooking = useAction('submitBooking');`)).toEqual(['submitBooking']);
  });

  it("stands down when the source did not compile (the build error owns that turn)", () => {
    expect(check.run({ ...input(UNGUARDED), compiledCode: null })).toEqual([]);
  });
});
