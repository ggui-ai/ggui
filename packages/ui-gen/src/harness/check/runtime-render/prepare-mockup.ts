// packages/ui-gen/src/harness/check/runtime-render/prepare-mockup.ts
//
// Schema-first mockup props for runtime render evaluation.
//
// Priority:
//   1. Existing fixture props (commit/contract `props` field) — highest fidelity
//   2. PropEntry.example
//   3. PropEntry.default
//   4. Deterministic schema synthesis from JSON Schema
//        (default → example → enum[0] → typed placeholder)
//   5. LLM fallback (deferred — v2)
//   6. Empty fallback ({}) if all else fails
//
// Output is validated against the contract's `properties` shape — if a field
// is required and ends up missing, we surface that as a synthesis warning
// (the render check will likely fail downstream, but with a clearer signal).

import type {
  DataContract,
  JsonObject,
  JsonSchema,
  JsonValue,
  PropEntry,
  PropsSpec,
} from "@ggui-ai/protocol";

export interface MockupPropsResult {
  /** The synthesized props object — pass directly into render(<Component {...props} />). */
  readonly props: JsonObject;
  /** How each field was sourced — useful for debugging eval failures. */
  readonly source: Readonly<Record<string, MockupSource>>;
  /** Synthesis warnings (missing required fields, unsupported schemas, etc.). */
  readonly warnings: readonly string[];
}

export type MockupSource =
  | "fixture"
  | "entry-example"
  | "entry-default"
  | "schema-default"
  | "schema-example"
  | "schema-enum"
  | "schema-synth"
  | "empty";

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface PrepareMockupInput {
  readonly contract: DataContract | undefined;
  /**
   * Pre-supplied fixture props (e.g., from a benchmark commit's `props` field).
   * Wins over schema synthesis when keys match.
   */
  readonly fixtureProps?: JsonObject;
}

/**
 * Synthesize a JsonObject of props matching the contract.propsSpec shape.
 *
 * Deterministic — no LLM call. Returns even if the contract is missing
 * (in which case `props` is just the fixtureProps or `{}`).
 */
