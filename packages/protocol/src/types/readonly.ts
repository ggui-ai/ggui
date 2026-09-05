/**
 * Readonly applied at the SEAM, never in a wire schema: zod 4 projects
 * `.readonly()` as `readOnly` into the advertised JSON Schema, and the wire
 * is mutable JSON. Types derived from a wire schema wear this instead, so a
 * consumer holding a projection cannot mutate it while the schema still
 * says exactly what travels.
 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
