// Compile-time type tests for the handler contract (#817).
// This file must compile with zero errors — that IS the test.
// Run: pnpm typecheck (from this package — tsc compiles this file with the rest)
//
// Two obligations, both stated by the TYPE so a disagreement is a compile
// error where there used to be silence (runtime `validateOutputPayload` on
// the wire was the only failure mode):
//   1. `defineHandler` binds the handler's output to what its `outputSchema`
//      produces (inferred from the handler's return, checked against the
//      shape) — so nobody hand-writes one; with an `outputEnvelopeSchema` the
//      envelope must produce that same shape with exactly its keys.
//   2. `SharedHandler` itself constrains `OutputData` to what its own
//      `outputSchema` (or envelope) produces, so a raw literal that bypasses
//      the helper still cannot omit a key.
// No `@ts-expect-error` here — a negative case is asserted with vitest's
// `expectTypeOf(...).not.toMatchTypeOf`, which fails to COMPILE when the
// relationship holds the wrong way (precedent: protocol's
// contract-inference.test-d.ts).
import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  defineHandler,
  type EnvelopeFor,
  type HandlerDefinition,
  type HandlerFailure,
  type SharedHandler,
  type SharedHandlerOutputData,
  type ShapeOutput,
} from '../types';
import type { ZodRawShape } from 'zod';

const inputSchema = { id: z.string() };
const outputSchema = { id: z.string(), count: z.number(), note: z.string().optional() };

// ── 1. defineHandler derives OutputData from outputSchema ──────────────────
const derived = defineHandler({
  name: 'x_derived',
  description: 'd',
  inputSchema,
  outputSchema,
  async handler() {
    return { id: 'a', count: 1 };
  },
});
// OutputData is INFERRED from what the handler returns and checked against the
// shape's bound: this infallible handler is exactly its shape — no failure arm
// it never produces, no narrowing for consumers.
expectTypeOf(derived).toMatchTypeOf<
  SharedHandler<typeof inputSchema, typeof outputSchema, { id: string; count: number }>
>();
// And every handler still assigns to the bound the list boundary uses.
expectTypeOf(derived).toMatchTypeOf<
  SharedHandler<typeof inputSchema, typeof outputSchema, SharedHandlerOutputData<typeof outputSchema>>
>();
// The derived output type is the schema's output — `note` optional, nothing extra required.
type DerivedOutput = Awaited<ReturnType<typeof derived.handler>>;
expectTypeOf<{ id: string; count: number }>().toMatchTypeOf<DerivedOutput>();
expectTypeOf<{ id: string }>().not.toMatchTypeOf<DerivedOutput>();

// ── 1b. with an envelope: the envelope must produce the shape's output ────────
const envelope = z.object({ id: z.string(), count: z.number(), note: z.string().optional() });
const enveloped = defineHandler({
  name: 'x_enveloped',
  description: 'd',
  inputSchema,
  outputSchema,
  outputEnvelopeSchema: envelope,
  async handler() {
    return { id: 'a', count: 1 };
  },
});
// The enveloped definition is a SharedHandler like any other — same bound at the list boundary.
expectTypeOf(enveloped).toMatchTypeOf<
  SharedHandler<typeof inputSchema, typeof outputSchema, SharedHandlerOutputData<typeof outputSchema>>
>();
type EnvelopedOutput = Awaited<ReturnType<typeof enveloped.handler>>;
// Inferred, not stamped: this handler never fails, so its output is exactly the
// envelope's shape — no failure arm it never produces.
expectTypeOf<EnvelopedOutput>().toEqualTypeOf<{ id: string; count: number }>();
expectTypeOf<EnvelopedOutput>().toMatchTypeOf<z.output<typeof envelope>>();

