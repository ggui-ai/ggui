// packages/ui-gen/src/check/contract-validation.ts
//
// Shared validation utilities for data-contract conformance —
// deterministic tier-0 gate for `PropsSpec` / `StreamSpec` / `ActionSpec`
// agreement between the LLM-emitted componentCode and the contract the
// agent handed to `ggui_push`.
//
// Used by:
//   (1) Self-check soft gate in the coding agent
//       (`coding-agent/self-check.ts`) — surfaces mismatches as
//       structured violations for the LLM retry loop.
//   (2) Tier-0 hard gate in the evaluation pipeline — errors (severity
//       `error`) are blocking; warnings surface as advisory.
//   (3) Adapter tool-family wiring for multi-SDK generation runs.
//   (4) Benchmarks + LLM prompt construction — `jsonSchemaTypeToTs` +
//       `propsSpecToTypeScript` + `inferPropsSpecFromSampleData` are
//       pure helpers reused outside the check path. Re-exported here so
//       those callers don't need a separate import for the subpath.
//
// Deps are pure: `@ggui-ai/protocol` (public types) + `typescript`
// (compiler API) + the in-package `jsonSchemaTypeToTs` primitive from
// `../boilerplate/json-schema-ts.js`.

import type {
  PropsSpec,
  StreamSpec,
  ActionSpec,
  DataContract,
  JsonSchema,
  JsonValue,
  PropEntry,
  JsonObject,
} from "@ggui-ai/protocol";
import ts from "typescript";

// Re-export the pure JSON-Schema → TypeScript-type converter from the
// in-package `boilerplate/` primitive, so consumers of the tier-0 check
// surface (self-check, tiers, benchmarks, prompts, adapters) import a
// single symbol from a single subpath.
export { jsonSchemaTypeToTs } from "../boilerplate/json-schema-ts.js";
import { jsonSchemaTypeToTs } from "../boilerplate/json-schema-ts.js";

// =============================================================================
// Contract Issue
// =============================================================================

export interface ContractIssue {
  severity: "error" | "warning";
  field: string;
  message: string;
  fix: string;
}

// =============================================================================
// Props Interface Extraction (AST-based)
// =============================================================================

interface ExtractedProp {
  name: string;
  type: string;
  optional: boolean;
}

/**
 * Extract field names and types from a TypeScript Props interface in source code.
 * Uses the TypeScript compiler API — handles nested types, generics, unions correctly.
 */
