/**
 * Ajv-backed JSON Schema validation runtime for ggui contracts.
 *
 * Owns layers B (inner JSON Schema meta-validation) and C (runtime
 * data validation across propsSpec / actionSpec / streamSpec /
 * contextSpec) of the six-layer model. The outer A-layers — protocol
 * wrappers (DataContract envelope, PropsSpec, PropEntry, ActionEntry,
 * etc.) — stay on zod where TS inference + structural strict-mode
 * already do their job.
 *
 * Why Ajv:
 *   - Canonical JSON Schema validator (303M weekly downloads).
 *   - Single source of truth: same compiled validator powers all four
 *     runtime spec surfaces, so closed-shape semantics never diverge
 *     between props vs action vs stream vs context.
 *   - Compile-time meta-validation: `strict: true` rejects malformed
 *     JSON Schemas at `compile()` — agents discover bugs at
 *     handshake/render, not at first data flow.
 *
 * Closed-shape (load-bearing):
 *   JSON Schema's default is `additionalProperties: true` (extras
 *   allowed). Our "propsSpec IS the contract" promise needs
 *   closed-shape at EVERY depth. Rather than tax agents with
 *   `additionalProperties: false` at every object node, we inject it
 *   recursively via {@link injectClosedShape} before Ajv compiles.
 *   An author who explicitly sets `additionalProperties` (boolean or
 *   schema) keeps that intent — escape hatch for the rare case where
 *   open extension is intentional.
 *
 * Tolerated metadata keywords:
 *   - `example` (singular, OpenAPI-ish; JSON Schema standard is
 *     `examples` array). Treated as informational.
 *   - `nullable` (OpenAPI 3.0 shorthand). Tolerated; the canonical
 *     way to express nullability is `type: [<original>, 'null']`.
 *
 * Both are registered as no-op keywords so Ajv strict mode doesn't
 * reject schemas that carry them.
 */

import Ajv from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Re-export of Ajv's compiled-validator function type. Consumers
 * (e.g. the renderer iframe loading precompiled validator modules)
 * import it from `@ggui-ai/protocol` so they need no direct `ajv`
 * dependency — TS resolves the type transitively through this package.
 */
export type { ValidateFunction } from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import equalImport from 'ajv/dist/runtime/equal.js';
import ucs2lengthImport from 'ajv/dist/runtime/ucs2length.js';
import type { JsonSchema } from '../types/data-contract';
import type { ContractViolation } from './contract-validator';
import { isRecord } from './is-record';

/**
 * Resolve a runtime-helper module's exported function across the
 * CJS↔ESM interop gap: a plain `module.exports = fn` CJS module
 * surfaces the function directly, while a `__esModule`-flagged one
 * (Ajv's `dist/runtime/*`) surfaces it under `.default`.
 */
function resolveHelperFn(imported: unknown): (...args: never[]) => unknown {
  if (typeof imported === 'function') {
    return imported as (...args: never[]) => unknown;
  }
  const inner = (imported as { default?: unknown } | null)?.default;
  if (typeof inner === 'function') {
    return inner as (...args: never[]) => unknown;
  }
  throw new Error('ajv-runtime: could not resolve a runtime-helper function');
}

/**
 * Source text of the two Ajv runtime helpers a standalone validator for
 * our closed contract schemas can reach: `equal` (fast-deep-equal —
 * emitted for `uniqueItems` and object-valued `enum`/`const`) and
 * `ucs2length` (emitted for string `minLength`/`maxLength`). Ajv
 * references both by bare specifier; {@link compileValidatorModule}
 * inlines this source so the emitted module is fully self-contained —
 * no bare-specifier imports the CSP-sandboxed renderer iframe would
 * fail to resolve. Captured once at module init; `toString()` on a
 * pure function is deterministic.
 */
const FAST_DEEP_EQUAL_SOURCE = resolveHelperFn(equalImport).toString();
const UCS2LENGTH_SOURCE = resolveHelperFn(ucs2lengthImport).toString();

/**
 * Singleton Ajv instance. Configured once with:
 *   - `strict: true` — rejects unknown keywords + malformed schemas
 *     at compile-time (layer B meta-validation as a side effect).
 *   - `allErrors: true` — collect all violations per validation, not
 *     just the first. The agent sees the full picture in one round.
 *   - `useDefaults: false` — don't mutate input by filling defaults.
 *     Contract validation is read-only.
 *   - `coerceTypes: false` — strict types. `"5"` is not a number.
 *   - `removeAdditional: false` — extras MUST error, not be silently
 *     stripped. The closed-shape promise depends on this.
 */
const AJV_OPTIONS = {
  strict: true,
  allErrors: true,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
  verbose: true,
} as const;

