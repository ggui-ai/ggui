/**
 * Contract + rendering-context prompt rendering.
 *
 * Surfaces every contract dimension explicitly to the LLM. A compact
 * bullet list of action / stream names is not enough — without the
 * Props shape, generation fails tier-0 on most cells with "Props
 * interface missing required field '<name>'".
 *
 * Renders:
 *
 *   - Props contract — required + optional field lists + a real
 *     TypeScript interface (compiled via `propsSpecToTypeScript`)
 *   - Action contract — id / label / example / nextStep hint
 *   - Stream contract — channel descriptions + payload schemas + source
 *   - AgentTools — catalog of tools the contract references (via
 *     `actionSpec[*].nextStep` and `streamSpec[*].source.tool`)
 *   - ClientCapabilities — browser-capability gadgets the UI mounts:
 *     hooks it calls (e.g. `useGeolocation` from `@ggui-ai/gadgets`)
 *     and components it renders (e.g. `<LeafletMap />`)
 *   - Required UI Surfaces — derived list of "every contract surface
 *     must have visible UI" so the LLM doesn't drop required props or
 *     skip rendering data sources
 *
 * Rendering context (device + shell + viewport) is layered alongside —
 * shells (`chat` / `fullscreen` / `partial`) require very different
 * sizing strategies and including the hint inline cuts a class of
 * "designed for fullscreen, rendered in a chat bubble" bugs.
 */
import type {
  ActionEntry,
  BlueprintVariance,
  GadgetDescriptor,
  DataContract,
  StreamChannelEntry,
} from '@ggui-ai/protocol';
import { HOOK_NAME_RE, listContractGadgets } from '@ggui-ai/protocol';
import { propsSpecToTypeScript } from './check/index.js';

/**
 * Rendering context — how and where the component will be displayed.
 * Affects layout strategy, sizing, and interaction patterns. Mirrors the
 * shape cloud's harness passes through `dispatchGeneration`.
 */
export interface RenderingContext {
  /** Device category — affects touch targets, column count, density. */
  readonly device: 'mobile' | 'tablet' | 'desktop' | 'spatial';
  /** Shell type — the container the component renders in. */
  readonly shell: 'chat' | 'fullscreen' | 'partial';
  /** Viewport dimensions in CSS pixels (optional). */
  readonly viewport?: { readonly width: number; readonly height: number };
}

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

/** Build rendering-context block to inject into user prompt. */
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

/** Append rendering context to user prompt if present. */
export function injectRenderingContext(
  userPrompt: string,
  rendering?: RenderingContext,
): string {
  if (!rendering) return userPrompt;
  return userPrompt + '\n\n' + buildRenderingContext(rendering);
}

/**
 * Build the contract-context block. Surfaces every dimension of the
 * contract so the LLM has a complete spec rather than the user-prompt
 * narrative alone — the eval scores against the contract regardless of
 * what prose the prompt carries, so contract-first rendering closes
 * the prompt-vs-contract drift class.
 */