export function prepareMockupProps(input: PrepareMockupInput): MockupPropsResult {
  const { contract, fixtureProps } = input;
  const propsSpec = contract?.propsSpec as PropsSpec | undefined;

  const props: JsonObject = {};
  const source: Record<string, MockupSource> = {};
  const warnings: string[] = [];

  if (!propsSpec || !propsSpec.properties) {
    // No props contract — mirror the fixture if present, else empty.
    if (fixtureProps) {
      Object.assign(props, fixtureProps);
      for (const k of Object.keys(fixtureProps)) source[k] = "fixture";
    }
    return { props, source, warnings };
  }

  for (const [key, entry] of Object.entries(propsSpec.properties)) {
    // Priority 1: fixture wins
    if (fixtureProps && Object.prototype.hasOwnProperty.call(fixtureProps, key)) {
      props[key] = fixtureProps[key];
      source[key] = "fixture";
      continue;
    }

    const synth = synthesizePropValue(entry, key, warnings);
    if (synth.kind === "ok") {
      props[key] = synth.value;
      source[key] = synth.source;
    } else if (entry.required) {
      warnings.push(`Required prop '${key}' could not be synthesized (${synth.reason})`);
    }
    // Optional props that fail synthesis are simply omitted.
  }

  return { props, source, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-prop synthesis
// ─────────────────────────────────────────────────────────────────────────────

type SynthOk = { kind: "ok"; value: JsonValue; source: MockupSource };
type SynthFail = { kind: "fail"; reason: string };

function synthesizePropValue(
  entry: PropEntry,
  fieldName: string,
  warnings: string[],
): SynthOk | SynthFail {
  // PropEntry-level wins over schema-level
  if (entry.example !== undefined) {
    return { kind: "ok", value: entry.example, source: "entry-example" };
  }
  if (entry.default !== undefined) {
    return { kind: "ok", value: entry.default, source: "entry-default" };
  }
  return synthesizeFromSchema(entry.schema, fieldName, warnings, 0);
}

const MAX_DEPTH = 6;

function synthesizeFromSchema(
  schema: JsonSchema | undefined,
  hint: string,
  warnings: string[],
  depth: number,
): SynthOk | SynthFail {
  if (!schema) return { kind: "fail", reason: "no schema" };
  if (depth > MAX_DEPTH) return { kind: "fail", reason: "schema too deep" };

  // Schema-level overrides
  if (schema.default !== undefined) {
    return { kind: "ok", value: schema.default, source: "schema-default" };
  }
  if (schema.example !== undefined) {
    return { kind: "ok", value: schema.example, source: "schema-example" };
  }
  if (schema.enum && schema.enum.length > 0) {
    return { kind: "ok", value: schema.enum[0]!, source: "schema-enum" };
  }

  // Union schemas — try first branch only
  if (schema.oneOf && schema.oneOf.length > 0) {
    return synthesizeFromSchema(schema.oneOf[0], hint, warnings, depth + 1);
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return synthesizeFromSchema(schema.anyOf[0], hint, warnings, depth + 1);
  }

  switch (schema.type) {
    case "string": {
      // Format-aware placeholder
      switch (schema.format) {
        case "date":
        case "date-time":
          return { kind: "ok", value: "2026-04-13T12:00:00Z", source: "schema-synth" };
        case "email":
          return { kind: "ok", value: "user@example.com", source: "schema-synth" };
        case "uri":
        case "url":
          return { kind: "ok", value: "https://example.com", source: "schema-synth" };
        case "uuid":
          return { kind: "ok", value: "00000000-0000-0000-0000-000000000000", source: "schema-synth" };
        default: {
          // Use field name as a hint so it appears in DOM and prop-coverage check sees it.
          // Capitalize first letter for natural-looking placeholder.
          const cap = hint.charAt(0).toUpperCase() + hint.slice(1);
          return { kind: "ok", value: `Sample ${cap}`, source: "schema-synth" };
        }
      }
    }

    case "integer":
    case "number": {
      const min = typeof schema.minimum === "number" ? schema.minimum : 1;
      const max = typeof schema.maximum === "number" ? schema.maximum : 100;
      const value = Math.min(max, Math.max(min, 42));
      return { kind: "ok", value, source: "schema-synth" };
    }

    case "boolean":
      return { kind: "ok", value: true, source: "schema-synth" };

    case "null":
      return { kind: "ok", value: null, source: "schema-synth" };

    case "array": {
      if (!schema.items) {
        return { kind: "ok", value: [], source: "schema-synth" };
      }
      // Synthesize 2 items so list-rendering checks (length > 0) pass.
      const items: JsonValue[] = [];
      for (let i = 0; i < 2; i++) {
        const itemHint = `${hint}Item${i + 1}`;
        const itemSynth = synthesizeFromSchema(schema.items, itemHint, warnings, depth + 1);
        if (itemSynth.kind === "ok") {
          // Inject an `id` for list-key purposes if the item is an object lacking one.
          if (
            itemSynth.value !== null &&
            typeof itemSynth.value === "object" &&
            !Array.isArray(itemSynth.value) &&
            !("id" in itemSynth.value)
          ) {
            (itemSynth.value as JsonObject).id = `${hint}-${i + 1}`;
          }
          items.push(itemSynth.value);
        }
      }
      return { kind: "ok", value: items, source: "schema-synth" };
    }

    case "object": {
      const obj: JsonObject = {};
      const propsMap = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      for (const [k, sub] of Object.entries(propsMap)) {
        const subSynth = synthesizeFromSchema(sub, k, warnings, depth + 1);
        if (subSynth.kind === "ok") {
          obj[k] = subSynth.value;
        } else if (required.has(k)) {
          warnings.push(
            `Required object field '${hint}.${k}' could not be synthesized (${subSynth.reason})`,
          );
        }
      }
      return { kind: "ok", value: obj, source: "schema-synth" };
    }

    default:
      return { kind: "fail", reason: `unsupported schema type: ${schema.type ?? "unknown"}` };
  }
}