const ajv = new Ajv({ ...AJV_OPTIONS });
addFormats(ajv);

if (!ajv.getKeyword('example')) ajv.addKeyword({ keyword: 'example' });
if (!ajv.getKeyword('nullable')) ajv.addKeyword({ keyword: 'nullable' });

/**
 * Dedicated Ajv instance for {@link compileValidatorModule}. Same
 * options as the singleton plus `code.source`/`code.esm` so Ajv emits
 * the validator as ESM source text instead of a live function.
 *
 * Why a second instance: `code.source` makes every compiled validator
 * carry its generated source — a cost the runtime-validation singleton
 * doesn't need. Keeping standalone emission isolated leaves the hot
 * `compileForValidation` path unchanged.
 */
const standaloneAjv = new Ajv({
  ...AJV_OPTIONS,
  code: { source: true, esm: true },
});
addFormats(standaloneAjv);

if (!standaloneAjv.getKeyword('example')) {
  standaloneAjv.addKeyword({ keyword: 'example' });
}
if (!standaloneAjv.getKeyword('nullable')) {
  standaloneAjv.addKeyword({ keyword: 'nullable' });
}

/**
 * Recursively walk a JSON Schema and inject
 * `additionalProperties: false` at every object node. Authors who
 * explicitly set `additionalProperties` keep that intent (boolean
 * preserved; schema recursed into).
 *
 * Walks:
 *   - `properties` (each entry)
 *   - `items` (array element schema)
 *   - `additionalProperties` (when it's a schema)
 *   - `oneOf` / `anyOf` (each branch)
 *
 * Returns a new schema tree; never mutates the input.
 */
export function injectClosedShape(schema: JsonSchema): JsonSchema {
  const isObjectNode = schema.type === 'object' || schema.properties !== undefined;

  if (isObjectNode) {
    const out: JsonSchema = { ...schema };

    if (out.properties) {
      const newProps: Record<string, JsonSchema> = {};
      for (const [k, v] of Object.entries(out.properties)) {
        newProps[k] = injectClosedShape(v);
      }
      out.properties = newProps;
    }

    if (out.additionalProperties === undefined) {
      out.additionalProperties = false;
    } else if (typeof out.additionalProperties !== 'boolean') {
      out.additionalProperties = injectClosedShape(out.additionalProperties);
    }

    if (out.oneOf) out.oneOf = out.oneOf.map(injectClosedShape);
    if (out.anyOf) out.anyOf = out.anyOf.map(injectClosedShape);
    return out;
  }

  if (schema.type === 'array' && schema.items) {
    return { ...schema, items: injectClosedShape(schema.items) };
  }

  if (schema.oneOf || schema.anyOf) {
    const out: JsonSchema = { ...schema };
    if (out.oneOf) out.oneOf = out.oneOf.map(injectClosedShape);
    if (out.anyOf) out.anyOf = out.anyOf.map(injectClosedShape);
    return out;
  }

  return schema;
}

/**
 * Compile a JSON Schema into an Ajv {@link ValidateFunction}, with
 * closed-shape injected at every object node. Throws if the schema
 * is malformed under Ajv strict mode — this is layer B meta-
 * validation as a free side effect. Dedicated meta-validation call
 * sites (handshake / render) wrap this in a structured error.
 *
 * Not cached. Compilation is fast and contracts are small; caching
 * adds a memory cost without a measured win. Revisit if profiling
 * shows compile dominating.
 */
export function compileForValidation(schema: JsonSchema): ValidateFunction {
  const injected = injectClosedShape(schema);
  return ajv.compile(injected);
}

/**
 * Compile a JSON Schema into a standalone, **fully self-contained ESM
 * validator module** — source text, never a live function. Closed-shape
 * is injected first, exactly as {@link compileForValidation} does, so
 * the emitted validator enforces the same semantics.
 *
 * Why this exists: the renderer iframe runs under a strict CSP with no
 * `'unsafe-eval'`, so `ajv.compile()` (which builds the validator via
 * `new Function`) throws `EvalError` there. Codegen has to happen
 * where `eval` is legal — the server, at render time, where the contract
 * schema is already fixed. The iframe then loads this module source
 * via a `blob:` dynamic import (governed by `script-src`, not
 * `unsafe-eval`) and only ever *runs* the validator.
 *
 * The returned module `export default`s the validator function (and
 * also names it `validate`). Ajv standalone references its runtime
 * helpers by bare specifier (`ajv/dist/runtime/*`) — the
 * CSP-sandboxed iframe has no bundler to resolve those, so this
 * function **inlines** every helper a closed-contract validator can
 * reach (in practice only `equal` / fast-deep-equal, for `uniqueItems`
 * and object-valued `enum`/`const`). The result has zero imports. A
 * survivor check throws if any un-inlined bare import remains, so a new
 * Ajv helper surfaces as a loud server-side failure, never as silent
 * iframe breakage.
 *
 * Throws if the schema is malformed under Ajv strict mode — same
 * layer-B meta-validation side effect as {@link compileForValidation}.
 */
