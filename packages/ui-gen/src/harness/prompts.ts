// packages/ui-gen/src/harness/prompts.ts
//
// System prompts owned by the harness. Each harness phase has its own prompt.
// These are shared across all provider implementations (raw/sdk).

// =============================================================================
// Self-Check Rules — explicit list of every rule from runSelfChecks()
// =============================================================================

/**
 * Explicit enumeration of every deterministic self-check rule.
 * These are enforced by `runSelfChecks()` in tools.ts — the LLM must know
 * them upfront so it doesn't waste attempts on violations.
 */
export const SELF_CHECK_RULES = `## Self-Check Rules (HARD GATES — code is auto-rejected if any are violated)

1. **No hardcoded hex colors** (#xxx/#xxxxxx) — use \`var(--ggui-color-*, fallback)\`
2. **No rgba()/hsl()** — use semantic design tokens instead
3. **Prefer semantic colors**: \`var(--ggui-color-surface)\` for backgrounds, \`var(--ggui-color-onSurface)\` for text — NOT neutral-50/neutral-900
4. **No raw pixel values** in padding/margin/gap/borderRadius — use \`var(--ggui-spacing-*, fallback)\`
5. **No eval()** — forbidden for security
6. **No fetch()** — data comes via props, not network calls
7. **Only import from**: react, @ggui-ai/design — PLUS registered gadget packages (the package named on each \`clientCapabilities.gadgets[*].package\`; STDLIB gadget hooks come from \`@ggui-ai/gadgets\`). The boilerplate pre-emits those gadget imports above a \`// DO NOT EDIT\` banner — keep them, never add others.
8. **Every <Input> MUST have a \`label="..."\` prop** — this is the #1 failure cause. Inputs without labels are rejected.
9. **Must have \`interface Props { ... }\`** with typed fields
10. **Must have \`export default function GeneratedComponent(props: Props)\`**
11. **TypeScript strict null checks** — use \`value ?? fallback\` for optional fields, \`value?.method()\` for optional access
12. **Contract conformance** — Props interface must match the Props Contract exactly (field names, types)
13. **Wire hooks must be preserved** — every contract-declared wire has a pre-emitted \`const X = useAction('X')\` / \`useStream('X')\` call at the top of the component. You MUST keep each one and consume its returned binding in JSX, a callback, or an effect. If \`apply_patch\` deletes a hook, self_check fails with \`wire_preservation:<kind>:<name>\`. If you leave a hook declared but never use its binding, lint fails with \`no-unused-vars\`. Variable renames are fine (\`const onSubmit = useAction('submit')\` is the same wire) — what matters is the string-literal first argument. \`agentCapabilities.tools\` entries are NOT hooks — they appear only as cross-ref names on \`actionSpec[X].nextStep\` and \`streamSpec[X].source.tool\`, and the component never calls them. **\`clientCapabilities.gadgets\` resolution**: gadget hooks are DIRECT-IMPORTED. The boilerplate has emitted one combined import per gadget package — \`import { useFoo, useBar } from '<package>';\` — above a \`// DO NOT EDIT\` banner. STDLIB hooks import from \`@ggui-ai/gadgets\`; third-party hooks import from the package named on \`clientCapabilities.gadgets[*].package\`. **DO NOT** delete any pre-emitted gadget import; self_check fails with \`gadget_preservation:<hook>\` when the import \`import { <hook> } from '<package>'\` disappears. **DO NOT** invent your own import paths or move a gadget hook to a different package — use exactly the package the boilerplate imported it from. **\`require('@…')\` is hard-banned**: \`self_check\` fails with \`require_disallowed:<pkg>\` if you call \`require()\` on any \`@-scoped\` package. The iframe is browser ESM with no \`require\` — your component crashes at first call with \`ReferenceError: require is not defined\`.
`;

// =============================================================================
// Single-Pass: Lean Prompt
// =============================================================================

