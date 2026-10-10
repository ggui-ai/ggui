// packages/ui-gen/src/evaluation/axis-checks/helpers.ts
//
// Shared contract inspection + source-scan helpers used by axis checks.
// Ported from the retired mode-checks/ modules.

import type { ActionEntry, DataContract, JsonObject, JsonValue } from "@ggui-ai/protocol";
import {
  HOOK_NAME_RE,
  listContractGadgets,
  STDLIB_GADGETS_PACKAGE,
} from "@ggui-ai/protocol";
import type { EvalIssue } from "../types-public.js";

// =============================================================================
// Contract shape helpers
// =============================================================================

export interface PropShape {
  type?: string;
  required?: boolean;
  items?: { type?: string; properties?: Record<string, unknown> };
  schema?: {
    type?: string;
    items?: { type?: string; properties?: Record<string, unknown> };
  };
}

export interface EntityCollection {
  name: string;
  idField: string;
}

export interface SubmitAction {
  name: string;
  payloadKeys: string[];
}

const ID_FIELD_CANDIDATES = ["id", "uuid", "symbol", "key", "slug", "code"];

function getItemsProperties(p: PropShape): Record<string, unknown> | undefined {
  return p.items?.properties ?? p.schema?.items?.properties;
}

function inferIdField(itemProps: Record<string, unknown> | undefined): string {
  if (!itemProps) return "id";
  for (const cand of ID_FIELD_CANDIDATES) {
    if (cand in itemProps) return cand;
  }
  for (const [k, v] of Object.entries(itemProps)) {
    const vv = v as { type?: string; schema?: { type?: string } } | undefined;
    if (vv?.type === "string" || vv?.schema?.type === "string") return k;
  }
  return "id";
}

export function getRequiredPropNames(contract?: DataContract): string[] {
  const propsField = contract?.propsSpec as
    | { properties?: Record<string, PropShape> }
    | undefined;
  const properties = propsField?.properties ?? {};
  return Object.entries(properties)
    .filter(([, p]) => p && typeof p === "object" && p.required === true)
    .map(([name]) => name);
}

export function getActionNames(contract?: DataContract): string[] {
  return Object.keys(contract?.actionSpec ?? {});
}

export function getStreamEventNames(contract?: DataContract): string[] {
  return Object.keys(contract?.streamSpec ?? {});
}

/**
 * Returns the local BINDING names the boilerplate emits for every
 * HOOK gadget the contract declares — `useGeolocation` → `geolocation`
 * (strip the `use` prefix, lowercase the first char). The wire
 * `clientCapabilities.gadgets` is package-keyed and carries only the
 * export NAME, not a separate binding name, so the binding is derived
 * here exactly as the boilerplate generator derives it.
 *
 * Component gadgets are excluded — they are rendered as JSX, not bound
 * to a `const`, so the `const <name> = …()` axis checks don't apply.
 *
 * The agentCapabilities.tools catalog has no parallel helper —
 * agent-side tools aren't component-side, so the axis checks don't
 * scan source for agent-tool bindings.
 */
export function getGadgetNames(contract?: DataContract): string[] {
  if (!contract) return [];
  return listContractGadgets(contract)
    .filter((use) => HOOK_NAME_RE.test(use.name))
    .map((use) =>
      use.name.length > 3
        ? use.name.charAt(3).toLowerCase() + use.name.slice(4)
        : use.name,
    );
}

/**
 * Like {@link getGadgetNames} but restricted to the first-party
 * `@ggui-ai/gadgets` stdlib package — the built-in browser capabilities
 * (`useGeolocation`, `useCamera`, …) that carry the `idle → prompting →
 * active` lifecycle and therefore need a `.start()` invocation.
 *
 * Registered third-party gadgets (e.g. `useBoardState` from
 * `@example/gadget-board`) are plain data hooks: the runtime resolves
 * them without a user gesture, so the `.start()` axis check must NOT
 * fire on them.
 */
export function getStdlibGadgetNames(contract?: DataContract): string[] {
  if (!contract) return [];
  return listContractGadgets(contract)
    .filter(
      (use) =>
        use.package === STDLIB_GADGETS_PACKAGE && HOOK_NAME_RE.test(use.name),
    )
    .map((use) =>
      use.name.length > 3
        ? use.name.charAt(3).toLowerCase() + use.name.slice(4)
        : use.name,
    );
}

export function getEntityCollections(contract?: DataContract): EntityCollection[] {
  const propsField = contract?.propsSpec as
    | { properties?: Record<string, unknown> }
    | undefined;
  const properties = propsField?.properties ?? {};
  const entities: EntityCollection[] = [];
  for (const [name, p] of Object.entries(properties)) {
    if (!p || typeof p !== "object") continue;
    const pp = p as PropShape;
    const type = pp.type ?? pp.schema?.type;
    const items = pp.items ?? pp.schema?.items;
    if (type === "array" && items?.type === "object") {
      entities.push({ name, idField: inferIdField(getItemsProperties(pp)) });
    }
  }
  return entities;
}