export function compileValidatorModule(schema: JsonSchema): string {
  const injected = injectClosedShape(schema);
  const validate = standaloneAjv.compile(injected);
  return inlineRuntimeHelpers(standaloneCode(standaloneAjv, validate));
}

/**
 * Inlinable Ajv runtime helpers, keyed by bare specifier. Ajv standalone
 * references these by `import`; the CSP-sandboxed iframe has no bundler
 * to resolve a bare specifier, so {@link inlineRuntimeHelpers} replaces
 * each `import` with the helper's source inline.
 */
const RUNTIME_HELPER_SOURCES: Readonly<Record<string, string>> = {
  'ajv/dist/runtime/equal': FAST_DEEP_EQUAL_SOURCE,
  'ajv/dist/runtime/ucs2length': UCS2LENGTH_SOURCE,
};

/**
 * Make an Ajv standalone module fully self-contained: normalize any
 * CJS `require` of a runtime helper to ESM `import`, inline every
 * helper we support, and assert nothing un-inlined survives.
 */
function inlineRuntimeHelpers(source: string): string {
  // Ajv standalone may emit CJS `require(...)` for runtime helpers even
  // under `code.esm`. Normalize to ESM `import` first so one inliner
  // pass below handles both emission styles.
  let out = source
    .replace(
      /const (\w+) = require\("([^"]+)"\)\.default;/g,
      'import $1 from "$2";',
    )
    .replace(
      /const (\w+) = require\("([^"]+)"\);/g,
      'import * as $1 from "$2";',
    );
  // Inline each supported runtime helper — replacing the `import` with
  // an inline `const` keeps the emitted module free of bare specifiers.
  // Function form of `.replace` so a `$` in the helper source is never
  // treated as a capture-group reference.
  for (const [specifier, helperSource] of Object.entries(RUNTIME_HELPER_SOURCES)) {
    const importRe = new RegExp(
      `import (\\w+) from "${specifier.replace(/[/]/g, '\\/')}";`,
      'g',
    );
    out = out.replace(
      importRe,
      (_match, binding: string) => `const ${binding} = ${helperSource};`,
    );
  }
  // Survivor check: a remaining `ajv/dist/runtime/*` import means Ajv
  // emitted a helper we don't inline. Fail loud here (server-side,
  // caught by tests / render) rather than shipping a module the iframe
  // cannot load. Scoped to the `ajv/dist/runtime/` prefix — the only
  // specifiers Ajv standalone emits — so an embedded contract-schema
  // string can't false-trip it.
  const leftover = /import\s+[\w*\s{},]+from\s*"(ajv\/dist\/runtime\/[^"]+)"/.exec(out);
  if (leftover) {
    throw new Error(
      `compileValidatorModule: emitted module has an un-inlined import of "${leftover[1]}". Add it to RUNTIME_HELPER_SOURCES.`,
    );
  }
  return out;
}

/**
 * Convert Ajv error objects into our {@link ContractViolation} shape.
 *
 * Path translation: Ajv `instancePath: '/todos/0/done'` →
 * `field: 'todos[0].done'`. Numeric segments become bracket indices,
 * named segments become dot-separated. Empty instancePath collapses
 * to `''` (root-level error).
 *
 * Per-keyword mapping (see {@link mapOne}):
 *   - `additionalProperties` — extra-key violation; `field` includes
 *     the offending key, `expected: '<declared key>'`.
 *   - `required` — missing-key violation; `field` includes the
 *     missing key, `expected: 'present'`, `received: 'undefined'`.
 *   - `type` — type mismatch; `expected` is the JSON Schema type,
 *     `received` reads from the violating value.
 *   - `enum` / `const` — `expected` is the allowed value(s);
 *     `received` is the offending value.
 *   - `pattern` — `expected` is the regex; `received` is the
 *     offending string.
 *   - other keywords — fall through to Ajv's message verbatim.
 */
export function mapAjvErrorsToViolations(
  errors: ErrorObject[] | null | undefined,
  data: unknown,
): ContractViolation[] {
  if (!errors) return [];
  return errors.map(err => mapOne(err, data));
}