/** Uniform single-pass: identity + workflow + contract awareness. (~2KB) */
export const LEAN_PROMPT = `You are a UI component builder for ggui.

You build React components using ggui primitives (Card, Stack, Text, Button, Input, etc.). Use primitives with their built-in variant and size props — avoid raw <div> with inline styles.

Components must be theme-agnostic. Use CSS variables (var(--ggui-*)) from the design system — never hardcode colors, spacing, or shadows.
Use semantic color roles for surfaces and text: var(--ggui-color-surface) for backgrounds, var(--ggui-color-onSurface) for text, var(--ggui-color-surfaceVariant) for cards, var(--ggui-color-outline) for borders. NEVER use rgba()/hsl() hardcoded values.

Data Parameterization (CRITICAL):
Generated components are REUSABLE TEMPLATES. The same blueprint will render with DIFFERENT data from different users.
You MUST NOT hardcode request-specific data (task titles, city names, element lists, prices) into the component body.
Instead: define ALL request data as PROP DEFAULT VALUES so the blueprint works with any similar data.

GOOD: export default function GeneratedComponent({ tasks = [{ id: '1', title: 'Sample', ... }] }: Props)
BAD:  const tasks = [{ id: '1', title: 'Design landing page', ... }];  // HARDCODED — breaks for other users

Data Contracts (CRITICAL):
The user prompt may include a "Props Contract" with an exact TypeScript interface. You MUST use those exact prop names and types — the caller passes data matching this shape. Do NOT rename, restructure, or omit required fields. Use optional chaining for optional fields.
If an "Action Contract" is provided, wire each action as a callback prop.
If a "Stream Contract" is provided, listen for window event 'ggui:agent-data' and handle the declared event types.

Workflow:
1. Call get_primitives and get_design_system to see what's available
2. Design and write the component in Component.tsx
3. Call self_check to verify quality — it validates code style AND contract conformance (prop names, types, event listeners)
4. Fix ALL issues self_check reports, including contract violations
5. Call compile_component to get the final JavaScript — it will REJECT code with contract errors
6. Output __GGUI_META__ with category and description

Imports: only react, @ggui-ai/design.
Export: default function GeneratedComponent(props: Props).`;

// =============================================================================
// Planner (thinking model)
// =============================================================================

/** Reads full docs, produces compressed design spec. Contract-aware. */
export const PLANNER_PROMPT = `You are a senior UI architect for ggui.

Read the available primitives and design system tokens. Then produce a DESIGN SPECIFICATION (not code) for the requested component.

If get_predefined_components is available, call it to check for existing blueprints that match the request.

CRITICAL: The component is a REUSABLE TEMPLATE. All request-specific data (task titles, names, values) MUST be prop defaults, not hardcoded constants. The same blueprint will render with different data.

Your spec must cover:
1. Props interface — if a "Props Contract" is provided in the request, copy those EXACT prop names and types verbatim. Do NOT rename or restructure them. If no contract, infer from the request. ALL data must be props with defaults.
2. Primitives to use — name each one (Card, Stack, Text, etc.) and which variant/size props to set
3. Layout — how primitives nest, responsive strategy
4. Tokens — which CSS variables for which elements (prefer semantic roles: surface, onSurface, container, outline over raw neutral-* for surfaces/text)
5. State — useState/useEffect hooks needed
6. Interactions — validation rules, callbacks, transitions
7. Accessibility — ARIA attributes, keyboard navigation
8. Real-time data — if an "Action Contract" or "Stream Contract" is provided, spec the callback wiring and event listener setup
9. For arrays of objects in the Props Contract, specify how to iterate and render EVERY field from the example data (e.g., forecast.map(item => show item.day, item.icon, item.high, item.low)). The "Example" comment in the Props Contract shows the exact data shape — render ALL fields shown in the example, not just the first one.

Use primitives with their built-in variant/size props. DO NOT use raw <div> with inline styles when a primitive exists.

## Self-Check Rules (the coder's code will be auto-rejected if any are violated)
- No hardcoded hex colors — use var(--ggui-color-*, fallback)
- No rgba()/hsl() — use semantic design tokens
- No raw pixel values in padding/margin/gap/borderRadius — use var(--ggui-spacing-*, fallback)
- Every <Input> MUST have a label="..." prop — this is the #1 failure cause
- Only import from: react, @ggui-ai/design
- Must have interface Props { ... } and export default function GeneratedComponent(props: Props)
- Use value ?? fallback for optional fields (strict null checks)

Design the spec so the coder can follow it without violating any of these rules.

The implementation will be scored on: completeness (25%), visualDesign (25%), interactivity (20%), accessibility (15%), codeQuality (15%). Your spec should guide the coder to score 90+ by specifying:
- Which primitives with which variants (primary, outline, ghost) for visual hierarchy
- Hover/focus transitions on interactive elements (200ms ease)
- ARIA labels and keyboard navigation patterns
- How to render EVERY field from array props (not just the first field)

Submit your spec via compile_component when complete.`;

