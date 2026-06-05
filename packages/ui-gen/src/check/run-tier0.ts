// packages/ui-gen/src/check/run-tier0.ts
//
// Tier-0 deterministic CHECK orchestrator — the programmatic half of
// the three-tier evaluation system:
//   Tier 0 — programmatic (deterministic, no LLM) ← this file
//   Tier 1 — LLM critical checks (functionality, crash)
//   Tier 2 — LLM quality checks (interactivity, accessibility, layout, etc.)
//
// Composes the deterministic helpers (`extract-wire-calls`,
// `react-linter`, `contract-validation`, `type-checker`) from the
// `@ggui-ai/ui-gen/check` subpath. The purely-typed evaluation surface
// (`EvalTier` / `EvalOutcome` / `priorityForIssue` / …) is imported
// directly from `@ggui-ai/ui-gen/evaluation` — its canonical home.

import ts from 'typescript';
import type { DataContract } from '@ggui-ai/protocol';
import { HOOK_NAME_RE, listContractGadgets } from '@ggui-ai/protocol';
import { validateAllContracts, type ContractIssue } from './contract-validation.js';
import { typecheck } from './type-checker.js';
import { lintReactHooks, type ReactLintDiagnostic } from './react-linter.js';
import { isAllowedImport, describeAllowedImports } from '../validation/allowed-imports.js';
import {
  checkWireImports,
  checkWirePreservation,
  type WireKind,
} from './extract-wire-calls.js';
import {
  priorityForIssue,
  type EvalCategory,
  type EvalIssue,
  type EvalResult,
} from '../evaluation/types-public.js';

/**
 * Strip line + block comments from source, leaving all other text in
 * place. Uses the TS scanner so a `//` or block-comment sequence inside
 * a string / template / regex literal is NOT mistaken for a comment.
 * Comment characters are replaced with spaces (newlines kept) so byte
 * offsets and line numbers are unchanged.
 *
 * Used by regex-based CHECK rules that must not be satisfied by
 * commented-out code (e.g. `gadget_preservation`).
 */
function stripComments(code: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.JSX,
    code,
  );
  let out = '';
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    const text = scanner.getTokenText();
    out +=
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
        ? text.replace(/[^\n]/g, ' ')
        : text;
  }
  return out;
}

/**
 * AST-precise detector for the unambiguous nested-interactive
 * double-wire pattern. See the call-site comment in `runTier0Checks` +
 * the `double-wired-action:certain` block for the rationale.
 *
 * The detector accepts a JSX element as the outer host when:
 *   - tagName ∈ {Card, Box, Stack, Row}
 *   - has `as={Clickable | Pressable}` (`Hoverable` doesn't fire click)
 *   - has `onClick` (or `onPress`) whose handler calls one of the
 *     known `useAction` bindings.
 *
 * Then it walks descendants of that outer element and matches an inner
 * interactive primitive when:
 *   - tagName ∈ {Button, Checkbox, Input, Toggle, Slider, RadioGroup,
 *     Select, TextArea, Link}
 *   - has any of {onClick, onChange, onPress, onSelect} whose handler
 *     calls the SAME useAction binding as the outer.
 *
 * Patterns it INTENTIONALLY does not catch:
 *   - helper-function indirection (`const fire = () => toggle({id})`
 *     in both handlers) — the AST sees two distinct callees, not the
 *     same binding. The runtime dedup in `useAction` still catches the
 *     symptom; the static-time catch is a teaching aid, not a safety
 *     net.
 *   - cross-component prop drilling — same reason.
 *   - imperative DOM addEventListener — out of scope for JSX walking.
 */