/**
 * Re-anchor a list of Ajv-mapped violations under a stable field
 * prefix. Used by the four spec validators to lift Ajv's root-
 * relative paths into the caller's namespace:
 *   - propsSpec: no prefix (paths already prop-relative).
 *   - actionSpec: `<actionName>.data`.
 *   - streamSpec: `<channelName>.payload`.
 *   - contextSpec: `<slotName>.value`.
 *
 * Empty `field` (root-level violation) collapses to the prefix
 * itself; sub-fields dot-join.
 */
export function prefixViolations(
  violations: ContractViolation[],
  prefix: string,
): ContractViolation[] {
  if (!prefix) return violations;
  return violations.map(v => ({
    ...v,
    field: v.field ? `${prefix}.${v.field}` : prefix,
  }));
}

function mapOne(err: ErrorObject, root: unknown): ContractViolation {
  const path = pathFromInstancePath(err.instancePath);

  switch (err.keyword) {
    case 'additionalProperties': {
      const params = err.params as { additionalProperty?: string };
      const extra = params.additionalProperty ?? '<unknown>';
      const fieldPath = path ? `${path}.${extra}` : extra;
      const parentSchema = err.parentSchema as JsonSchema | undefined;
      const declaredKeys = parentSchema?.properties
        ? Object.keys(parentSchema.properties)
        : [];
      const value = resolveAtPath(root, `${err.instancePath}/${extra}`);
      const declaredHint =
        declaredKeys.length > 0
          ? ` Declared keys: [${declaredKeys.join(', ')}].`
          : ' Declared keys: [(none)].';
      return {
        field: fieldPath,
        message: `Undeclared field '${extra}'${path ? ` at '${path}'` : ''}.${declaredHint}`,
        expected: '<declared key>',
        received: jsonTypeOf(value),
      };
    }
    case 'required': {
      const params = err.params as { missingProperty?: string };
      const missing = params.missingProperty ?? '<unknown>';
      const fieldPath = path ? `${path}.${missing}` : missing;
      return {
        field: fieldPath,
        message: `Required field '${missing}' missing${path ? ` at '${path}'` : ''}`,
        expected: 'present',
        received: 'undefined',
      };
    }
    case 'type': {
      const params = err.params as { type?: string | string[] };
      const expected = Array.isArray(params.type)
        ? params.type.join('|')
        : params.type ?? 'unknown';
      const received = jsonTypeOf(resolveAtPath(root, err.instancePath));
      return {
        field: path,
        message: err.message ?? `Type mismatch at '${path || '<root>'}'`,
        expected,
        received,
      };
    }
    case 'enum': {
      const params = err.params as { allowedValues?: unknown[] };
      const allowed = params.allowedValues ?? [];
      const value = resolveAtPath(root, err.instancePath);
      return {
        field: path,
        message: err.message ?? `Enum mismatch at '${path || '<root>'}'`,
        expected: allowed.map(v => JSON.stringify(v)).join('|'),
        received: JSON.stringify(value),
      };
    }
    case 'const': {
      const params = err.params as { allowedValue?: unknown };
      const value = resolveAtPath(root, err.instancePath);
      return {
        field: path,
        message: err.message ?? `Const mismatch at '${path || '<root>'}'`,
        expected: JSON.stringify(params.allowedValue),
        received: JSON.stringify(value),
      };
    }
    case 'pattern': {
      const params = err.params as { pattern?: string };
      const value = resolveAtPath(root, err.instancePath);
      return {
        field: path,
        message: err.message ?? `Pattern mismatch at '${path || '<root>'}'`,
        expected: params.pattern ?? '<pattern>',
        received: typeof value === 'string' ? value : JSON.stringify(value),
      };
    }
    default: {
      return {
        field: path,
        message: err.message ?? `Validation failed${path ? ` at '${path}'` : ''} (${err.keyword})`,
      };
    }
  }
}

/**
 * Convert Ajv slash-style instance path to our bracket-dot field path.
 *
 * Examples:
 *   `''` → `''`
 *   `'/todos'` → `'todos'`
 *   `'/todos/0'` → `'todos[0]'`
 *   `'/todos/0/done'` → `'todos[0].done'`
 *   `'/users/alice/age'` → `'users.alice.age'`
 *
 * Numeric segments become bracket indices; everything else dot-joins.
 * Ajv pre-decodes `~0`/`~1` JSON Pointer escapes, so a key with `/`
 * still arrives slash-free.
 */
function pathFromInstancePath(instancePath: string): string {
  if (!instancePath) return '';
  const parts = instancePath.slice(1).split('/');
  let out = '';
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      out += `[${part}]`;
    } else if (out === '') {
      out = part;
    } else {
      out += `.${part}`;
    }
  }
  return out;
}

function resolveAtPath(root: unknown, instancePath: string): unknown {
  if (!instancePath) return root;
  const parts = instancePath.slice(1).split('/');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (isRecord(cur)) {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