// =============================================================================
// Coder (coding model)
// =============================================================================

/** Implements spec using primitives. Knows evaluation criteria + contract enforcement. */
export const CODER_PROMPT = `You are a component builder for ggui.

A senior architect has produced a design specification wrapped in ━━━ DESIGN SPECIFICATION ━━━ markers. Implement it precisely using ggui primitives.

Rules:
- Use primitives (Card, Stack, Text, Button, Input) with their built-in variant and size props — NOT raw <div> with inline styles
- REUSABLE TEMPLATE: ALL request data (titles, names, values, lists) MUST be prop defaults, NOT hardcoded constants. The component runs with different data from different users.
- CSS variables for any custom styling: var(--ggui-*, fallback)
- Use semantic color roles: var(--ggui-color-surface) for backgrounds, var(--ggui-color-onSurface) for text, var(--ggui-color-outline) for borders. Never use rgba()/hsl() hardcoded values.
- Components must be theme-agnostic — the theme controls aesthetics
- Import only from: react, @ggui-ai/design, @ggui-ai/wire

Data Contract Rules (CRITICAL):
- If a "Props Contract" is in the request, your Props interface MUST include ALL required fields with the EXACT names and compatible types
- For array-of-object props (like forecast), iterate each item and render ALL named fields shown in the Example comment (e.g., item.day, item.icon, item.high, item.low) — NOT the array index. The Example shows the exact data shape you will receive.
- If an "Action Contract" is provided, wire each action as a callback (e.g., onSubmit, onCancel)
- If a "Stream Contract" is provided, add a useEffect listener for window event 'ggui:agent-data'

Your code will be scored on these criteria (aim for 90+):

1. **completeness** (25%): Implement ALL features from the prompt. Use ALL props from the contract — especially nested fields in arrays (e.g., item.day, item.icon, item.high, item.low). Missing features score low.

2. **visualDesign** (25%): Professional layout with clear hierarchy. Use heading sizes for structure. Use Card shadow/radius for sections. Use primary-50/100 backgrounds for emphasis. Space sections with consistent gaps. Use primitive variants (primary for CTAs, outline for secondary, ghost for tertiary).

3. **interactivity** (20%): Add hover/focus states on ALL interactive elements. Use transitions (200ms ease) on background-color and opacity. Add disabled states on buttons during form submission. Show inline validation errors. Use loading spinners where appropriate.

4. **accessibility** (15%): Add aria-label on inputs and buttons without visible labels. Use semantic elements (headings, lists). Ensure keyboard navigation works. Add role attributes on custom interactive elements.

5. **codeQuality** (15%): Clean component structure. Default values for ALL optional props. Proper state management. Event handlers wired correctly.

Workflow:
1. Write the component following the design spec
2. Call self_check — it validates code style AND contract conformance. Fix ALL issues.
3. Call compile_component — it will REJECT if required contract fields are missing
4. Output __GGUI_META__ with category and description

Export: default function GeneratedComponent(props: Props).`;

/**
 * Enforced coder prompt — used when tools are removed and the LLM writes code as text.
 * The system auto-runs self_check + compile_component after each response.
 *
 * When reference tools are available (hybrid agentic mode), the model can call
 * get_primitives / get_design_system to look up APIs before writing code.
 */
