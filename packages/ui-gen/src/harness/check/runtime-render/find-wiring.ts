// packages/ui-gen/src/harness/check/runtime-render/find-wiring.ts
//
// Source-AST wiring detection.
//
// Given a component's TSX source and a hook reference (e.g., `useAction('save')`),
// determine HOW the resulting callback is wired in JSX so the runtime probe knows
// which trigger to simulate — instead of guessing by clicking everything.
//
// Rules:
// - Handle ONE level of alias indirection:
//     const save = useAction('save');
//     const onSave = () => save(payload);   // alias
//     <Button onClick={onSave} />            // alias used in JSX → click
// - Be CONSERVATIVE on non-native props. Native event names are deterministic;
//   custom-component props (onValueChange, onSelect, onOpenChange) are NOT
//   guaranteed to fire on a synthetic click/change → return `unverified`.
// - Anything we can't classify deterministically returns `unverified` with a
//   reason. NEVER pretend.
//
// Returns ONE detection object summarizing the strongest wiring found, plus
// optional fallback hints. Callers use the kind to pick a simulator.

import ts from "typescript";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type WiringKind =
  | "click"           // wired as native onClick prop on a host element / role-button
  | "submit"          // wired via onSubmit on a form, or button[type=submit]
  | "change"          // wired via onChange on native select/input
  | "keyboard-enter"  // wired via onKeyDown with Enter check
  | "unverified"      // wiring exists but trigger style is non-deterministic
  | "missing";        // hook destructured but never referenced in JSX

export interface WiringDetection {
  readonly kind: WiringKind;
  /**
   * For `unverified`: human-readable reason (e.g., "wired via Dropdown.onChange",
   * "wired into custom-component prop onValueChange", "wired into onDrop handler").
   * For `missing`: brief explanation.
   * For verified kinds: optional element-locator hint (tag name, label).
   */
  readonly reason?: string;
  /**
   * Pure observational: the JSX element types the callback flows into.
   * Useful for richer feedback in the EvalIssue.
   */
  readonly observedJsxElements: readonly string[];
  /**
   * Native event prop names where we observed the callback (e.g., onClick, onSubmit).
   * Empty if only seen on non-native props.
   */
  readonly observedNativeProps: readonly string[];
  /**
   * Non-native event prop names where we observed it (e.g., onValueChange, onSelect).
   * Drives the unverified reason.
   */
  readonly observedCustomProps: readonly string[];
}

export interface FindWiringInput {
  readonly sourceCode: string;
  /** "useAction" or "useWiredTool" or "useStream" or "useClientTool" */
  readonly hookName: string;
  /** The hook's first-arg literal — the action/tool/event name. */
  readonly hookArg: string;
}

// Native DOM event props we can simulate deterministically.
const NATIVE_CLICK_PROPS = new Set(["onClick"]);
const NATIVE_SUBMIT_PROPS = new Set(["onSubmit"]);
const NATIVE_CHANGE_PROPS = new Set(["onChange"]);
const NATIVE_KEY_PROPS = new Set(["onKeyDown", "onKeyUp", "onKeyPress"]);

// JSX element tags (lowercase) that count as host elements with native event behavior.
const HOST_CLICK_TAGS = new Set(["button", "a", "div", "span", "li", "input"]);
const HOST_CHANGE_TAGS = new Set(["select", "input", "textarea"]);

// ─────────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────────

