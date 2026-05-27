// Structural drift guards for the `ggui_emit` tool contract.
//
// The rewrite locked a small agent-facing surface — these assertions
// guarantee that future edits to GguiEmitInput/GguiEmitOutput do
// not silently re-introduce retired fields or drop required ones.
// This file should compile with zero errors — that IS the test. Any
// future PR that drifts the tool surface surfaces here as a type error.
//
// Run via: pnpm --filter @ggui-ai/protocol typecheck
import type { GguiEmitInput, GguiEmitOutput } from '../mcp';
import type { JsonValue } from '../data-contract';

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;

// ── GguiEmitInput — keys lock ────────────────────────────────────
//
// Exactly these four field names appear on the tool input. Adding a
// new property causes this assertion to flip, forcing the author to
// revisit the design lock.
type _GguiEmitInputKeys = Expect<
  Equal<keyof GguiEmitInput, 'renderId' | 'channel' | 'payload' | 'complete'>
>;

// ── Per-field type locks — required fields are non-optional ────────
//
// `renderId` / `channel` / `payload` must be required. Losing
// required-ness silently would let agents omit them and hit runtime
// rejection instead of typecheck failure.
type _RenderIdRequired = Expect<
  Equal<
    undefined extends GguiEmitInput['renderId'] ? true : false,
    false
  >
>;
type _ChannelRequired = Expect<
  Equal<undefined extends GguiEmitInput['channel'] ? true : false, false>
>;
type _PayloadRequired = Expect<
  Equal<undefined extends GguiEmitInput['payload'] ? true : false, false>
>;

// ── Per-field type locks — optional fields stay optional ───────────
type _CompleteOptional = Expect<
  Equal<undefined extends GguiEmitInput['complete'] ? true : false, true>
>;

// ── Retired fields MUST NOT reappear ───────────────────────────────
//
// The `data` field was the pre-rewrite input shape. The agent-supplied
// `mode` / `seq` / `timestamp` / `connectionId` fields never existed
// on the tool surface — they're explicitly derived/assigned server-
// side. Post-Phase-B the `sessionId` / `stackItemId` identity pair
// collapsed to `renderId` — neither retired field may reappear.
// If someone tries to add any of them, these assertions flip.
type _NoDataField = Expect<Equal<'data' extends keyof GguiEmitInput ? true : false, false>>;
type _NoModeField = Expect<Equal<'mode' extends keyof GguiEmitInput ? true : false, false>>;
type _NoSeqField = Expect<Equal<'seq' extends keyof GguiEmitInput ? true : false, false>>;
type _NoTimestampField = Expect<
  Equal<'timestamp' extends keyof GguiEmitInput ? true : false, false>
>;
type _NoConnectionIdField = Expect<
  Equal<'connectionId' extends keyof GguiEmitInput ? true : false, false>
>;
type _NoSessionIdField = Expect<
  Equal<'sessionId' extends keyof GguiEmitInput ? true : false, false>
>;
type _NoStackItemIdField = Expect<
  Equal<'stackItemId' extends keyof GguiEmitInput ? true : false, false>
>;

// ── GguiEmitOutput — keys + shape lock ───────────────────────────
//
// `accepted` (required) + `seq` (optional). No `delivered` (retired).
type _GguiEmitOutputKeys = Expect<Equal<keyof GguiEmitOutput, 'accepted' | 'seq'>>;

type _AcceptedRequired = Expect<
  Equal<undefined extends GguiEmitOutput['accepted'] ? true : false, false>
>;
type _SeqOptional = Expect<
  Equal<undefined extends GguiEmitOutput['seq'] ? true : false, true>
>;

// The `delivered` field was the pre-rewrite output shape — lock it out.
type _NoDeliveredField = Expect<
  Equal<'delivered' extends keyof GguiEmitOutput ? true : false, false>
>;

// ── Generic payload parameterization ───────────────────────────────
//
// `GguiEmitInput<T>` must thread the payload type through. If the
// default generic drifted (e.g. back to JsonObject), autocompletion
// in typed SDK overloads would regress.
type _PayloadGenericFlows = Expect<
  Equal<GguiEmitInput<{ text: string }>['payload'], { text: string }>
>;

// Default generic — payloads accept any JSON-safe value, not just
// objects. This lock prevents a silent regression to JsonObject (which
// would reject channel payloads like "string" or number).
type _DefaultPayloadAcceptsJsonValue = Expect<
  Equal<JsonValue extends GguiEmitInput['payload'] ? true : false, true>
>;

export {};