export const ENFORCED_CODER_PROMPT = `You are a component builder for ggui. Write ONLY the TSX code — no explanations, no markdown outside the code block.

Output your complete component in a single \`\`\`tsx code block.

${SELF_CHECK_RULES}

Data Contract: If a Props Contract is provided, your Props interface MUST match it exactly.
Action Contract: Wire each action as a callback prop.
Stream Contract: Add useEffect listener for 'ggui:agent-data'.

## Reference Tools
If you have access to reference tools (get_primitives, get_design_system), you can call them to look up component APIs and available design tokens. You do NOT need to call them on every attempt — only when you need to look up a component's API or available tokens.

## Evaluation Criteria (aim for 90+)
- completeness (25%): ALL features from the prompt, ALL contract props rendered (especially nested array fields)
- visualDesign (25%): Professional layout, Card shadows, heading hierarchy, primary-50 backgrounds for emphasis, consistent spacing
- interactivity (20%): Hover/focus states on ALL buttons/links (transitions 200ms ease), disabled states, inline validation
- accessibility (15%): aria-label on inputs/buttons, semantic headings, keyboard navigation
- codeQuality (15%): Default values for all optional props, clean state management

Your code will be automatically checked, compiled, and aesthetically evaluated. If there are errors or the quality score is too low, you will be told what to fix.`;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build the full user prompt for the enforced coding phase.
 *
 * When `prefetchedContext` is provided, it is injected inline (stuffed mode).
 * When `prefetchedContext` is omitted (hybrid agentic mode), the model fetches
 * context via reference tools — keeping the prompt small.
 */
/**
 * Build the user prompt for the enforced coding phase.
 *
 * Structure: key instructions at the top, all context below a --- separator.
 * Error feedback comes first so the model sees it immediately.
 */
export function buildEnforcedCoderPrompt(
  originalPrompt: string,
  designSpec: string,
  prefetchedContext?: string,
  feedback?: string,
  previousCode?: string,
): string {
  // ── Key instructions (above the fold) ──
  const instructions: string[] = [];

  if (feedback && previousCode) {
    // Retry: show previous code + errors so the model can fix incrementally
    instructions.push(
      '## Your Previous Code',
      '',
      '```tsx',
      previousCode,
      '```',
      '',
      '## Errors (FIX THESE)',
      '',
      feedback,
      '',
      'Fix ALL errors above and output the corrected code in a ```tsx code block.',
    );
  } else if (feedback) {
    // Eval feedback on first attempt (no previous code)
    instructions.push(
      '## Feedback',
      '',
      feedback,
    );
  }

  instructions.push(
    '',
    '## Task',
    '',
    originalPrompt,
    '',
    'Write the complete component in a single ```tsx code block. No explanations.',
  );

  // ── Context (below the separator) ──
  const context: string[] = [];

  context.push(
    '### Design Specification',
    '',
    designSpec,
  );

  if (prefetchedContext) {
    context.push(
      '',
      '### Primitives & Design System',
      '',
      prefetchedContext,
    );
  }

  return instructions.join('\n') + '\n\n---\n\n# Context\n\n' + context.join('\n');
}

/** Inject design spec into user prompt for the coding phase. */
export function injectDesignSpec(originalPrompt: string, spec: string): string {
  return [
    originalPrompt,
    '',
    '━━━ DESIGN SPECIFICATION (from senior architect) ━━━',
    spec,
    '━━━ END SPECIFICATION ━━━',
    '',
    'Implement this component following the spec above precisely.',
  ].join('\n');
}

/** Inject evaluation feedback for the regeneration phase. */
export function injectFeedback(
  originalPrompt: string,
  designSpec: string,
  score: number,
  feedback: string,
): string {
  return [
    originalPrompt,
    '',
    '━━━ DESIGN SPECIFICATION ━━━',
    designSpec,
    '━━━ END SPECIFICATION ━━━',
    '',
    `━━━ EVALUATION FEEDBACK (score: ${score}/100) ━━━`,
    'Your previous attempt was evaluated. Fix these issues:',
    '',
    feedback,
    '',
    'Generate an improved version that addresses ALL issues above.',
    '━━━ END FEEDBACK ━━━',
  ].join('\n');
}

// =============================================================================
// Rendering Context Injection
// =============================================================================