export function buildContractsContext(
  contract: DataContract,
  /**
   * Operator-registered gadget catalog. When a
   * `clientCapabilities.gadgets[*]` ref is THIN (just `{hook}` —
   * no per-binding `package`), look the hook up here to surface the
   * correct package in user-prompt lines like `via useLeafletMap from
   * @ggui-samples/gadget-leaflet`. Mirrors the same plumb in
   * `harness/prompts.ts:buildContractsContext` — both surfaces are
   * separate copies used by different call sites (this one is for
   * `createUiGenerator`, the other for the benchmark / dispatch path).
   */
  appGadgets?: readonly GadgetDescriptor[],
): string {
  const parts: string[] = [];

  // The LLM direct-imports each hook from its own package
  // (resolved from the per-entry `package` field). The parameter stays
  // on the signature so the TypeScript sandbox augmentation layer can
  // still consume it.
  void appGadgets;

  // `intent` is not a contract field; `userPrompt` already carries
  // the agent's narrative as the prompt body, so the contract-context
  // block focuses on the structural shape (props / actions / streams /
  // contexts). There is no categorical `interaction` mode label: the
  // four-spec surface (props / actions / streams / contexts) describes
  // the wire exhaustively — actions drive turns, contexts observe
  // state, and there is no third category.

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
        if (entry.source?.tool) {
          bits.push(`(source tool: \`${entry.source.tool}\`)`);
        }
        return bits.join(' ');
      })
      .join('\n');
    parts.push(
      `## Stream Contract (real-time channels via \`useStream(name)\`)\n${channels}\n\n` +
        `Payload schemas:\n\`\`\`json\n${JSON.stringify(contract.streamSpec, null, 2)}\n\`\`\``,
    );
  }

  const agentTools = contract.agentCapabilities?.tools;
  if (agentTools && Object.keys(agentTools).length > 0) {
    const tools = Object.entries(agentTools)
      .map(([name, entry]) => {
        const bits = [`  - **\`${name}\`**`];
        if (entry.description) bits.push(`— ${entry.description}`);
        if (entry.usage) bits.push(`(usage: ${entry.usage})`);
        if (entry.required === false) bits.push('(optional)');
        return bits.join(' ');
      })
      .join('\n');
    parts.push(
      `## AgentTools Catalog (tools the contract references)\n${tools}\n\n` +
        `These are referenced via \`actionSpec[*].nextStep\` (the tool the agent SHOULD call next ` +
        `after the action fires) and \`streamSpec[*].source.tool\` (the tool feeding a channel). ` +
        `The agent OWNS the call — your component does not invoke these directly.\n\n` +
        `Schemas:\n\`\`\`json\n${JSON.stringify(agentTools, null, 2)}\n\`\`\``,
    );
  }

  const clientCapabilities = contract.clientCapabilities?.gadgets;
  const gadgetUses = listContractGadgets(contract);
  if (gadgetUses.length > 0) {
    // The wire `clientCapabilities.gadgets` is a package-keyed
    // two-level map; `listContractGadgets` flattens it to `GadgetUse[]`.
    // Kind is discriminated by the export-name grammar — `use`-prefixed
    // names are hooks (imported + CALLED), PascalCase names are
    // components (imported + RENDERED as JSX). Both are direct-imported.
    const caps = gadgetUses
      .map((use) => {
        const bits = [`  - **\`${use.name}\`**`];
        bits.push(
          HOOK_NAME_RE.test(use.name)
            ? `via direct-imported hook \`${use.name}\` from \`${use.package}\` (call it)`
            : `via direct-imported component \`<${use.name} />\` from \`${use.package}\` (render as JSX)`,
        );
        if (use.description) bits.push(`— ${use.description}`);
        return bits.join(' ');
      })
      .join('\n');
    parts.push(
      `## ClientCapabilities Contract (browser-capability gadgets the UI mounts)\n${caps}\n\n` +
        `Hook entries are imported + called; component entries are imported + rendered as JSX. ` +
        `Capability values reach the agent only when the UI threads them into an actionSpec ` +
        `payload or contextSpec slot.\n\n` +
        `Declarations:\n\`\`\`json\n${JSON.stringify(clientCapabilities, null, 2)}\n\`\`\``,
    );
  }

  // Required-UI derivation — the architectural fix at the heart of v15.
  // Every contract surface implies a visible UI element; eval scores
  // against the contract regardless of what the user-prompt narrative
  // says. Emitting the implied UI surfaces explicitly makes the contract
  // the single source of truth for "what must render".
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
  // agentTools entries don't imply UI on their own — they're catalog
  // declarations the agent uses, not hooks the component invokes.
  // The implied UI lives on the referencing actionSpec entries
  // (already enumerated above) and streamSpec channels with `source`
  // declarations. No per-tool UI requirement is emitted here.
  for (const use of gadgetUses) {
    // Hook AND component exports are direct-imported; the
    // implied UI differs — a hook is called + its value threaded,
    // a component is rendered as a JSX element. Kind is discriminated
    // by the export-name grammar.
    const exportName = use.name;
    const pkg = use.package;
    uiRequirements.push(
      HOOK_NAME_RE.test(exportName)
        ? `- **ClientCapability \`${exportName}\`** — the boilerplate has direct-imported \`${exportName}\` from \`${pkg}\` above a \`// DO NOT EDIT\` banner; keep that import, call \`${exportName}\` inside the component, and thread the resulting value into a context slot or action payload if the agent needs to observe it.`
        : `- **ClientCapability \`${exportName}\`** — the boilerplate has direct-imported \`${exportName}\` from \`${pkg}\` above a \`// DO NOT EDIT\` banner; keep that import and RENDER \`<${exportName} … />\` as a JSX element in the tree you return.`,
    );
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
 * Append the contract-context block to a user prompt if a contract is present.
 *
 * `appGadgets` forwards into `buildContractsContext` so thin contract
 * refs (`{hook}` without per-binding `package`) resolve to the
 * registered descriptor's package in the prompt-emitted "import X from
 * Y" lines.
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

/**
 * Build the variance-context block. Surfaces the agent's declared
 * styling signals (persona, aesthetic, context, seedPrompt) so cold-gen
 * aligns the produced component with the requested variant. Each field
 * is optional; the block only renders when at least one is present.
 *
 * - `persona` names the USER mental model (e.g. "data-analyst",
 *   "mobile-first reader") — drives copy register + density choices.
 * - `aesthetic` names the VISUAL treatment (e.g. "glassmorphic",
 *   "editorial", "brutalist") — drives surface decoration, typographic
 *   weight, color usage.
 * - `context` is structured key-value signal alongside the persona —
 *   small JSON-safe shape, serialized verbatim into the prompt.
 * - `seedPrompt` is the operator's original natural-language steer that
 *   produced this variant in cache storage — useful as a one-line
 *   directive for cold-gen.
 *
 * Returns an empty string when no fields are populated so the inject
 * helper can no-op cleanly.
 */
export function buildVarianceContext(variance: BlueprintVariance): string {
  const lines: string[] = [];
  if (typeof variance.persona === 'string' && variance.persona.length > 0) {
    lines.push(`- **Persona**: ${variance.persona}`);
  }
  if (typeof variance.aesthetic === 'string' && variance.aesthetic.length > 0) {
    lines.push(`- **Aesthetic**: ${variance.aesthetic}`);
  }
  if (typeof variance.seedPrompt === 'string' && variance.seedPrompt.length > 0) {
    lines.push(`- **Seed prompt**: ${variance.seedPrompt}`);
  }
  if (
    variance.context !== undefined &&
    variance.context !== null &&
    typeof variance.context === 'object' &&
    !Array.isArray(variance.context) &&
    Object.keys(variance.context).length > 0
  ) {
    lines.push(`- **Context**: ${JSON.stringify(variance.context)}`);
  }
  if (lines.length === 0) return '';
  return [
    '## Variance (apply to styling, not contract shape)',
    '',
    'The agent (or operator) declared these variant signals. Honor them in',
    'the visual treatment + copy register — but the contract shape (props,',
    'actions, contexts, streams) remains canonical. Variance changes HOW',
    'the UI looks and reads, not WHAT it does.',
    '',
    ...lines,
  ].join('\n');
}

/** Append the variance-context block to a user prompt if variance is present. */
export function injectVariance(
  userPrompt: string,
  variance?: BlueprintVariance,
): string {
  if (!variance) return userPrompt;
  const block = buildVarianceContext(variance);
  if (!block) return userPrompt;
  return userPrompt + '\n\n' + block;
}
