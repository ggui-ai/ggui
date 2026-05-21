/**
 * Compile-time guard for the Traits invariant — see `../interact/trait`.
 *
 * Interaction composition is *structural-only*:
 *   - Box / Stack / Row / Card host a trait via `as={Trait}` — their
 *     public type is `WithTrait<…>`, so `as` (and the chosen trait's
 *     props) are reachable.
 *   - Semantic components (Button / Link / Input) and the Text content
 *     primitive expose NO `as` — interaction is inherent (Button has
 *     `onClick`, Link has `href`, Input has `onChange`) or absent
 *     (Text). `as` left `BaseProps` entirely, so this holds by
 *     construction.
 *
 * These are TYPE-LEVEL assertions with no runtime behaviour. The
 * `typecheck` script (`tsc`, also the pre-push hook) fails if the
 * invariant regresses — e.g. if `as` is re-added to `BaseProps`, or if
 * `WithTrait` stops surfacing a trait's props. The assertion aliases
 * are `export`ed so `noUnusedLocals` does not flag them; the file is
 * not re-exported from the package index, so it stays internal.
 *
 * `tsconfig` excludes `*.test.ts` from `tsc`, which is why this lock
 * lives in a regular source file rather than a test.
 */
import { Clickable } from '../interact/Clickable';
import type { TraitProps, WithTrait } from '../interact/trait';
import type {
  BoxProps,
  ButtonProps,
  CardProps,
  InputProps,
  LinkProps,
  StackProps,
  TextProps,
} from './types';

/** `true` iff `K` is a key of `T` (distributes nothing — `T` is treated whole). */
type HasKey<T, K extends PropertyKey> = [K] extends [keyof T] ? true : false;
/** Compiles only when `T` resolves to exactly `true`. */
type AssertTrue<T extends true> = T;
/** Compiles only when `T` resolves to exactly `false`. */
type AssertFalse<T extends false> = T;

// ── `as` key presence ──────────────────────────────────────────────
// Structural primitives host a trait → `as` is reachable.
export type _CardHostsTrait = AssertTrue<HasKey<WithTrait<CardProps>, 'as'>>;
export type _BoxHostsTrait = AssertTrue<HasKey<WithTrait<BoxProps>, 'as'>>;
export type _StackHostsTrait = AssertTrue<HasKey<WithTrait<StackProps>, 'as'>>;

// Semantic components + the Text content primitive → no `as` key.
export type _ButtonRejectsAs = AssertFalse<HasKey<ButtonProps, 'as'>>;
export type _LinkRejectsAs = AssertFalse<HasKey<LinkProps, 'as'>>;
export type _InputRejectsAs = AssertFalse<HasKey<InputProps, 'as'>>;
export type _TextRejectsAs = AssertFalse<HasKey<TextProps, 'as'>>;

// ── trait-prop inference ───────────────────────────────────────────
// `TraitProps<typeof Clickable>` is exactly what `as={Clickable}`
// contributes to its host — `onClick` being among those props proves
// the trait's interaction surface flows onto the primitive.
export type _ClickableTraitSurfacesOnClick = AssertTrue<
  HasKey<TraitProps<typeof Clickable>, 'onClick'>
>;
// A bare structural primitive (no `as`) declares none of the trait
// props — a raw `onClick` on `<Card>` is a type error, by design.
export type _BareCardHasNoOnClick = AssertFalse<HasKey<CardProps, 'onClick'>>;