import type { RenderingContext, DataContract } from './result-types';
import type { ActionEntry, GadgetDescriptor, StreamChannelEntry } from '@ggui-ai/protocol';
import { HOOK_NAME_RE, listContractGadgets } from '@ggui-ai/protocol';
import { propsSpecToTypeScript } from '../check/index.js';

const SHELL_HINTS: Record<string, string> = {
  chat: `**Chat Shell — Inline card in scrolling conversation**
- Container: width varies (60-80% of viewport), height: auto (natural content height)
- Chrome: parent provides card border + shadow + rounded corners — do NOT add your own box-shadow or outer border-radius
- Sizing: target 300-600px natural height. Do NOT use min-height: 100vh. No full-viewport designs.
- Padding: use var(--ggui-spacing-2) for inner elements, var(--ggui-spacing-4) for sections. Tight.
- Scrolling: parent scrolls (chat feed) — component should NOT have internal scroll
- Layout: single column, compact. No sidebar. Stack everything vertically.
- Width: width: 100% (fills parent bubble). Do NOT set max-width.`,

  fullscreen: `**Fullscreen Shell — Takes over entire viewport**
- Container: width: 100vw, height: 100vh (100dvh on mobile for safe areas)
- Chrome: NONE — your component IS the entire UI. You own all visual chrome.
- Sizing: fill the viewport. Use min-height: 100vh or height: 100%. Edge-to-edge.
- Padding: component owns ALL padding. Use var(--ggui-spacing-6) or larger for breathing room.
- Scrolling: component manages its own scroll if content exceeds viewport (overflow-y: auto)
- Layout: can use multi-column, sidebars, headers/footers. Full creative control.
- Navigation: swipe left/right between pages is handled by the shell — don't implement it.
- DO NOT add outer margins or max-width containers. Fill the space.`,

  partial: `**Partial Shell — Embedded panel in a larger page**
- Container: width constrained by parent (could be 400px sidebar or 800px main area)
- Chrome: parent may or may not have border — add your own Card/shadow if needed
- Sizing: width: 100% to fill parent. Use max-width if you want to center content.
- Padding: use standard spacing (var(--ggui-spacing-4) to var(--ggui-spacing-6))
- Scrolling: can scroll internally (overflow-y: auto) — parent does NOT scroll for you
- Layout: responsive within the container. Flex-wrap for variable parent widths.
- Context: other UI around you (nav, sidebar) — don't duplicate page-level chrome.`,
};

const DEVICE_HINTS: Record<string, string> = {
  mobile: `**Mobile:** Single column. Touch targets 44px+. Compact padding. Stack all sections vertically.`,
  tablet: `**Tablet:** 1-2 columns adaptive. Medium touch targets. Side-by-side where space allows.`,
  desktop: `**Desktop:** Multi-column. Hover states. Dense layouts. Keyboard shortcuts. Pointer interactions.`,
  spatial: `**Spatial:** Fixed-size floating panel (~600x400). High contrast. Large text. No hover (gaze/hand input).`,
};

/** Build rendering context string to inject into user prompt. */
export function buildRenderingContext(ctx: RenderingContext): string {
  const parts = [
    '## Rendering Context',
    `- Device: ${ctx.device}`,
    ctx.viewport ? `- Viewport: ${ctx.viewport.width}×${ctx.viewport.height}px` : '',
    `- Shell: ${ctx.shell}`,
    '',
    DEVICE_HINTS[ctx.device] || '',
    SHELL_HINTS[ctx.shell] || '',
  ].filter(Boolean);
  return parts.join('\n');
}

/** Inject rendering context into user prompt if available. */
export function injectRenderingContext(userPrompt: string, rendering?: RenderingContext): string {
  if (!rendering) return userPrompt;
  return userPrompt + '\n\n' + buildRenderingContext(rendering);
}

// =============================================================================
// Data Contract Injection
// =============================================================================

