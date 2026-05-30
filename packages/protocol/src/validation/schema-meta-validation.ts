/**
 * Layer B (inner JSON Schema meta-validation) for a `DataContract`.
 *
 * Walks the six inner JSON Schema fields the agent authors:
 *   1. `propsSpec.properties[*].schema`
 *   2. `actionSpec[*].schema` (optional per entry)
 *   3. `streamSpec[*].schema`
 *   4. `contextSpec[*].schema`
 *   5. `agentCapabilities.tools[*].inputSchema` (optional per entry)
 *   6. `agentCapabilities.tools[*].outputSchema` (optional per entry)
 *
 * For each present schema, runs `compileForValidation()` from
 * `ajv-runtime`. Ajv's `strict: true` mode throws on malformed JSON
 * Schemas at compile-time — unknown keywords, missing `items` on
 * array nodes, properties values that are not schemas, etc. This is
 * the meta-validation pass: it asserts the contract's own type
 * descriptions are well-formed BEFORE any runtime data flows.
 *
 * Failures collect into a single throw with every malformed field
 * named — agents fix all of them in one round rather than retry-
 * per-field.
 *
 * Designed to slot at:
 *   - `ggui_handshake` entry — validates `blueprintDraft.contract`
 *     before the negotiator runs.
 *   - `ggui_render` entry — validates the `effectiveContract` (either
 *     synth-amended or override) before any state mutation.
 *
 * Both call sites already run cross-reference and name-invariant
 * assertions for the same author-recoverable failure class; this
 * sits alongside them.
 */

import type { DataContract } from '../types/data-contract';
import { compileForValidation } from './ajv-runtime';

export interface SchemaMetaViolation {
  /** Path to the malformed schema field (e.g., `propsSpec.properties.todos.schema`). */
  field: string;
  /** Ajv's compile-error message (truncated to fit the wire). */
  message: string;
}

/**
 * Typed error for contract schema meta-validation failures. Mirrors
 * the shape of `CrossReferenceError` / `ContractViolationError` for
 * symmetry — push/handshake catch and surface a structured
 * `contract_schema_invalid` error to the agent.
 */
export class ContractSchemaMetaError extends Error {
  readonly code = 'contract_schema_invalid' as const;
  readonly violations: readonly SchemaMetaViolation[];
  readonly hint: string;

  constructor(violations: readonly SchemaMetaViolation[]) {
    const summary = violations.map(v => `  - ${v.field}: ${v.message}`).join('\n');
    super(`Contract has malformed JSON Schemas:\n${summary}`);
    this.name = 'ContractSchemaMetaError';
    this.violations = violations;
    this.hint =
      'Fix the JSON Schema at the named field. Common causes: ' +
      'missing `items` on an array schema, a properties entry that ' +
      'is not itself a JSON Schema object, or an unknown keyword. ' +
      'Re-call ggui_render (or ggui_handshake) once corrected.';
  }
}

function tryCompile(
  field: string,
  schema: Parameters<typeof compileForValidation>[0] | undefined,
  violations: SchemaMetaViolation[],
): void {
  // Undefined schema is a structural error, not an Ajv-compile error.
  // Author confusion shape: agent puts a JSON Schema flat at the
  // PropEntry / ActionEntry / StreamChannelEntry / ContextEntry level
  // instead of wrapping it in `schema:`. Surface the missing field
  // explicitly so the agent's recovery loop names the correction
  // (`add a "schema" field`) instead of the opaque
  // "Cannot read properties of undefined (reading 'type')" crash that
  // Ajv would otherwise throw from `injectClosedShape`.
  if (schema === undefined || schema === null) {
    violations.push({
      field,
      message:
        `Missing 'schema' field. Each entry in propsSpec.properties / actionSpec / streamSpec / contextSpec is a WRAPPER that contains a JSON Schema in its 'schema:' field — the JSON Schema does NOT sit flat at the entry level. Example: propsSpec.properties.todos = { schema: { type: 'array', items: { ... } }, required: true }.`,
    });
    return;
  }
  try {
    compileForValidation(schema);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    violations.push({ field, message: truncate(raw, 240) });
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Walks the contract's six inner JSON Schema fields and collects a
 * {@link SchemaMetaViolation} for each that does not compile cleanly
 * under Ajv's strict mode (unknown keyword, missing `items`, a
 * non-schema `properties` value, or a missing `schema:` wrapper). Pure
 * check — returns the full list so callers can either repair (the
 * handshake repair loop) or throw (see {@link assertContractSchemasValid}).
 *
 * This is the inner-schema validity check folded into the unified
 * `validateContract` gate (lint-contract.ts `phaseSchemaMeta`) — the
 * one check the strict linter was previously missing relative to the
 * push/handshake assert set.
 */
export function checkContractSchemasValid(
  contract: DataContract,
): SchemaMetaViolation[] {
  const violations: SchemaMetaViolation[] = [];

  if (contract.propsSpec?.properties) {
    for (const [name, entry] of Object.entries(contract.propsSpec.properties)) {
      tryCompile(`propsSpec.properties.${name}.schema`, entry.schema, violations);
    }
  }

  if (contract.actionSpec) {
    for (const [name, entry] of Object.entries(contract.actionSpec)) {
      if (entry.schema) {
        tryCompile(`actionSpec.${name}.schema`, entry.schema, violations);
      }
    }
  }

  if (contract.streamSpec) {
    for (const [name, entry] of Object.entries(contract.streamSpec)) {
      if (entry.schema) {
        tryCompile(`streamSpec.${name}.schema`, entry.schema, violations);
      }
    }
  }

  if (contract.contextSpec) {
    for (const [name, entry] of Object.entries(contract.contextSpec)) {
      if (entry.schema) {
        tryCompile(`contextSpec.${name}.schema`, entry.schema, violations);
      }
    }
  }

  if (contract.agentCapabilities?.tools) {
    for (const [name, entry] of Object.entries(contract.agentCapabilities.tools)) {
      if (entry.inputSchema) {
        tryCompile(
          `agentCapabilities.tools.${name}.inputSchema`,
          entry.inputSchema,
          violations,
        );
      }
      if (entry.outputSchema) {
        tryCompile(
          `agentCapabilities.tools.${name}.outputSchema`,
          entry.outputSchema,
          violations,
        );
      }
    }
  }

  return violations;
}

/**
 * Throwable wrapper around {@link checkContractSchemasValid}. Throws
 * {@link ContractSchemaMetaError} (collecting every malformed schema in
 * one pass) when any inner JSON Schema fails Ajv strict-mode
 * compilation. No-op when all schemas are well-formed.
 */
export function assertContractSchemasValid(contract: DataContract): void {
  const violations = checkContractSchemasValid(contract);
  if (violations.length > 0) {
    throw new ContractSchemaMetaError(violations);
  }
}