function singularize(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("ses")) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

/**
 * Entity collections that are actually mutated (referenced by a stream
 * event or by an action payload's entity-id key). Static reference lists
 * (e.g., kanban's `columns`) are excluded so they don't trigger
 * "must be in useState" false positives.
 */
export function getMutatedEntityCollections(
  contract: DataContract | undefined,
  allEntities: EntityCollection[],
): EntityCollection[] {
  if (!contract) return allEntities;

  const actionSpec = contract.actionSpec ?? {};
  const streamSpec = contract.streamSpec ?? {};

  const hasStreams = Object.keys(streamSpec).length > 0;

  const referencedIdKeys = new Set<string>();
  for (const action of Object.values(actionSpec) as ActionEntry[]) {
    const ex = action.example;
    if (!ex || typeof ex !== "object" || Array.isArray(ex)) continue;
    for (const key of Object.keys(ex as JsonObject)) {
      if (key === "id" || key === "key" || key === "index") {
        referencedIdKeys.add("id");
        referencedIdKeys.add("key");
        referencedIdKeys.add("index");
      } else if (/Id$/.test(key)) {
        referencedIdKeys.add(key.slice(0, -2).toLowerCase());
      }
    }
  }

  const mutated = allEntities.filter((e) =>
    referencedIdKeys.has(singularize(e.name).toLowerCase()),
  );

  if (mutated.length === 0 && hasStreams && allEntities.length > 0) {
    return [allEntities[0]];
  }
  return mutated.length > 0 ? mutated : allEntities;
}

function countScalarKeys(example: unknown): string[] {
  if (!example || typeof example !== "object" || Array.isArray(example)) return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(example as Record<string, unknown>)) {
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") keys.push(k);
  }
  return keys;
}

export function getSubmitActions(contract?: DataContract): SubmitAction[] {
  const actionSpec = contract?.actionSpec ?? {};
  const result: SubmitAction[] = [];
  for (const [name, action] of Object.entries(actionSpec) as Array<[string, ActionEntry]>) {
    const ex: JsonValue | undefined = action.example;
    const scalarKeys = countScalarKeys(ex);
    if (scalarKeys.length < 3) continue;
    const allKeys = ex && typeof ex === "object" && !Array.isArray(ex)
      ? Object.keys(ex as JsonObject)
      : scalarKeys;
    result.push({ name, payloadKeys: allKeys });
  }
  return result;
}

export function getArrStrProps(contract?: DataContract): string[] {
  const propsField = contract?.propsSpec as
    | { properties?: Record<string, unknown> }
    | undefined;
  const properties = propsField?.properties ?? {};
  const names: string[] = [];
  for (const [name, p] of Object.entries(properties)) {
    if (!p || typeof p !== "object") continue;
    const pp = p as PropShape;
    const type = pp.type ?? pp.schema?.type;
    const items = pp.items ?? pp.schema?.items;
    if (type === "array" && items?.type === "string") names.push(name);
  }
  return names;
}

export function getInitialValuePropNames(contract?: DataContract): string[] {
  const propsField = contract?.propsSpec as
    | { properties?: Record<string, unknown> }
    | undefined;
  const properties = propsField?.properties ?? {};
  const names: string[] = [];
  for (const [name, p] of Object.entries(properties)) {
    if (!p || typeof p !== "object") continue;
    const pp = p as PropShape;
    const type = pp.type ?? pp.schema?.type;
    if (type === "object" && /^initial/i.test(name)) names.push(name);
  }
  return names;
}

// =============================================================================
// Source scanning helpers
// =============================================================================

/**
 * The top-level property keys of the object literal whose `{` is at `open`, read by
 * walking brackets and skipping strings, so a nested object or a `}` inside a string
 * neither ends the literal early nor contributes keys. `undefined` when `open` is not a `{`.
 */
function objectLiteralKeysAt(src: string, open: number): string[] | undefined {
  if (src[open] !== "{") return undefined;
  const keys: string[] = [];
  let depth = 0;
  let expectKey = true;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      // Skip the string; a quoted top-level key ("name": …) is a key too.
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      if (depth === 1 && expectKey && /^\s*:/.test(src.slice(j + 1))) keys.push(src.slice(i + 1, j));
      i = j;
      expectKey = false;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) return keys;
      continue;
    }
    if (depth !== 1) continue;
    if (c === ",") {
      expectKey = true;
      continue;
    }
    if (expectKey && /[A-Za-z_$]/.test(c ?? "")) {
      const m = /^([A-Za-z_$][\w$]*)\s*(:|,|\})/.exec(src.slice(i));
      // `key: value`, or the shorthand `key,` / `key }`.
      if (m !== null && m[1] !== undefined) keys.push(m[1]);
      expectKey = false;
    }
  }
  return keys;
}