export function findWiring(input: FindWiringInput): WiringDetection {
  const { sourceCode, hookName, hookArg } = input;

  const sf = ts.createSourceFile("Component.tsx", sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Step 1: find the destructured variable name from the hook call.
  //   const save = useAction('save')
  //   const search = useWiredTool('search')
  // Returns the binding name(s) — multiple if the hook returns an object destructure
  // (e.g., useWiredTool returns { call, data, isPending }).
  const hookBindings = findHookBindings(sf, hookName, hookArg);
  if (hookBindings.length === 0) {
    return {
      kind: "missing",
      reason: `Hook ${hookName}('${hookArg}') is not destructured in the component`,
      observedJsxElements: [],
      observedNativeProps: [],
      observedCustomProps: [],
    };
  }

  // Step 2: collect every identifier that should "count" as a reference to the
  // hook's callable. This includes:
  //   - The hook bindings themselves (e.g., `save`)
  //   - For useWiredTool: the `.call` member access (e.g., `search.call`)
  //   - One-level aliases: `const onSave = () => save(...); const onClick = save;`
  //     → `onSave` and `onClick` count as references to `save`
  const callableNames = expandAliases(sf, hookBindings, hookName);

  // Step 3: scan JSX attributes. For each attribute whose value contains a
  // reference to any callableName, classify by attribute name + element kind.
  const observedJsxElements: string[] = [];
  const observedNativeProps: string[] = [];
  const observedCustomProps: string[] = [];

  let sawClickOnHost = false;
  let sawSubmitOnForm = false;
  let sawChangeOnNativeInput = false;
  let sawKeyOnAnything = false;
  let sawNonNativeProp = false;
  const customPropElements: string[] = [];
  const submitButton = { found: false };

  function visit(node: ts.Node): void {
    // <Tag attr={...} />
    if (ts.isJsxAttribute(node) && node.initializer) {
      const attrName = node.name.getText(sf);
      const initRefs = findReferencedNames(node.initializer, callableNames);
      if (initRefs.size > 0) {
        const parent = node.parent.parent; // JsxAttributes → opening element
        const tagName = getTagName(parent);
        if (tagName) observedJsxElements.push(tagName);
        const isHostTag = isHostElementTag(tagName ?? "");

        if (NATIVE_CLICK_PROPS.has(attrName)) {
          observedNativeProps.push(attrName);
          if (isHostTag && (HOST_CLICK_TAGS.has((tagName ?? "").toLowerCase()) || tagName === "button")) {
            sawClickOnHost = true;
          } else {
            // onClick on a custom component (e.g., <Button>) — design-system
            // primitives may or may not forward to a real <button>. Treat as
            // host click for verification purposes — the boilerplate's
            // primitives forward onClick by convention. If they don't, the
            // probe just won't observe a fire and we'll downgrade.
            sawClickOnHost = true;
          }
        } else if (NATIVE_SUBMIT_PROPS.has(attrName)) {
          observedNativeProps.push(attrName);
          if ((tagName ?? "").toLowerCase() === "form") sawSubmitOnForm = true;
          else sawSubmitOnForm = true; // wrapped form component still likely a form
        } else if (NATIVE_CHANGE_PROPS.has(attrName)) {
          observedNativeProps.push(attrName);
          if (HOST_CHANGE_TAGS.has((tagName ?? "").toLowerCase())) {
            sawChangeOnNativeInput = true;
          } else {
            // onChange on a non-native (custom) component — Select/Dropdown
            // commonly use this name but their onChange is NOT triggered by
            // a synthetic 'change' event on a host element. Mark as custom.
            observedCustomProps.push(attrName);
            sawNonNativeProp = true;
            if (tagName) customPropElements.push(tagName);
          }
        } else if (NATIVE_KEY_PROPS.has(attrName)) {
          observedNativeProps.push(attrName);
          sawKeyOnAnything = true;
        } else {
          // Custom prop — onValueChange, onSelect, onOpenChange, onDrop, etc.
          observedCustomProps.push(attrName);
          sawNonNativeProp = true;
          if (tagName) customPropElements.push(tagName);
        }
      }
    }

    // <button type="submit"> implicitly submits its enclosing form
    if (ts.isJsxOpeningLikeElement(node)) {
      const tag = getTagName(node);
      if ((tag ?? "").toLowerCase() === "button") {
        const typeAttr = node.attributes.properties.find(
          p => ts.isJsxAttribute(p) && p.name.getText(sf) === "type",
        );
        if (typeAttr && ts.isJsxAttribute(typeAttr) && typeAttr.initializer) {
          const v = typeAttr.initializer.getText(sf).toLowerCase();
          if (v.includes("submit")) submitButton.found = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  // Step 4: pick the strongest deterministic kind.
  // Order of preference matches "what the user is most likely to actually do":
  //   click (most common) > submit > change > keyboard
  // Unverified wins over a deterministic kind only if NO native wiring was found.

  if (sawClickOnHost) {
    return wrapDetection("click", observedJsxElements, observedNativeProps, observedCustomProps);
  }
  if (sawSubmitOnForm || submitButton.found) {
    return wrapDetection("submit", observedJsxElements, observedNativeProps, observedCustomProps);
  }
  if (sawChangeOnNativeInput) {
    return wrapDetection("change", observedJsxElements, observedNativeProps, observedCustomProps);
  }
  if (sawKeyOnAnything) {
    return wrapDetection("keyboard-enter", observedJsxElements, observedNativeProps, observedCustomProps);
  }

  if (sawNonNativeProp) {
    const props = Array.from(new Set(observedCustomProps)).join(", ");
    const tags = Array.from(new Set(customPropElements)).join(", ");
    return {
      kind: "unverified",
      reason: `Source indicates non-click or non-native wiring; static probe did not verify execution deterministically. Callback flows into ${props} on <${tags}>.`,
      observedJsxElements: dedupe(observedJsxElements),
      observedNativeProps: dedupe(observedNativeProps),
      observedCustomProps: dedupe(observedCustomProps),
    };
  }

  // No JSX usage at all → hook is destructured but never referenced.
  return {
    kind: "missing",
    reason: `Hook ${hookName}('${hookArg}') is destructured but never referenced in any JSX attribute`,
    observedJsxElements: [],
    observedNativeProps: [],
    observedCustomProps: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find variable bindings produced by `hookName('hookArg')` calls.
 *   const save = useAction('save')                          → ['save']
 *   const { call: doSearch } = useWiredTool('search')       → ['doSearch']
 *   const { call, data } = useWiredTool('search')           → ['call', 'data']  (caller filters)
 *
 * For useWiredTool we expand to include `.call` member access against the binding,
 * since the production hook returns { call, data, isPending, error } and `.call`
 * is the dispatch.
 */
function findHookBindings(sf: ts.SourceFile, hookName: string, hookArg: string): string[] {
  const bindings: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      const callee = call.expression.getText(sf);
      if (callee !== hookName) {
        ts.forEachChild(node, visit);
        return;
      }
      // First arg literal must match hookArg
      const firstArg = call.arguments[0];
      if (!firstArg || !ts.isStringLiteral(firstArg)) {
        ts.forEachChild(node, visit);
        return;
      }
      if (firstArg.text !== hookArg) {
        ts.forEachChild(node, visit);
        return;
      }
      // Identify binding
      if (ts.isIdentifier(node.name)) {
        bindings.push(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const elem of node.name.elements) {
          // const { call: doSearch } = ... → propName=call, name=doSearch
          // const { call } = ...           → name=call
          const target = elem.name;
          if (ts.isIdentifier(target)) bindings.push(target.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return bindings;
}

/**
 * Expand bindings with one-level aliases:
 *   const save = useAction('save')
 *   const onSave = () => save(payload)         → onSave is alias for save
 *   const handleClick = save                    → handleClick is alias for save
 *
 * For useWiredTool: also include `${binding}.call` so that
 *   <Button onClick={() => search.call(...)}> matches.
 *
 * Returns the set of identifier NAMES that should count as the hook's callable
 * (used by JSX scanner to detect references).
 */
function expandAliases(sf: ts.SourceFile, bindings: string[], hookName: string): Set<string> {
  const all = new Set<string>(bindings);

  // For useWiredTool, also accept member expressions {binding}.call.
  // We model this as "any identifier named exactly the binding" — the JSX
  // scanner uses findReferencedNames which descends into property accesses.

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name)
    ) {
      const newName = node.name.text;
      const init = node.initializer;
      // Direct alias: const handleClick = save;
      if (ts.isIdentifier(init) && all.has(init.text)) {
        all.add(newName);
      }
      // Wrapper closure: const onSave = () => save(payload);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        if (bodyReferences(init.body, all, hookName)) {
          all.add(newName);
        }
      }
      // Common React wrappers: useCallback(() => save(...), [...]) / useMemo(...)
      // Generalize: walk the entire initializer expression for hook references.
      // If found, the alias counts as a reference site.
      if (ts.isCallExpression(init)) {
        if (bodyReferences(init, all, hookName)) {
          all.add(newName);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return all;
}

function bodyReferences(body: ts.Node, names: ReadonlySet<string>, hookName: string): boolean {
  let found = false;
  function walk(n: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      found = true;
      return;
    }
    // For useWiredTool: recognize `${binding}.call` pattern
    if (
      hookName === "useWiredTool" &&
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      names.has(n.expression.text) &&
      n.name.text === "call"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  }
  walk(body);
  return found;
}

/**
 * Scan a JSX attribute initializer expression for any identifier name in `names`.
 * Returns the set of matching names found.
 */
function findReferencedNames(node: ts.Node, names: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  function walk(n: ts.Node): void {
    if (ts.isIdentifier(n) && names.has(n.text)) {
      found.add(n.text);
    } else if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      names.has(n.expression.text)
    ) {
      // matches `binding.call` in <Button onClick={() => binding.call(...)}>
      found.add(n.expression.text);
    }
    ts.forEachChild(n, walk);
  }
  walk(node);
  return found;
}

function getTagName(el: ts.Node): string | null {
  if (ts.isJsxOpeningLikeElement(el)) {
    return el.tagName.getText();
  }
  return null;
}

function isHostElementTag(name: string): boolean {
  // Lowercase first letter = host element (button, div, form, etc.)
  // Capitalized = React component
  if (!name) return false;
  return name[0] === name[0]!.toLowerCase();
}

function wrapDetection(
  kind: WiringKind,
  jsx: string[],
  native: string[],
  custom: string[],
): WiringDetection {
  return {
    kind,
    observedJsxElements: dedupe(jsx),
    observedNativeProps: dedupe(native),
    observedCustomProps: dedupe(custom),
  };
}

function dedupe<T>(arr: readonly T[]): T[] {
  return Array.from(new Set(arr));
}