function detectCertainDoubleWiredActions(
  sourceCode: string,
  actionBindings: readonly string[],
): EvalIssue[] {
  const issues: EvalIssue[] = [];
  if (actionBindings.length === 0) return issues;
  const bindings = new Set(actionBindings);
  const TRAIT_HOST_TAGS = new Set(['Card', 'Box', 'Stack', 'Row']);
  const TRAITS_THAT_FIRE = new Set(['Clickable', 'Pressable']);
  const INTERACTIVE_DESCENDANTS = new Set([
    'Button',
    'Checkbox',
    'Input',
    'Toggle',
    'Slider',
    'RadioGroup',
    'Select',
    'TextArea',
    'Link',
  ]);
  const HANDLER_ATTRS = ['onClick', 'onChange', 'onPress', 'onSelect'] as const;

  const sf = ts.createSourceFile(
    'source.tsx',
    sourceCode,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  function tagNameText(
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ): string | undefined {
    return ts.isIdentifier(node.tagName) ? node.tagName.text : undefined;
  }

  function attrExpression(
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    attrName: string,
  ): ts.Expression | undefined {
    for (const attr of node.attributes.properties) {
      if (
        ts.isJsxAttribute(attr) &&
        ts.isIdentifier(attr.name) &&
        attr.name.text === attrName &&
        attr.initializer !== undefined &&
        ts.isJsxExpression(attr.initializer)
      ) {
        return attr.initializer.expression;
      }
    }
    return undefined;
  }

  function isTraitHostWithFiringAs(node: ts.JsxOpeningElement): boolean {
    const tag = tagNameText(node);
    if (tag === undefined || !TRAIT_HOST_TAGS.has(tag)) return false;
    const asExpr = attrExpression(node, 'as');
    return (
      asExpr !== undefined &&
      ts.isIdentifier(asExpr) &&
      TRAITS_THAT_FIRE.has(asExpr.text)
    );
  }

  // Best-effort callee extraction from event-handler expression shapes
  // the LLM actually emits. Forms covered:
  //   {handler}                          → 'handler'
  //   {() => callee(arg)}                → 'callee'
  //   {(e) => callee(e)}                 → 'callee'
  //   {() => { callee(arg); }}           → 'callee'
  //   {function () { callee(arg); }}     → 'callee'
  // Forms intentionally not covered: chained calls, conditional
  // expressions, calls inside if-branches. Those are rare in
  // LLM-generated JSX and would expand the FP surface.
  function extractCalleeName(
    expr: ts.Expression | undefined,
  ): string | undefined {
    if (expr === undefined) return undefined;
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      const body = expr.body;
      if (ts.isCallExpression(body) && ts.isIdentifier(body.expression)) {
        return body.expression.text;
      }
      if (ts.isBlock(body)) {
        for (const stmt of body.statements) {
          if (
            ts.isExpressionStatement(stmt) &&
            ts.isCallExpression(stmt.expression) &&
            ts.isIdentifier(stmt.expression.expression)
          ) {
            return stmt.expression.expression.text;
          }
        }
      }
    }
    return undefined;
  }

  function findMatchingInteractiveDescendant(
    outer: ts.JsxElement,
    expectedBinding: string,
  ): { tag: string; line: number } | undefined {
    let found: { tag: string; line: number } | undefined;
    function walk(node: ts.Node): void {
      if (found !== undefined) return;
      const opening = ts.isJsxElement(node)
        ? node.openingElement
        : ts.isJsxSelfClosingElement(node)
          ? node
          : undefined;
      if (opening !== undefined) {
        const tag = tagNameText(opening);
        if (tag !== undefined && INTERACTIVE_DESCENDANTS.has(tag)) {
          for (const attrName of HANDLER_ATTRS) {
            const callee = extractCalleeName(attrExpression(opening, attrName));
            if (callee === expectedBinding) {
              found = {
                tag,
                line:
                  sf.getLineAndCharacterOfPosition(opening.getStart()).line + 1,
              };
              return;
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    }
    // Walk only the outer element's children, not the outer itself.
    ts.forEachChild(outer, walk);
    return found;
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) && isTraitHostWithFiringAs(node.openingElement)) {
      const outerCallee =
        extractCalleeName(attrExpression(node.openingElement, 'onClick')) ??
        extractCalleeName(attrExpression(node.openingElement, 'onPress'));
      if (outerCallee !== undefined && bindings.has(outerCallee)) {
        const match = findMatchingInteractiveDescendant(node, outerCallee);
        if (match !== undefined) {
          const outerTag = tagNameText(node.openingElement);
          const outerLine =
            sf.getLineAndCharacterOfPosition(node.openingElement.getStart())
              .line + 1;
          issues.push({
            tier: 0,
            result: 'fail',
            category: 'interactivity',
            subcategory: 'double-wired-action:certain',
            severity: 'critical',
            description:
              `Nested-interactive double-wire: outer <${outerTag} as={...}> at line ${outerLine} and inner <${match.tag}> at line ${match.line} both dispatch the same useAction binding '${outerCallee}'. ` +
              `One user click on the inner control fires its handler AND bubbles to the outer handler — '${outerCallee}' dispatches TWICE, the action runs back-to-back, and a toggle-style action silently reverts the user's change.`,
            fix: `Pick ONE surface for the gesture: either drop \`as={...}\` + onClick on the outer <${outerTag}> and let the inner <${match.tag}> own the gesture, OR remove the inner <${match.tag}> and let the outer <${outerTag} as={...}> own it. Don't wire both to the same useAction binding.`,
            line: outerLine,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return issues;
}

/** Map wire kind to the matching `@ggui-ai/wire` hook name. */
const HOOK_NAME_FOR: Readonly<Record<WireKind, string>> = {
  action: 'useAction',
  stream: 'useStream',
  context: 'useGguiContext',
};

/**
 * Map wire kind to the contract field the agent must declare on the
 * `contract` input to `ggui_render` (post-Phase-2 flat handshake input)
 * to make the `useX('<name>')` call legal.
 *
 * Drives the remediation message on the `wire_undeclared` fail.
 * Telling the LLM "declare it on contextSpec.<slotName>" with the
 * JSON-Schema starter is concretely actionable; "declare a contract"
 * alone is not.
 */
const CONTRACT_FIELD_FOR: Readonly<Record<WireKind, string>> = {
  action: 'actionSpec',
  stream: 'streamSpec',
  context: 'contextSpec',
};

// =============================================================================
// Tier 0: Programmatic Hard Checks
// =============================================================================

/**
 * Whether comment-free `source` imports the named gadget `exportName`
 * from `pkg` — `import { …, exportName, … } from '<pkg>'` (the source
 * name, left of any `as`). Kind-agnostic — hook and component exports
 * are both direct-imported the same way. The `gadget_preservation`
 * anchor: generated code direct-imports each gadget export, and the
 * import is what the iframe rewriter binds to the per-package runtime
 * shim.
 */
function isGadgetExportImported(
  source: string,
  pkg: string,
  exportName: string,
): boolean {
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${esc}['"]`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    for (const raw of m[1].split(',')) {
      if (raw.trim().split(/\s+as\s+/)[0]?.trim() === exportName) return true;
    }
  }
  return false;
}

/**
 * Run all tier 0 (deterministic, no-LLM) checks against source and compiled code.
 *
 * Wraps the same logic as runSelfChecks (adapters/tools.ts) but emits EvalIssue[].
 * Also runs contract validation when contract are provided.
 */
export async function runTier0Checks(
  sourceCode: string,
  compiledCode: string | null,
  contract?: DataContract,
  buildErrors?: string[],
  /**
   * A `package -> .d.ts content` map for third-party gadget wrappers.
   * Threaded verbatim into `typecheck()` so the in-memory TS sandbox
   * overlays each wrapper `.d.ts` at `node_modules/<package>/index.d.ts`
   * — a generated direct import `import { useX } from '<package>'`
   * resolves against the real declaration (strict option/return
   * narrowing). Standard-library-only callers omit it.
   */
  gadgetTypes?: Readonly<Record<string, string>>,
): Promise<EvalIssue[]> {
  const issues: EvalIssue[] = [];
  const lines = sourceCode.split('\n');

  // ── Compile check ─────────────────────────────────────────
  //
  // Fail only when the caller ATTEMPTED compile and captured errors.
  // A `compiledCode === null` without `buildErrors` means the caller
  // hasn't run esbuild at all (e.g. OSS `createUiGenerator` which is
  // sometimes wrapped by `withBrowserCompile` and sometimes not);
  // degrade gracefully — downstream checks (security, forbidden
  // imports, wire-import presence, react-linter, Props-interface,
  // default-export) still fire on sourceCode alone.
  if (buildErrors && buildErrors.length > 0) {
    const errorDetail = buildErrors
      .map((e) => {
        // Extract key info from esbuild error (e.g., line number, error type)
        const match = e.match(/<stdin>:(\d+):\d+: ERROR: (.+)/);
        return match ? `Line ${match[1]}: ${match[2]}` : e.slice(0, 200);
      })
      .join('\n');
    issues.push({
      tier: 0,
      result: 'fail',
      category: 'compile',
      severity: 'critical',
      description: `Component failed to compile:\n${errorDetail}`,
      fix: 'Fix the JSX/TypeScript syntax errors listed above',
    });
  }

  // ── assetColor allow-list ─────────────────────────────────
  //
  // T-4: Box gains a typed brand-color escape pair —
  //   <Box assetColor="#635BFF" assetSemantic="stripe-brand-purple">
  // The static hex / rgba checks below allow a hex/rgba/hsl whose
  // `JSXAttribute` parent is `assetColor`, but only when a sibling
  // `assetSemantic` attribute carries a non-empty string value on the
  // same JSX opening tag. Both pieces are required: an `assetColor`
  // alone, or `assetSemantic=""`, fails.
  //
  // Implementation: collect the (1-based) line numbers of every line
  // whose JSX opening tag legitimately satisfies this pair. The
  // hex/colorFn/named-color checks below skip emitting a failure
  // when the matching line is in this allow-list.
  const assetEscapedLines = new Set<number>();
  // Match each JSX opening tag (allowing multiline attribute lists).
  // The regex captures the tag's attribute span; we then check it for
  // the required `assetColor` + non-empty `assetSemantic` pair, and
  // record every source line that the tag spans.
  const jsxOpenRegex = /<([A-Z][A-Za-z0-9]*)\b([^>]*)>/gs;
  for (const match of sourceCode.matchAll(jsxOpenRegex)) {
    const tagAttrs = match[2];
    const assetColorAttr = tagAttrs.match(/\bassetColor\s*=\s*(?:["']([^"']*)["']|\{[^}]*\})/);
    if (!assetColorAttr) continue;
    const assetSemanticAttr = tagAttrs.match(/\bassetSemantic\s*=\s*["']([^"']*)["']/);
    const startLine = sourceCode.slice(0, match.index ?? 0).split('\n').length;
    const tagLineCount = match[0].split('\n').length;
    // Both attributes must be present, AND assetSemantic must be a
    // non-empty string literal. A `{expr}` value for assetSemantic is
    // treated as not-statically-verifiable; the escape is opt-in
    // documentation, not a runtime expression. Failing pairs emit a
    // dedicated `tokens:asset-color-pair` failure AND do NOT enter
    // the allow-list — so the embedded hex still fires its own
    // `tokens:hex-color` failure (two issues, one per axis).
    if (!assetSemanticAttr || assetSemanticAttr[1].length === 0) {
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'tokens',
        subcategory: 'asset-color-pair',
        severity: 'critical',
        description:
          'Box `assetColor` set without a non-empty `assetSemantic` — the typed brand-color escape requires both. ' +
          '`assetSemantic` is a human-readable label that documents why this color bypasses the theme.',
        fix:
          'Pair the `assetColor` with a non-empty `assetSemantic` literal, e.g. ' +
          '`<Box assetColor="#635BFF" assetSemantic="stripe-brand-purple">`. Reach for `surface="..."` first ' +
          'whenever the color SHOULD track the operator\'s theme.',
        line: startLine,
      });
      continue;
    }
    for (let l = 0; l < tagLineCount; l++) {
      assetEscapedLines.add(startLine + l);
    }
  }

  // Gadget packages the contract declares are import-
  // allowlisted. Generated code direct-imports gadget exports from
  // their package. `clientCapabilities.gadgets` is
  // package-keyed, so the map's own keys ARE the permitted import
  // sources, alongside the STDLIB `@ggui-ai/gadgets`.
  const allowedGadgetPackages = new Set<string>(
    Object.keys(contract?.clientCapabilities?.gadgets ?? {}),
  );

  // ── Line-by-line checks ───────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Security: eval()
    if (/\beval\s*\(/.test(line)) {
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'security',
        subcategory: 'eval',
        severity: 'critical',
        description: 'eval() is forbidden',
        fix: 'Remove eval() call entirely',
        line: lineNum,
      });
    }

    // Security: fetch()
    if (/\bfetch\s*\(/.test(line)) {
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'security',
        subcategory: 'fetch',
        severity: 'critical',
        description: 'fetch() is forbidden — use props for data',
        fix: 'Remove fetch() and pass data via props',
        line: lineNum,
      });
    }

    // Forbidden imports (skip commented-out imports)
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*')) continue;
    const importMatch = trimmedLine.match(/import\s+.*from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const pkg = importMatch[1];
      // Allowlist mirrors `validation/component-detailed.ts` ALLOWED_IMPORTS —
      // these two must stay in sync. Generated code direct-imports
      // gadget exports, so every gadget package the contract declares
      // (`clientCapabilities.gadgets[*].package`) is allowlisted alongside
      // the STDLIB `@ggui-ai/gadgets`. Rejecting a declared gadget package
      // would contradict the `gadget_preservation` check (which REQUIRES
      // the direct import).
      if (!isAllowedImport(pkg, allowedGadgetPackages)) {
        issues.push({
          tier: 0,
          result: 'fail',
          category: 'imports',
          severity: 'critical',
          description: `Import from "${pkg}" is not allowed`,
          fix: `Only import from: ${describeAllowedImports()}`,
          line: lineNum,
        });
      }
    }

    // Hardcoded hex colors (not inside CSS variable fallbacks).
    //
    // Empirical (warn → fail rationale): when the
    // operator's prompt evoked a strong aesthetic ("garden / living
    // ecosystem"), the LLM emitted hex literals (`#B8FF3A` lime,
    // `#0a0a0a` near-black) inline on `color`/`background` style
    // overrides — completely overriding the operator's selected theme.
    // The warn-level rule was advisory and got ignored. As a `fail`
    // it forces the LLM to remediate before passing self-check.
    //
    // Generation contract this enforces (per the contract bar): the
    // LLM describes structure + intent; the theme + primitive variants
    // describe visuals. Hardcoded hex is a contract violation. The
    // existing `var(--ggui-*, #fallback)` exception keeps legit token
    // patterns flowing untouched. Asset-fixed brand colors get a
    // typed escape on Box (`assetColor` + `assetSemantic`) — see
    // T-4 follow-up.
    const hexMatch = line.match(/#[0-9a-fA-F]{3,8}\b/);
    if (
      hexMatch &&
      !line.includes('var(--ggui-') &&
      !line.includes('// fallback') &&
      !assetEscapedLines.has(lineNum)
    ) {
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'tokens',
        subcategory: 'hex-color',
        severity: 'critical',
        description: `Hardcoded color "${hexMatch[0]}" breaks theme switching — use design tokens.`,
        fix: `Replace with a primitive variant (Button variant="primary"|Badge variant="success"|...) OR a token reference like var(--ggui-color-primary-500, ${hexMatch[0]}). Hardcoded colors mean the operator's theme has no effect on this surface.`,
        line: lineNum,
      });
    }

    // Hardcoded rgba()/hsl() color functions — same reasoning as above.
    // Treated as `fail` for symmetry — a hardcoded `rgba(184, 255, 58, 1)`
    // is functionally identical to `#B8FF3A` from a theme-override
    // standpoint.
    const colorFnMatch = line.match(/\b(rgba?|hsla?)\s*\(/);
    if (
      colorFnMatch &&
      !line.includes('var(--ggui-') &&
      !line.includes('// fallback') &&
      !line.includes('$value') &&
      !assetEscapedLines.has(lineNum)
    ) {
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'tokens',
        subcategory: 'hardcoded-color-fn',
        severity: 'critical',
        description: `Hardcoded ${colorFnMatch[1]}() breaks theme switching — use design tokens.`,
        fix: 'Replace with a primitive variant OR a semantic token: var(--ggui-color-surface), var(--ggui-color-onSurface), var(--ggui-color-outline), etc.',
        line: lineNum,
      });
    }

    // Raw CSS length on a spacing / radius prop — bypasses the design
    // scale. Same reasoning as the hardcoded-color checks above: a
    // literal `gap="8px"` defeats the theme's spacing scale exactly as
    // `#fff` defeats its colors. Only the STRING-literal form fails;
    // the numeric escape (`gap={12}`) is untouched, so a genuine
    // off-scale pixel value still has a path.
    const rawSpacingMatch = line.match(
      /\b(gap|padding|paddingX|paddingY|margin|radius)\s*=\s*["'][\d.]+(?:px|rem|em)["']/,
    );
    if (rawSpacingMatch) {
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'tokens',
        subcategory: 'raw-spacing',
        severity: 'critical',
        description: `\`${rawSpacingMatch[1]}\` uses a raw CSS length — bypasses the design spacing/radius scale.`,
        fix: `Use a scale name: ${rawSpacingMatch[1]}="xs|sm|md|lg|xl" (spacing also has none|2xl; radius none|sm|md|lg|xl). For an exact off-scale pixel value pass a number — ${rawSpacingMatch[1]}={12}.`,
        line: lineNum,
      });
    }

    // CSS named-color literals on color/background sinks. Closes the
    // residual escape after the hex/rgb checks: `style={{ color:
    // 'lime' }}` or `style={{ background: 'royalblue' }}`. The hex
    // check doesn't match these because they're keyword identifiers,
    // not `#`-prefixed hex. CSS-spec named colors are a finite set;
    // we match the obvious ones the LLM reaches for.
    //
    // Allowed keywords (no fail): `inherit`, `currentColor`,
    // `transparent`, `unset`, `initial`, `revert`, `none`. These have
    // legitimate semantic uses (inherit for nested rendering, none
    // for explicit empty fill).
    //
    // Out-of-scope by design: token-name strings like `color:
    // 'primary'` — those would render as invalid CSS and a separate
    // self-check (the existing prop-value validator) catches them.
    const namedColorMatch = line.match(
      /(?:^|[^a-zA-Z-])(?:color|background|backgroundColor|borderColor)\s*:\s*['"]([a-z][a-zA-Z]+)['"]/,
    );
    if (namedColorMatch) {
      const named = namedColorMatch[1].toLowerCase();
      const allowed = new Set([
        'inherit', 'currentcolor', 'transparent',
        'unset', 'initial', 'revert', 'none',
      ]);
      // Heuristic for the named-color lexicon. Covers every CSS-spec
      // color the LLM has empirically reached for; new keywords can
      // be added as they surface in benchmarks. Token-name strings
      // (`'primary'`) bypass this check because they're not in the
      // lexicon — the prop-value validator catches them as invalid
      // enum values.
      const namedCssColors = new Set([
        'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink',
        'cyan', 'magenta', 'lime', 'teal', 'navy', 'maroon', 'olive',
        'aqua', 'fuchsia', 'silver', 'gray', 'grey', 'white', 'black',
        'brown', 'gold', 'indigo', 'violet', 'crimson', 'tomato',
        'coral', 'salmon', 'orchid', 'plum', 'tan', 'khaki', 'beige',
        'ivory', 'lavender', 'mint', 'turquoise', 'azure',
        'royalblue', 'darkblue', 'lightblue', 'skyblue', 'steelblue',
        'darkred', 'lightgreen', 'darkgreen', 'forestgreen',
        'darkorange', 'lightgray', 'lightgrey', 'darkgray', 'darkgrey',
        'hotpink', 'deeppink', 'lightpink', 'lightyellow',
      ]);
      if (!allowed.has(named) && namedCssColors.has(named)) {
        issues.push({
          tier: 0,
          result: 'fail',
          category: 'tokens',
          subcategory: 'named-color',
          severity: 'critical',
          description: `Hardcoded CSS named color "${named}" breaks theme switching — use design tokens.`,
          fix: `Replace with a typed slot (Text tone="muted" / Box surface="accent" / Badge variant="success") OR a semantic token: var(--ggui-color-onSurfaceVariant), var(--ggui-color-primary-500), etc. The keyword "${named}" maps to a fixed RGB; the operator's theme has no effect on it.`,
          line: lineNum,
        });
      }
    }

    // Raw pixel values in spacing CSS properties
    const pxMatch = line.match(/(?:padding|margin|gap|borderRadius)\s*:\s*['"]?\d+px/);
    if (pxMatch && !line.includes('var(--ggui-')) {
      issues.push({
        tier: 0,
        result: 'warn',
        category: 'tokens',
        subcategory: 'raw-pixels',
        description: 'Raw pixel value in spacing — must use design tokens',
        fix: 'Replace with var(--ggui-spacing-*, fallback)',
        line: lineNum,
      });
    }

    // Numeric spacing props on components (e.g., padding={24}, gap={8})
    // These bypass the design system — should use var(--ggui-spacing-*)
    const numericSpacingMatch = line.match(/\b(padding|paddingX|paddingY|gap|margin)\s*=\s*\{?\s*(\d+)\s*\}?/);
    if (numericSpacingMatch && !line.includes('var(--ggui-')) {
      issues.push({
        tier: 0,
        result: 'warn',
        category: 'tokens',
        subcategory: 'numeric-spacing-prop',
        description: `Numeric spacing prop ${numericSpacingMatch[1]}={${numericSpacingMatch[2]}} — use design tokens instead`,
        fix: `Replace with ${numericSpacingMatch[1]}="var(--ggui-spacing-*)"`,
        line: lineNum,
      });
    }
  }

  // ── Clickable trait check — onClick on a structural primitive needs as={Clickable} ──
  // Only the four trait-host primitives (typed `WithTrait<…>`) accept
  // `as={Clickable}`. Text/Heading/Badge/Avatar/Image are NOT hosts, so an
  // onClick on them is a plain type error the type-checker catches — don't
  // steer those toward `as={Clickable}` (it won't compile on them).
  const clickablePattern = /<(?:Card|Box|Stack|Row)\s[^>]*onClick/;
  for (let i = 0; i < lines.length; i++) {
    if (clickablePattern.test(lines[i]) && !lines[i].includes('as={Clickable}') && !lines[i].includes('as={Pressable}')) {
      issues.push({
        tier: 0, result: 'warn', category: 'contract', subcategory: 'clickable-wrapper',
        description: `onClick on a structural primitive without as={Clickable} — the bare primitive has no click or keyboard handling`,
        fix: `Add as={Clickable} to the element, e.g., <Card as={Clickable} onClick={handler}>`,
        line: i + 1,
      });
    }
  }

  // ── Double-wired action check (warn — broad regex) ──────────
  // A useAction callback dispatched from 2+ call sites fires the action
  // more than once per gesture when an interactive element nests inside
  // another (the inner gesture bubbles to the outer handler). Captured
  // in scenario-07: a `Card as={Clickable} onClick` row containing a
  // `Checkbox onChange`, both calling the same action → double-toggle.
  const actionBindings = [
    ...sourceCode.matchAll(/(?:const|let)\s+(\w+)\s*=\s*useAction\s*\(/g),
  ]
    .map((m) => m[1])
    .filter((name): name is string => typeof name === 'string');
  for (const binding of actionBindings) {
    const callSites = (
      sourceCode.match(new RegExp(`\\b${binding}\\s*\\(`, 'g')) ?? []
    ).length;
    if (callSites >= 2) {
      // Kept at WARN — too many legit patterns (confirm/cancel, branched
      // dispatch, sibling buttons in a list) match this generic shape. The
      // structural correctness backstop lives at runtime in `useAction`'s
      // task-scoped dedup; this check is a quality nudge for the LLM, not a
      // load-bearing safety gate. See `docs/principles/no-silent-block.md`
      // — three-pattern FP test fails for this detector → severity = warn.
      issues.push({
        tier: 0,
        result: 'warn',
        category: 'interactivity',
        subcategory: 'double-wired-action',
        description: `Action '${binding}' is dispatched from ${callSites} call sites — if an interactive element nests inside another, one gesture fires the action twice (the inner gesture bubbles to the outer handler).`,
        fix: `Wire each useAction callback to exactly ONE interactive surface; never nest interactive elements (e.g. a Checkbox inside a Card as={Clickable}).`,
      });
    }
  }

  // ── Double-wired action check (fail — narrow AST) ────────────
  // Precise detector for the unambiguous shape: an outer trait-host JSX
  // element (Card/Box/Stack/Row with `as={Clickable|Pressable}`) wired
  // via onClick/onPress to useAction binding X, with a descendant
  // interactive primitive (Checkbox/Button/Input/Toggle/Slider/
  // RadioGroup/Select/TextArea/Link) wired via on* to the SAME X.
  //
  // Near-zero FP: the only patterns matching `<Card as={Clickable}
  // onClick={X}> ... <Checkbox onChange={X}>` are bugs. Three-pattern
  // FP test passes → severity earns 'fail' per no-silent-block
  // principle Rule 1. The runtime dedup in @ggui-ai/wire's useAction
  // catches the SYMPTOM regardless of shape; this check catches the
  // CAUSE one turn earlier and prevents shipping the broken a11y nest.
  if (actionBindings.length > 0) {
    issues.push(
      ...detectCertainDoubleWiredActions(sourceCode, actionBindings),
    );
  }

  // ── Optional props accessed without guard ──────────────────
  // Check if Props interface has optional fields that are accessed without ?. or ?? or &&
  const propsInterfaceMatch = sourceCode.match(/interface Props\s*\{([^}]+)\}/);
  if (propsInterfaceMatch) {
    const propsBody = propsInterfaceMatch[1];
    const optionalProps = [...propsBody.matchAll(/(\w+)\?:/g)].map(m => m[1]);
    for (const prop of optionalProps) {
      // Check for unguarded access: props.field. (dot access) or props.field[ (bracket access)
      // without being preceded by props.field?. or props.field ?? or props.field &&
      const accessPattern = new RegExp(`props\\.${prop}[.\\[]`, 'g');
      const guardPattern = new RegExp(`props\\.${prop}(\\?[.[]|\\s*&&|\\s*\\?\\?)`, 'g');
      const accesses = (sourceCode.match(accessPattern) || []).length;
      const guards = (sourceCode.match(guardPattern) || []).length;
      if (accesses > 0 && guards === 0) {
        issues.push({
          tier: 0, result: 'warn', category: 'crash', subcategory: `optional-prop:${prop}`,
          description: `Optional prop 'props.${prop}' accessed without null guard — will crash if undefined`,
          fix: `Use props.${prop}?.field or props.${prop} ?? fallback or {props.${prop} && ...}`,
        });
      }
    }
  }

  // ── Common pitfalls (recurring LLM mistakes that cost a turn) ─
  // Scan whole source so multiline opening tags (attrs split across lines) are caught.
  // Each match's line number = the line where the tag opens.
  const ALIGN_VALUES = new Set(['start', 'center', 'end', 'stretch']);
  const JUSTIFY_VALUES = new Set(['start', 'center', 'end', 'between', 'around', 'evenly']);
  const tagRegex = /<(Stack|Row)\b([^>]*)>/gs;
  for (const tag of sourceCode.matchAll(tagRegex)) {
    const tagName = tag[1];
    const attrs = tag[2];
    const tagLine = sourceCode.slice(0, tag.index).split('\n').length;

    if (/\bpadding=/.test(attrs)) {
      issues.push({
        tier: 0, result: 'fail', category: 'types', subcategory: 'stack-row-padding',
        description: `<${tagName}> does not accept a 'padding' prop`,
        fix: `Wrap the children in <Box padding="..."> or use the parent <Card padding="...">`,
        line: tagLine,
      });
    }
    const alignAttr = attrs.match(/\balign=["']([^"']+)["']/);
    if (alignAttr && !ALIGN_VALUES.has(alignAttr[1])) {
      issues.push({
        tier: 0, result: 'fail', category: 'types', subcategory: 'stack-row-align',
        description: `align="${alignAttr[1]}" is invalid on <${tagName}>`,
        fix: `Use align="start" | "center" | "end" | "stretch" (NOT flex-start/flex-end/space-between)`,
        line: tagLine,
      });
    }
    const justifyAttr = attrs.match(/\bjustify=["']([^"']+)["']/);
    if (justifyAttr && !JUSTIFY_VALUES.has(justifyAttr[1])) {
      issues.push({
        tier: 0, result: 'fail', category: 'types', subcategory: 'stack-row-justify',
        description: `justify="${justifyAttr[1]}" is invalid on <${tagName}>`,
        fix: `Use justify="start" | "center" | "end" | "between" | "around" | "evenly"`,
        line: tagLine,
      });
    }
  }

  // ── Missing Props interface ───────────────────────────────
  if (!sourceCode.includes('interface Props') && !sourceCode.includes('type Props')) {
    issues.push({
      tier: 0,
      result: 'fail',
      category: 'types',
      subcategory: 'props-interface',
      severity: 'critical',
      description: 'No Props interface found — data is likely hardcoded',
      fix: 'Add interface Props { ... } with typed fields and default values in the function signature',
    });
  }

  // ── Missing default export ────────────────────────────────
  if (!sourceCode.includes('export default function')) {
    issues.push({
      tier: 0,
      result: 'fail',
      category: 'compile',
      subcategory: 'default-export',
      severity: 'critical',
      description: 'Missing default export function',
      fix: 'Add export default function Component(props: Props) { ... }',
    });
  }

  // (Controller-View checks removed — generated components use a
  // single-function pattern.)

  // ── Contract validation ───────────────────────────────────
  if (contract) {
    try {
      const contractIssues: ContractIssue[] = validateAllContracts(sourceCode, contract);
      for (const ci of contractIssues) {
        issues.push({
          tier: 0,
          result: ci.severity === 'error' ? 'fail' as const : 'warn' as const,
          category: 'contract' as const,
          subcategory: ci.field,
          severity: ci.severity === 'error' ? 'critical' as const : 'major' as const,
          description: ci.message,
          fix: ci.fix,
        });
      }
    } catch {
      // Contract validation may fail on malformed code — non-blocking
    }

    // ── Wire hook usage — every contract hook must be used in the component body ──
    //
    // `actionSpec` / `streamSpec` are flat `Record<name, Entry>` maps.
    // See `@ggui-ai/protocol` DataContract.
    const fnBody = sourceCode.slice(sourceCode.indexOf('export default function'));
    if (contract.actionSpec) {
      for (const actionName of Object.keys(contract.actionSpec)) {
        if (!fnBody.includes(actionName)) {
          issues.push({
            tier: 0, result: 'warn', category: 'contract', subcategory: `action:${actionName}`,
            description: `Action hook '${actionName}' from contract is declared but never used in the component`,
            fix: `Wire ${actionName}() to a Button onClick, form onSubmit, or other user interaction`,
          });
        }
      }
    }
    if (contract.streamSpec) {
      for (const channelName of Object.keys(contract.streamSpec)) {
        if (!fnBody.includes(channelName)) {
          issues.push({
            tier: 0, result: 'warn', category: 'contract', subcategory: `stream:${channelName}`,
            description: `Stream hook '${channelName}' from contract is declared but never rendered in the component`,
            fix: `GguiSession ${channelName}.latest data in the JSX (with null guard: ${channelName}.latest && ...)`,
          });
        }
      }
    }
    // agentCapabilities.tools is intentionally NOT checked here — it
    // is a catalog the AGENT invokes, not a component hook surface.
    // Cross-refs surface via actionSpec[*].nextStep and
    // streamSpec[*].source.tool, which the action/stream loops above
    // already cover.
    if (contract.clientCapabilities) {
      // Iterate the flattened `GadgetUse[]` — the export name
      // (`use.name`) is the identity the generated code references.
      for (const use of listContractGadgets(contract)) {
        if (!fnBody.includes(use.name)) {
          issues.push({
            tier: 0, result: 'warn', category: 'contract', subcategory: `clientCapability:${use.name}`,
            description: `Client capability '${use.name}' from contract is declared but the export is never used`,
            fix: HOOK_NAME_RE.test(use.name)
              ? `Import \`${use.name}\` from \`${use.package}\` and call it inside the component — bind the return value and surface its \`.value\` / \`.status\` in JSX.`
              : `Import \`${use.name}\` from \`${use.package}\` and render it as a JSX element (\`<${use.name} … />\`).`,
          });
        }
      }
    }

    // ── Wire preservation ─────────────────────────────────────────────────
    // The substring checks above (`fnBody.includes(name)`) are permissive —
    // they pass if the name appears ANYWHERE in the function body, including
    // a comment or unrelated identifier. The AST-backed `checkWirePreservation`
    // is the strict seal: it verifies that the boilerplate-emitted
    // `useAction('<name>')` / `useStream('<name>')` / `useGguiContext('<name>')`
    // hook call ACTUALLY exists, keyed on the string-literal first argument.
    //
    // Catches the abandonment/deletion case: LLM's apply_changes drops the
    // hook call entirely, so the wire never fires at runtime. `pnpm
    // typecheck` can't catch this (a missing call is a missing side effect,
    // not a type error). Seal B fires as `fail` — deterministic, retriable
    // feedback.
    //
    // The runtime auto-commit path (`coding-agent/tools.ts::autoCommit`)
    // calls `runTier0Checks`, which is where this rule lives so it
    // fires on the live generation path.
    try {
      const report = checkWirePreservation(sourceCode, contract);
      for (const site of report.missing) {
        const hook = HOOK_NAME_FOR[site.kind];
        const fix =
          site.kind === 'context'
            ? `Restore \`const [${site.name}, set${site.name.charAt(0).toUpperCase() + site.name.slice(1)}] = ${hook}('${site.name}')\` ` +
              `at the top of the component body. The boilerplate auto-emits this destructure for every declared ` +
              `contextSpec slot — do not delete it.`
            : `Restore \`const ${site.name} = ${hook}('${site.name}')\` at the top of the ` +
              `component body and consume the returned binding (in JSX, a callback, or an effect).`;
        issues.push({
          tier: 0,
          result: 'fail',
          category: 'contract',
          subcategory: `wire_preservation:${site.kind}:${site.name}`,
          severity: 'critical',
          description:
            `Contract declares ${site.kind} '${site.name}' but no ${hook}('${site.name}') ` +
            `call exists in the component. The boilerplate placed this hook for you — ` +
            `do not delete it.`,
          fix,
        });
      }
    } catch {
      // Malformed code surfaces as a primary error elsewhere — don't mask
      // it with a wire-preservation noise-violation here.
    }

    // ── Props field rendering — verify each prop is actually used in the component ──
    if (contract.propsSpec) {
      const propsProperties = contract.propsSpec.properties ?? {};
      for (const propName of Object.keys(propsProperties)) {
        // Check if prop is referenced in the function body (via props.fieldName)
        if (!fnBody.includes(`props.${propName}`) && !fnBody.includes(`{props.${propName}}`)) {
          issues.push({
            tier: 0, result: 'warn', category: 'contract', subcategory: `prop:${propName}`,
            description: `Props field '${propName}' from contract is never rendered — data is wasted`,
            fix: `GguiSession props.${propName} in the JSX (e.g., <Text>{props.${propName}}</Text>)`,
          });
        }
      }
    }
  }

  // ── Wire_undeclared (UNCONDITIONAL) ──────────────────────────────────
  //
  // Every wire-call site in the emitted code MUST correspond to a
  // declared entry on the agent-authored `contract`, regardless of
  // whether the contract is partially or wholly absent. Empty contract
  // → ALL wire calls are "extra" → all fail with `wire_undeclared`.
  // Failure mode this guards against: agent describes contextSpec in
  // plain prompt text but doesn't author `contract`; the LLM emits
  // `useGguiContext('foo')` / `useAction('foo')` with no slot
  // registration; the iframe crashes at first paint with
  // `[ggui] useGguiContext('foo'): no Context registered`. The
  // remediation message names the exact contract field to declare on,
  // so the agent's next turn can fix structurally.
  try {
    const contractsForExtraCheck: DataContract = contract ?? {};
    const extras = checkWirePreservation(sourceCode, contractsForExtraCheck).extra;
    for (const site of extras) {
      const hook = HOOK_NAME_FOR[site.kind];
      const field = CONTRACT_FIELD_FOR[site.kind];
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'contract',
        subcategory: `wire_undeclared:${site.kind}:${site.name}`,
        severity: 'critical',
        description:
          `Component calls ${hook}('${site.name}') but the contract does not declare ` +
          `${site.kind} '${site.name}'. Every wire reference in the generated code MUST ` +
          `correspond to a declared entry on the agent-authored contract — the runtime ` +
          `mounts/registers wire surfaces from the contract, not from the code. ` +
          (contract === undefined
            ? 'No contract authored at all — describing the contract in the prompt text is NOT enough; ' +
              'the agent MUST pass a structured `contract` field on the ggui_render call.'
            : ''),
        fix:
          `Either (a) declare \`${field}.${site.name}\` on the \`contract\` input so the ` +
          `runtime registers the surface for this UI, or (b) remove the ${hook}('${site.name}') ` +
          `call from the component if it isn't part of the intended wire surface.`,
      });
    }
  } catch {
    // Malformed code surfaces elsewhere; don't mask with noise.
  }

  // ── Wire-hook import presence ────────────────────────────────────────
  //
  // `rewriteImports` (packages/design/src/rendering/rewrite-imports.ts) only
  // substitutes `from '@ggui-ai/wire'` specifiers that already exist in the
  // compiled code; a hook call like `useAction('X')` without the paired
  // `import { useAction } from '@ggui-ai/wire'` line leaves no specifier
  // for the shim to attach, so the hook is undeclared at eval time and the
  // browser throws `ReferenceError: useAction is not defined`. This check
  // runs unconditionally (no contract needed) — for every wire hook the
  // component CALLS at least once, the matching named import must be
  // present at top level. Independent of `wire_preservation` which checks
  // that contract-declared hooks are called.
  try {
    const importReport = checkWireImports(sourceCode);
    for (const miss of importReport.missing) {
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'imports',
        subcategory: `wire_import_missing:${miss.hook}`,
        severity: 'critical',
        description:
          `Component calls ${miss.hook}(...) but does not import it from ` +
          `'@ggui-ai/wire'. Without the import, rewriteImports has no ` +
          `specifier to attach the data-URL shim to, so the hook is ` +
          `undeclared at browser eval time and the component crashes on ` +
          `mount with \`ReferenceError: ${miss.hook} is not defined\`.`,
        fix:
          `Add \`import { ${miss.hook} } from '@ggui-ai/wire';\` at the ` +
          `top of the file alongside the other imports.`,
      });
    }
  } catch {
    // Malformed code surfaces as a primary error elsewhere — don't mask it.
  }

  // ── No-require pattern for @-scoped packages ─────────────────────────
  //
  // A repeating LLM failure mode: when the boilerplate emits a static
  // `import { useLeafletMap } from '@ggui-samples/gadget-leaflet'`, the
  // model sometimes removes the import and substitutes
  // `const { useLeafletMap } = require('@ggui-samples/gadget-leaflet')`
  // (or `require('@ggui-ai/gadgets')`) inline. That FAILS in a real
  // browser ESM iframe: `require` is not defined, and `rewriteImports`
  // never sees a static `from '<pkg>'` specifier to attach the data-URL
  // shim to.
  //
  // This check rejects any `require('@...')` call expression on an
  // @-scoped package. The fix is always the same — convert to a
  // top-level static `import { … } from '<pkg>'`. Targeted at @-scoped
  // packages because that's the LLM's typical hedge specifier shape
  // (CJS bare `require('react')` etc. don't appear in our generated
  // code path).
  {
    // Match `require('@scope/pkg')` and `require("@scope/pkg")` with a
    // simple regex. The LLM only emits this pattern as call
    // expressions, so the false-positive rate is negligible in
    // practice; an AST walk would be more rigorous but unnecessary.
    const requireRe = /require\s*\(\s*['"](@[^'"]+)['"]\s*\)/g;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = requireRe.exec(sourceCode)) !== null) {
      const pkg = m[1];
      if (pkg === undefined || seen.has(pkg)) continue;
      seen.add(pkg);
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'imports',
        subcategory: `require_disallowed:${pkg}`,
        severity: 'critical',
        description:
          `Component uses \`require('${pkg}')\` — CommonJS require is ` +
          `not available in the iframe's browser ESM runtime, and the ` +
          `import-rewriter only attaches data-URL shims to STATIC import ` +
          `specifiers. The component will fail to mount with ` +
          `\`ReferenceError: require is not defined\` at the first call.`,
        fix:
          `Replace with a top-level static \`import { … } from '${pkg}'\` ` +
          `at the top of the file. The boilerplate emits this import for ` +
          `you when the contract declares a matching ` +
          `\`clientCapabilities.gadgets[*]\` entry — restore the line ` +
          `instead of inlining a require() call.`,
      });
    }
  }

  // ── gadget import preservation ───────────────────────────────────────
  //
  // Gadgets are DIRECT-imported. The boilerplate emits, per
  // registered gadget package, one combined import:
  //   `import { useLeafletMap } from '@scope/leaflet';`
  // The LLM (correctly) intuits the hook is runtime-resolved and tends
  // to delete the import — but the import IS the resolution anchor: the
  // iframe rewriter rewrites the package specifier to a per-package
  // shim, and without the import the hook is unbound (ReferenceError).
  //
  // This check verifies, for every contract-declared gadget export,
  // that it is still imported from its package. The export NAME
  // appearing alone is not enough — the `import { … }` statement must
  // carry it. Hooks AND components are both direct-imported and
  // both checked here; the fix hint adapts to the export kind (hooks
  // are CALLED, components are RENDERED as JSX).
  {
    // Scan comment-free source — a commented-out import must NOT
    // satisfy the preservation check.
    const gadgetScanSource = stripComments(sourceCode);
    // Iterate the flattened `GadgetUse[]`. Kind is discriminated
    // by the export-name grammar — `use`-prefixed → hook, else component.
    for (const use of contract ? listContractGadgets(contract) : []) {
      const exportName = use.name;
      if (isGadgetExportImported(gadgetScanSource, use.package, exportName)) {
        continue;
      }
      const isComponent = !HOOK_NAME_RE.test(exportName);
      const kind = isComponent ? 'component' : 'hook';
      // Local binding name for the hook worked example (mirrors the
      // boilerplate's derivation: strip `use`, lowercase first char).
      const bindingName =
        exportName.length > 3
          ? exportName.charAt(3).toLowerCase() + exportName.slice(4)
          : exportName;
      const fix = isComponent
        ? `The component \`${exportName}\` is REAL and CORRECT — do NOT remove it. ` +
          `Restore the gadget plumbing in 2 steps:\n` +
          `(1) Keep \`import { ${exportName} } from '${use.package}';\` at the top of the file.\n` +
          `(2) RENDER \`<${exportName} … />\` as a JSX element in the tree you return — pass its props from the contract. Do NOT call it like a hook.\n` +
          `Import \`${exportName}\` ONLY from '${use.package}' — that is the package it is registered under. If you remove the import again, this check will fail again — \`${exportName}\` is not optional.`
        : `The hook \`${exportName}\` is REAL and CORRECT — do NOT remove it. ` +
          `Restore the gadget plumbing in 2 steps:\n` +
          `(1) Keep \`import { ${exportName} } from '${use.package}';\` at the top of the file.\n` +
          `(2) CALL \`${exportName}(...)\` inside the component body and render its return value. Example:\n` +
          `    \`const ${bindingName} = ${exportName}({ /* props from contract */ });\`\n` +
          `    \`return <div>{/* render ${bindingName} */}</div>;\`\n` +
          `Import \`${exportName}\` ONLY from '${use.package}' — that is the package it is registered under. If you remove the import again, this check will fail again — \`${exportName}\` is not optional.`;
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'imports',
        subcategory: `gadget_preservation:${exportName}`,
        severity: 'critical',
        description:
          `Contract declares \`clientCapabilities.gadgets['${use.package}']['${exportName}']\` ` +
          `(a ${kind}) but the ` +
          `component does not import \`${exportName}\` from \`${use.package}\`. ` +
          `The boilerplate emits \`import { ${exportName} } from '${use.package}';\` ` +
          `— keep it. Without the import the iframe runtime cannot resolve the ` +
          `${kind} and the registered gadget is unreachable.`,
        fix,
      });
    }
  }

  // ── TypeScript type checking + React hooks linting ──────────
  const [typeResult, reactResult] = await Promise.all([
    typecheck(sourceCode, gadgetTypes).catch((err) => {
      console.warn('[runTier0Checks] TypeChecker failed:', err instanceof Error ? err.message : String(err));
      return null;
    }),
    lintReactHooks(sourceCode).catch((err) => {
      console.warn('[runTier0Checks] React linter failed:', err instanceof Error ? err.message : String(err));
      return [] as ReactLintDiagnostic[];
    }),
  ]);

  // TS type errors → fail, warnings → warn
  if (typeResult) {
    for (const error of typeResult.errors) {
      issues.push({
        tier: 0,
        result: 'fail',
        category: 'types',
        subcategory: `ts${error.code}`,
        description: error.message,
        fix: error.fix,
        line: error.line,
      });
    }
    for (const warning of typeResult.warnings) {
      issues.push({
        tier: 0,
        result: 'warn',
        category: 'types',
        subcategory: `ts${warning.code}`,
        description: warning.message,
        fix: warning.fix,
        line: warning.line,
      });
    }
  }

  // React hooks violations — errors → fail, warnings → warn
  for (const diag of reactResult) {
    issues.push({
      tier: 0,
      result: diag.severity === 'error' ? 'fail' : 'warn',
      category: 'types',
      subcategory: diag.rule,
      description: diag.message,
      fix: diag.fix,
      line: diag.line,
    });
  }

  // Populate priority on every tier-0 issue. No current code path reads
  // `.priority` — it is reserved for future eval-policy consumption.
  for (const issue of issues) {
    if (!issue.priority) issue.priority = priorityForIssue(issue.category);
  }

  return issues;
}

/**
 * Run tier 0 checks and return a full EvalResult with pass list.
 */
export async function runTier0(
  sourceCode: string,
  compiledCode: string | null,
  contract?: DataContract,
): Promise<EvalResult> {
  const issues = await runTier0Checks(sourceCode, compiledCode, contract);
  const pass: string[] = [];

  // Build pass list from categories that had no issues
  const failedCategories = new Set(issues.map(i => i.category));
  const tier0Categories: EvalCategory[] = ['compile', 'security', 'contract', 'types', 'imports', 'tokens'];

  for (const cat of tier0Categories) {
    if (!failedCategories.has(cat)) {
      pass.push(cat);
    }
  }

  return { issues, pass };
}

// Tier-0 deterministic checks are run above. Axis-gated mode checks are
// dispatched from `evaluation/axis-checks/` — see `runAxisChecks`.