/** The argument texts of the call whose `(` is at `open`, split on top-level commas. */
function callArgsAt(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

/**
 * The keys an initial-state argument provides: an object literal (`{ … }`), a lazy
 * initializer returning one (`() => ({ … })`), or an identifier bound to one in the same
 * file (`const INITIAL: Form = { … }`, also behind a lazy `() => INITIAL`).
 */
function initialStateKeys(src: string, argStart: number, argText: string): string[] {
  const lead = argText.length - argText.trimStart().length;
  let at = argStart + lead;
  let text = argText.trim();
  const lazy = /^\(\s*\)\s*=>\s*\(?\s*/.exec(text);
  if (lazy !== null) {
    at += lazy[0].length;
    text = text.slice(lazy[0].length);
  }
  if (text.startsWith("{")) return objectLiteralKeysAt(src, at) ?? [];
  const ident = /^([A-Za-z_$][\w$]*)\s*\)?\s*$/.exec(text);
  if (ident === null || ident[1] === undefined) return [];
  // One binding, or none: a name declared twice (shadowed, or re-declared in another scope) is
  // ambiguous, and ambiguity reads as absence, so the check can never pass on the wrong binding.
  const decls = [...src.matchAll(new RegExp(`(?:const|let|var)\\s+${ident[1]}\\s*(?::[^=]{1,200})?=\\s*`, "g"))];
  const decl = decls.length === 1 ? decls[0] : undefined;
  if (decl === undefined) return [];
  return objectLiteralKeysAt(src, (decl.index ?? 0) + decl[0].length) ?? [];
}

/**
 * Collect all key names that appear as state slots — either keys inside a
 * `useState({ ... })` object literal, or standalone state variables.
 *
 * ggui#1790 — also the initial-state shapes the inline-literal patterns cannot see, each
 * idiomatic React: `useState(INITIAL)` with `const INITIAL = { … }` in the file, a lazy
 * initializer `useState(() => ({ … }))`, and `useReducer(reducer, { … } | INITIAL)`. Missing
 * them made `state.payload.covers_submit` report every payload key missing on a form that held
 * them all, and the model, with nothing real to fix, spent the turn cap rewording a comment.
 */
export function collectStateKeys(src: string): Set<string> {
  const keys = new Set<string>();
  const varRe = /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState/g;
  for (const m of src.matchAll(varRe)) keys.add(m[1]);
  const objRe = /useState(?:<[^>]*>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  for (const m of src.matchAll(objRe)) {
    const keyRe = /(?:^|,)\s*(\w+)\s*:/g;
    for (const km of m[1].matchAll(keyRe)) keys.add(km[1]);
  }
  const defaultObjRe = /useState(?:<[^>]*>)?\s*\([^)]*\|\|\s*\{([^}]*)\}/g;
  for (const m of src.matchAll(defaultObjRe)) {
    const keyRe = /(?:^|,)\s*(\w+)\s*:/g;
    for (const km of m[1].matchAll(keyRe)) keys.add(km[1]);
  }
  // ggui#1790 — the initial-state argument, resolved: useState's first, useReducer's second.
  for (const m of src.matchAll(/\b(useState|useReducer)\s*(?:<[^>]*>)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = callArgsAt(src, open);
    const which = m[1] === "useReducer" ? 1 : 0;
    const arg = args[which];
    if (arg === undefined) continue;
    let argStart = open + 1;
    for (let k = 0; k < which; k++) argStart += (args[k]?.length ?? 0) + 1;
    for (const key of initialStateKeys(src, argStart, arg)) keys.add(key);
  }
  return keys;
}

export function isMultiStepPrompt(prompt: string): boolean {
  if (!prompt) return false;
  const p = prompt.toLowerCase();
  return (
    /\bstep\s*[1-9]\b/.test(p) ||
    /\b[1-9][- ]step\b/.test(p) ||
    /\bmulti[- ]step\b/.test(p) ||
    /\bwizard\b/.test(p) ||
    /\bsteps?:\s*\n?/.test(p)
  );
}

// =============================================================================
// Issue factory
// =============================================================================

export function mkIssue(
  subcategory: string,
  description: string,
  fix: string,
  result: "fail" | "warn" = "fail",
): EvalIssue {
  // mode-category issues are structural (missing hook wiring, bad merge-by-id,
  // hardcoded entity literals) — always P0. See ALIGNMENT.md R1.
  return { tier: 0, result, category: "mode", priority: "P0", subcategory, description, fix };
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Trace flag (ggui#1046): `GGUI_AXIS_CHECK_TRACE=1` makes the dispatcher and the checks
 * that opt in print one JSON line per evaluation round with the facts their verdict was
 * built from — what a reader of a served cell cannot recover from the round's result
 * alone (the source the checks saw, the prompt, the design mode, the classification,
 * the contract's prop keys, which gates matched, which issues came out). Off by default;
 * a diagnostic channel, never part of the result.
 */
export function axisCheckTraceEnabled(): boolean {
  return process.env["GGUI_AXIS_CHECK_TRACE"] === "1";
}