// ── 2. the bound refuses a hand-written OutputData that omits a schema key ──
// First through the DEFINITION type `defineHandler` accepts (a definition whose
// handler returns a missing-key type is not a HandlerDefinition) …
type MissingKeyDefinition = {
  name: string;
  description: string;
  inputSchema: typeof inputSchema;
  outputSchema: typeof outputSchema;
  handler: () => Promise<{ id: string }>;
};
expectTypeOf<MissingKeyDefinition>().not.toMatchTypeOf<HandlerDefinition<typeof inputSchema, typeof outputSchema>>();
type CompleteDefinition = Omit<MissingKeyDefinition, 'handler'> & { handler: () => Promise<{ id: string; count: number }> };
expectTypeOf<CompleteDefinition>().toMatchTypeOf<HandlerDefinition<typeof inputSchema, typeof outputSchema>>();
// … then the predicate itself, which is the interface's bound by construction.
// `Accepts<D>` is exactly the bound the interface places on its third generic.
type Accepts<D> = D extends SharedHandlerOutputData<typeof outputSchema> ? true : false;
// A type that omits a required schema key is NOT a valid OutputData …
type MissingKey = { id: string };
expectTypeOf<Accepts<MissingKey>>().toEqualTypeOf<false>();
expectTypeOf<MissingKey>().not.toMatchTypeOf<ShapeOutput<typeof outputSchema>>();
// … one that carries every key IS (extra keys are the runtime validator's business) …
type Complete = { id: string; count: number; note?: string | undefined; extra: boolean };
expectTypeOf<Accepts<Complete>>().toEqualTypeOf<true>();
// … and so is a failure envelope carrying the shape.
expectTypeOf<Accepts<HandlerFailure<ShapeOutput<typeof outputSchema>>>>().toEqualTypeOf<true>();

// ── 3. envelope keys must equal outputSchema keys (keyof identity) ─────────
// A mismatched envelope (a key the raw shape does not declare) is rejected by
// the helper's parameter type — asserted as non-assignability of the
// definition object, never by @ts-expect-error.
const mismatchedEnvelope = z.object({ id: z.string(), count: z.number(), rogue: z.boolean() });
// It DOES produce the shape's output (extra key is fine for assignability) — the
// rejection below is the keys rule, not the output rule.
expectTypeOf(mismatchedEnvelope).toMatchTypeOf<z.ZodType<ShapeOutput<typeof outputSchema>>>();
type DefinitionFor<E extends z.ZodType<ShapeOutput<typeof outputSchema>>> = Parameters<
  typeof defineHandler<typeof inputSchema, typeof outputSchema, E, ShapeOutput<typeof outputSchema>>
>[0];
type DefinitionWith<E extends z.ZodType<ShapeOutput<typeof outputSchema>>> = {
  name: string;
  description: string;
  inputSchema: typeof inputSchema;
  outputSchema: typeof outputSchema;
  outputEnvelopeSchema: E;
  handler: () => Promise<z.output<E>>;
};
// Same keys → admissible …
expectTypeOf<DefinitionWith<typeof envelope>>().toMatchTypeOf<DefinitionFor<typeof envelope>>();
// … a rogue key → the property type is unsatisfiable, the definition does not type.
expectTypeOf<DefinitionWith<typeof mismatchedEnvelope>>().not.toMatchTypeOf<DefinitionFor<typeof mismatchedEnvelope>>();

// Both mismatch directions, pinned on the operator itself. The EXTRA-key case
// above is the one a strip-parsing transport hides at runtime (the key is
// dropped, nothing fails) — the type is its only receipt. The MISSING-key case
// is caught twice: the envelope no longer produces the shape's output (rule 1),
// and its keys differ (rule 3). Exact keys are the identity.
const missingKeyEnvelope = z.object({ id: z.string() });
expectTypeOf(missingKeyEnvelope).not.toMatchTypeOf<z.ZodType<ShapeOutput<typeof outputSchema>>>();
expectTypeOf<EnvelopeFor<typeof outputSchema, typeof envelope>>().toEqualTypeOf<typeof envelope>();
expectTypeOf<EnvelopeFor<typeof outputSchema, typeof mismatchedEnvelope>>().toBeNever();
expectTypeOf<EnvelopeFor<typeof outputSchema, typeof missingKeyEnvelope>>().toBeNever();

// ── 4. the heterogeneous list boundary makes no shape claim ─────────────────
// A handler whose OutputData is an INTERFACE (no implicit index signature)
// assigns at the wide boundary — the boundary's bound is `object`, so nothing
// there needs a cast; the concrete bound (probe 2) still bites at construction.
interface InterfaceShaped {
  id: string;
  count: number;
}
const interfaceTyped = defineHandler({
  name: 'x_interface',
  description: 'd',
  inputSchema,
  outputSchema,
  async handler(): Promise<InterfaceShaped> {
    return { id: 'a', count: 1 };
  },
});
expectTypeOf(interfaceTyped).toMatchTypeOf<SharedHandler<ZodRawShape, ZodRawShape>>();
expectTypeOf(enveloped).toMatchTypeOf<SharedHandler<ZodRawShape, ZodRawShape>>();