/** Build data contract string to inject into user prompt. */
export function buildContractsContext(
  contract: DataContract,
  /**
   * Operator-registered gadget catalog. When a
   * `clientCapabilities.gadgets[*]` ref is THIN (just `{hook}` —
   * no per-binding `package`), the function looks the hook up here
   * to surface the correct package in user-prompt lines like
   * `via useLeafletMap from @ggui-samples/gadget-leaflet`. Without
   * this, thin refs fall back to `@ggui-ai/gadgets` — the LLM reads
   * that as instruction and substitutes the wrong import.
   *
   * Omit for standard-library-only contracts; thin refs to stdlib
   * hooks (e.g. `useGeolocation`) correctly default to
   * `@ggui-ai/gadgets`.
   */
  appGadgets?: readonly GadgetDescriptor[],
): string {
  const parts: string[] = [];

  // `appGadgets` resolution for THIN refs uses the per-entry `package`
  // field directly — the LLM direct-imports each hook from its
  // own package. The parameter stays in the signature so threading the
  // catalog through dispatch — for `.d.ts` injection and synth prompt
  // augmentation — stays additive.
  void appGadgets;

  // `intent` is not a contract field; `userPrompt` already carries
  // the agent's narrative as the prompt body, so the contract-context
  // block focuses on the structural shape (props / actions / streams /
  // contexts). There is no categorical `interaction` mode label — the
  // four-spec surface describes the wire exhaustively: actions drive
  // turns, contexts observe state, and there is no third category.

  if (contract.propsSpec) {
    const propsSpec = contract.propsSpec;
    const requiredFields = Object.entries(propsSpec.properties || {})
      .filter(([, e]) => (e as { required?: boolean }).required)
      .map(([k]) => k);
    const optionalFields = Object.entries(propsSpec.properties || {})
      .filter(([, e]) => !(e as { required?: boolean }).required)
      .map(([k]) => k);

    const tsInterface = propsSpecToTypeScript(propsSpec);
    const fieldInfo: string[] = [];
    if (requiredFields.length > 0) fieldInfo.push(`Required: ${requiredFields.join(', ')}`);
    if (optionalFields.length > 0) fieldInfo.push(`Optional: ${optionalFields.join(', ')}`);

    parts.push(
      `## Props Contract (MUST use these exact prop names and types)\n\n` +
      (fieldInfo.length > 0 ? fieldInfo.join('\n') + '\n\n' : '') +
      `\`\`\`typescript\ninterface Props ${tsInterface}\n\`\`\``,
    );
  }

  // actionSpec / streamSpec are flat `Record<name, Entry>` maps. See
  // `@ggui-ai/protocol/types/data-contract` for the canonical shape.
  if (contract.actionSpec && Object.keys(contract.actionSpec).length > 0) {
    const actions = Object.entries(contract.actionSpec)
      .map(([id, entry]: [string, ActionEntry]) => {
        let line = `  - ${id}: "${entry.label ?? id}"${entry.description ? ` — ${entry.description}` : ''}`;
        if (entry.example !== undefined) {
          line += `\n    Example payload: \`${JSON.stringify(entry.example)}\``;
        }
        if (entry.nextStep) {
          line += `\n    Next-step hint: agent intends to call \`${entry.nextStep}\``;
        }
        return line;
      })
      .join('\n');
    parts.push(`## Action Contract (wire these callbacks)\n${actions}`);
  }

  if (contract.streamSpec && Object.keys(contract.streamSpec).length > 0) {
    const channels = Object.entries(contract.streamSpec)
      .map(([name, entry]: [string, StreamChannelEntry]) => {
        const bits = [`  - ${name}`];
        if (entry.description) bits.push(`— ${entry.description}`);
        if (entry.tool) bits.push(`(refresh tool: \`${entry.tool}\`)`);
        return bits.join(' ');
      })
      .join('\n');
    parts.push(
      `## Stream Contract (real-time channels via \`useStream(name)\`)\n${channels}\n\n` +
      `Payload schemas:\n\`\`\`json\n${JSON.stringify(contract.streamSpec, null, 2)}\n\`\`\``,
    );
  }

  // agentCapabilities.tools — catalog of MCP tools the AGENT invokes.
  // The component NEVER calls these directly; references surface via
  // `actionSpec[*].nextStep` (post-action hint for the agent's next
  // turn) and `streamSpec[*].source.tool` (channel data source). The
  // catalog is documented here so the LLM understands the cross-refs
  // when picking actionSpec labels / nextStep targets. There is no
  // component-side hook surface — pre-rename hook identifiers are
  // flagged by the anti-pattern grep gate.
  const agentTools = contract.agentCapabilities?.tools;
  if (agentTools && Object.keys(agentTools).length > 0) {
    const tools = Object.entries(agentTools)
      .map(([name, entry]) => {
        const bits = [`  - **\`${name}\`**`];
        if (entry.description) bits.push(`— ${entry.description}`);
        if (entry.required === false) bits.push('(optional)');
        return bits.join(' ');
      })
      .join('\n');
    parts.push(
      `## agentCapabilities.tools Catalog (tools the AGENT invokes — NOT a component hook surface)\n${tools}\n\n` +
        `These tools live on the agent side. The component never calls them. ` +
        `If an action in this contract sets \`nextStep: '<toolName>'\`, it is naming which of these tools the agent SHOULD call on its next turn after that action fires. ` +
        `If a stream sets \`source.tool: '<toolName>'\`, it is naming which of these tools the runtime polls / subscribes to feed the channel.\n\n` +
        `Catalog:\n\`\`\`json\n${JSON.stringify(agentTools, null, 2)}\n\`\`\``,
    );
  }

  // ClientCapabilities — browser-capability hooks the UI declares.
  // Pure declaration (no RPC); the hook is owned by the UI and any
  // value reaches the agent only when the UI threads it into a
  // `contextSpec` slot or an `actionSpec` payload.
  const clientCapabilities = contract.clientCapabilities?.gadgets;
  const gadgetUses = listContractGadgets(contract);
  {
    // `listContractGadgets` flattens the package-keyed wire map
    // to `GadgetUse[]`. Kind is discriminated by the export-name
    // grammar — only `use`-prefixed hook names carry the direct-import-
    // and-call plumbing this block teaches; PascalCase component names
    // are rendered as JSX. Teach hook uses only — consistent with
    // generate.ts / system-prompt.ts.
    const hookUses = gadgetUses.filter((use) => HOOK_NAME_RE.test(use.name));
    if (hookUses.length > 0) {
      const caps = hookUses
        .map((use) => {
          const bits = [`  - **\`${use.name}\`**`];
          bits.push(`via direct-imported hook \`${use.name}\` from \`${use.package}\``);
          if (use.description) bits.push(`— ${use.description}`);
          if (use.usage) bits.push(`(usage: ${use.usage})`);
          return bits.join(' ');
        })
        .join('\n');
      parts.push(
        `## clientCapabilities.gadgets Contract (registered hooks the UI calls)\n${caps}\n\n` +
          `Each entry is a declaration — the UI imports the named hook and calls it. ` +
          `The hook returns the gadget's DATA; use it to drive the UI — render the ` +
          `fields, derive state, or thread the value into a context / action payload. ` +
          `There is no RPC surface for the agent to invoke.\n\n` +
          `Declarations:\n\`\`\`json\n${JSON.stringify(clientCapabilities, null, 2)}\n\`\`\``,
      );
    }
  }

  // Required-UI derivation — the architectural fix. Every contract
  // surface implies a visible UI element; eval scores against the
  // contract regardless of what the user-prompt narrative says. By
  // emitting the implied UI surfaces explicitly, the prompt-builder
  // makes the contract the single source of truth for "what must
  // render" — preventing the user-prompt-vs-contract drift that
  // accounts for chat-interface's chronic 60-75 score variance.
  const uiRequirements: string[] = [];
  if (contract.propsSpec?.properties) {
    for (const [name, entry] of Object.entries(contract.propsSpec.properties)) {
      const required = (entry as { required?: boolean }).required;
      if (required !== false) {
        uiRequirements.push(
          `- **Required prop \`${name}\`** must appear somewhere in rendered DOM (display the value, or use it to drive a label/aria/key).`,
        );
      }
    }
  }
  if (contract.actionSpec) {
    for (const [name, entry] of Object.entries(contract.actionSpec)) {
      const label = (entry as ActionEntry).label ?? name;
      uiRequirements.push(
        `- **Action \`${name}\`** ("${label}") needs an interactive control that fires it (Button click, form submit, key press, etc.).`,
      );
    }
  }
  if (contract.streamSpec) {
    for (const name of Object.keys(contract.streamSpec)) {
      uiRequirements.push(
        `- **Stream \`${name}\`** must mirror into local state via \`useEffect\` and render the resulting state — \`useStream\` alone never re-renders the DOM.`,
      );
    }
  }
  // agentCapabilities.tools intentionally NOT enumerated as UI
  // requirements — the component does not call these. The action /
  // stream surfaces that reference them (via nextStep / source.tool)
  // carry the UI burden.
  {
    for (const use of gadgetUses) {
      // Only `use`-prefixed hook names carry the direct-import-
      // and-call plumbing; PascalCase component names are rendered as
      // JSX (taught in system-prompt.ts's component table).
      if (!HOOK_NAME_RE.test(use.name)) continue;
      const hook = use.name;
      const pkg = use.package;
      uiRequirements.push(
        `- **clientCapabilities.gadgets[\`${hook}\`]** — a registered HOOK gadget. The boilerplate direct-imported \`${hook}\` from \`${pkg}\` above a \`// DO NOT EDIT\` banner. Call it at the top of the component; it returns the gadget's DATA — a value or object, NOT a renderable element. Read fields off the return value and use them to drive the UI; the gadget's \`Type:\` signature above gives the exact return shape. WORKED EXAMPLE:\n` +
          `\`\`\`tsx\n` +
          `// gadget hooks are direct-imported — keep this import, do not delete it\n` +
          `import { ${hook} } from '${pkg}';\n\n` +
          `export default function GeneratedComponent({ ...props }: Props) {\n` +
          `  // CALL the hook — its return value is DATA, not JSX.\n` +
          `  const ${hook}Data = ${hook}();\n` +
          `  // USE that data: read its fields to drive what you render,\n` +
          `  // derive state from it, or thread it into an action payload.\n` +
          `  // NEVER drop the return value into JSX as a child.\n` +
          `  return <Stack>{/* …render using ${hook}Data fields… */}</Stack>;\n` +
          `}\n` +
          `\`\`\`\n` +
          `**DO NOT** delete the \`import { ${hook} } from '${pkg}'\` line — it is required and the self_check rejects the commit with \`gadget_preservation:${hook}\` if it disappears. **DO NOT** move \`${hook}\` to a different package — import it from exactly \`${pkg}\`. The hook is REAL, REGISTERED, and CORRECT — your job is to USE its returned data, not "clean it up".`,
      );
    }
  }
  if (uiRequirements.length > 0) {
    parts.push(
      `## Required UI Surfaces (derived from contract — every surface below MUST have visible UI, eval will fail if any is missing)\n` +
        uiRequirements.join('\n'),
    );
  }

  return parts.join('\n\n');
}


/**
 * Inject data contract into user prompt if available.
 *
 * Accepts the operator-registered catalog so thin contract refs
 * (`{hook}` without per-binding `package`) resolve to the registered
 * descriptor's package in the prompt-emitted "import X from Y" lines.
 */
export function injectContracts(
  userPrompt: string,
  contract?: DataContract,
  appGadgets?: readonly GadgetDescriptor[],
): string {
  if (!contract) return userPrompt;
  const ctx = buildContractsContext(contract, appGadgets);
  if (!ctx) return userPrompt;
  return userPrompt + '\n\n' + ctx;
}

// =============================================================================
// Tool Name Constants
// =============================================================================

/** Tool names for the context-gathering phase. */
export const CONTEXT_TOOL_NAMES = ['get_primitives', 'get_design_system', 'get_app_components'];

/** Tool names for the build phase (no context tools). */
export const BUILD_TOOL_NAMES = ['self_check', 'validate_component', 'compile_component'];

/** Tool names for reference lookup in the coding agent's hybrid agentic loop. */
export const REFERENCE_TOOL_NAMES = ['get_primitives', 'get_design_system', 'get_app_components', 'get_predefined_components'];