export function extractPropsInterface(code: string): ExtractedProp[] | null {
  const sf = ts.createSourceFile("component.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const props: ExtractedProp[] = [];

  function visitMembers(members: ts.NodeArray<ts.TypeElement>): void {
    for (const member of members) {
      if (ts.isPropertySignature(member) && member.name) {
        const name = member.name.getText(sf);
        const type = member.type ? member.type.getText(sf) : "unknown";
        const optional = !!member.questionToken;
        props.push({ name, type, optional });
      }
    }
  }

  function visit(node: ts.Node): void {
    // interface Props { ... }
    if (ts.isInterfaceDeclaration(node) && node.name.text === "Props") {
      visitMembers(node.members);
      return;
    }
    // type Props = { ... }
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "Props") {
      if (ts.isTypeLiteralNode(node.type)) {
        visitMembers(node.type.members);
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return props.length > 0 ? props : null;
}

// =============================================================================
// Contract Validation
// =============================================================================

/**
 * Compare extracted Props interface against a PropsSpec contract.
 * Returns issues: errors for missing required fields, warnings for type mismatches.
 */
export function validatePropsAgainstSchema(
  code: string,
  spec: PropsSpec,
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const extracted = extractPropsInterface(code);

  if (!extracted) {
    // Can't extract — not necessarily an error (might use inline types)
    return [];
  }

  const extractedMap = new Map(extracted.map((p) => [p.name, p]));

  for (const [propName, entry] of Object.entries(spec.properties)) {
    const extractedProp = extractedMap.get(propName);

    if (!extractedProp) {
      if (entry.required) {
        issues.push({
          severity: "error",
          field: propName,
          message: `Props interface is missing required field '${propName}' from the data contract`,
          fix: `Add \`${propName}${entry.required ? "" : "?"}: ${jsonSchemaTypeToTs(entry.schema)}\` to your Props interface`,
        });
      } else {
        issues.push({
          severity: "warning",
          field: propName,
          message: `Props interface is missing optional field '${propName}' from the data contract`,
          fix: `Consider adding \`${propName}?: ${jsonSchemaTypeToTs(entry.schema)}\` to your Props interface`,
        });
      }
      continue;
    }

    // Basic type compatibility check (only if we have type info)
    if (extractedProp.type !== "unknown") {
      const expectedTsType = jsonSchemaTypeToTs(entry.schema);
      if (!isTypeCompatible(extractedProp.type, expectedTsType, entry.schema)) {
        issues.push({
          severity: "warning",
          field: propName,
          message: `Field '${propName}' has type '${extractedProp.type}' but contract expects '${expectedTsType}'`,
          fix: `Change \`${propName}\` type to \`${expectedTsType}\``,
        });
      }
    }
  }

  return issues;
}

/**
 * Check if a TypeScript type string is compatible with a JSON Schema type.
 * Loose comparison — we only check the base type, not full structural equality.
 */
function isTypeCompatible(tsType: string, expectedTsType: string, schema: JsonSchema): boolean {
  const normalized = tsType.replace(/\s/g, "").toLowerCase();

  switch (schema.type) {
    case "string":
      return normalized.includes("string");
    case "number":
    case "integer":
      return normalized.includes("number");
    case "boolean":
      return normalized.includes("boolean");
    case "array":
      return normalized.includes("[]") || normalized.includes("array");
    case "object":
      return !["string", "number", "boolean"].some((t) => normalized === t);
    default:
      return true;
  }
}

// =============================================================================
// JSON Schema → TypeScript Conversion (for LLM prompts)
// =============================================================================

// `jsonSchemaTypeToTs` lives in `@ggui-ai/ui-gen/boilerplate` and is
// re-exported at the top of this file.

/**
 * Convert a full PropsSpec to a TypeScript interface string for LLM prompt injection.
 * Includes required/optional markers and descriptions as comments.
 */
export function propsSpecToTypeScript(spec: PropsSpec, indent = 2): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];

  for (const [propName, entry] of Object.entries(spec.properties)) {
    if (entry.description) {
      lines.push(`${pad}/** ${entry.description} */`);
    }
    const optional = !entry.required;
    const tsType = jsonSchemaTypeToTs(entry.schema);
    const defaultStr = entry.default !== undefined ? ` // default: ${JSON.stringify(entry.default)}` : "";
    lines.push(`${pad}${propName}${optional ? "?" : ""}: ${tsType};${defaultStr}`);
    // Include example as a comment so the LLM sees the exact data shape
    if (entry.example !== undefined) {
      const exampleStr = JSON.stringify(entry.example, null, 2)
        .split("\n")
        .map((l, i) => (i === 0 ? `${pad}// Example: ${l}` : `${pad}// ${l}`))
        .join("\n");
      lines.push(exampleStr);
    }
  }

  return `{\n${lines.join("\n")}\n}`;
}

// =============================================================================
// StreamSpec Validation
// =============================================================================

/**
 * Validate that the generated source code properly handles stream events.
 * Requires useStream() wire hooks — legacy DOM event patterns are no longer accepted.
 */
export function validateStreamSpecConformance(
  code: string,
  spec: StreamSpec,
): ContractIssue[] {
  const issues: ContractIssue[] = [];

  const usesWireStream = code.includes("useStream");

  if (!usesWireStream) {
    issues.push({
      severity: "error",
      field: "__streamSpec__",
      message: "Component does not handle stream events — use useStream() from the boilerplate wire hooks",
      fix: "Use the useStream('eventName') hook from the boilerplate to receive real-time data from the agent",
    });
    return issues;
  }

  // Check each declared channel is referenced in the code. `spec` is a
  // flat `Record<channelName, StreamChannelEntry>` — iterate directly.
  for (const [channelName, entry] of Object.entries(spec)) {
    if (!code.includes(`'${channelName}'`) && !code.includes(`"${channelName}"`)) {
      issues.push({
        severity: "warning",
        field: channelName,
        message: `StreamSpec declares channel '${channelName}' but component doesn't reference it`,
        fix: `Add useStream('${channelName}') to receive ${entry.description || channelName} events`,
      });
    }
  }

  return issues;
}

// =============================================================================
// ActionSpec Validation
// =============================================================================

/**
 * Validate that the generated source code wires the declared actions.
 * Checks that action IDs are referenced via useAction() wire hooks, string literals, or prop callbacks.
 */
export function validateActionSpecConformance(
  code: string,
  spec: ActionSpec,
): ContractIssue[] {
  const issues: ContractIssue[] = [];

  // `spec` is a flat `Record<actionId, ActionEntry>` — iterate directly.
  for (const [actionId, entry] of Object.entries(spec)) {
    // Check the action ID or its label is referenced in the code
    const idReferenced = code.includes(`'${actionId}'`) || code.includes(`"${actionId}"`);
    const labelReferenced = code.includes(entry.label);
    const callbackName = `on${actionId.charAt(0).toUpperCase()}${actionId.slice(1)}`;
    const callbackReferenced = code.includes(callbackName);

    if (!idReferenced && !labelReferenced && !callbackReferenced) {
      issues.push({
        severity: "error",
        field: actionId,
        message: `ActionSpec declares action '${actionId}' ("${entry.label}") but component doesn't wire it`,
        fix: `Use the useAction('${actionId}') hook from the boilerplate and wire it to a button or form submit`,
      });
    }
  }

  return issues;
}

// =============================================================================
// Unified Contract Validation
// =============================================================================

/**
 * Validate all contract (props, stream, actions) against the source code.
 * Returns combined issues from all three validations.
 */
export function validateAllContracts(
  code: string,
  contract: DataContract,
): ContractIssue[] {
  const issues: ContractIssue[] = [];

  if (contract.propsSpec) {
    issues.push(...validatePropsAgainstSchema(code, contract.propsSpec));
  }

  if (contract.streamSpec) {
    issues.push(...validateStreamSpecConformance(code, contract.streamSpec));
  }

  if (contract.actionSpec) {
    issues.push(...validateActionSpecConformance(code, contract.actionSpec));
  }

  return issues;
}

// =============================================================================
// Sample Data → PropsSpec Inference (backward compat)
// =============================================================================

/**
 * Infer a PropsSpec from sample data.
 * Convenience utility for migration and for agents that pass sample data instead of schemas.
 * All fields are marked as required (can't distinguish required/optional from data alone).
 */
export function inferPropsSpecFromSampleData(data: JsonObject): PropsSpec {
  const properties: Record<string, PropEntry> = {};

  for (const [key, value] of Object.entries(data)) {
    properties[key] = {
      schema: inferJsonSchema(value),
      required: true,
      example: value as JsonValue,
    };
  }

  return { properties };
}

function inferJsonSchema(value: unknown): JsonSchema {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array" };
    return {
      type: "array",
      items: inferJsonSchema(value[0]),
    };
  }

  if (typeof value === "object") {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(value as JsonObject)) {
      properties[k] = inferJsonSchema(v);
      required.push(k);
    }
    return { type: "object", properties, required };
  }

  return { type: "string" };
}
