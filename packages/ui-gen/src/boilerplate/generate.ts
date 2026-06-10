// packages/ui-gen/src/boilerplate/generate.ts
//
// Typed boilerplate generator. Takes a data contract (propsSpec /
// actionSpec / streamSpec / contextSpec + agentCapabilities.tools +
// clientCapabilities.gadgets catalogs) and a rendering context
// (shell + screen) and produces the starting `.tsx` boilerplate the
// coding agent fills in via apply_changes.
//
// `agentCapabilities.tools` entries do NOT emit component hooks. They
// are catalog declarations the AGENT invokes; component code references
// them indirectly via `actionSpec.nextStep` (advisory hint surfacing on
// action events) and `streamSpec.source.tool` (transport-negotiated
// source).
//
// `clientCapabilities.gadgets` entries DO emit component-side gadget
// plumbing. Gadgets are direct-imported: the generator emits one
// combined `import { … } from '<package>'` per registered gadget
// package, above a `// DO NOT EDIT` banner. Hook exports additionally
// get a pre-emitted `const binding = hook();` call site; component
// exports are import-only — the LLM renders `<X … />` in the JSX tree
// itself. The deterministic `gadget_preservation` check rejects the
// code if a gadget import disappears.
//
// Pure function — deterministic, no env reads, no I/O other than
// `renderBoilerplate` reading the template files.

import type {
  ActionSpec,
  GadgetDescriptor,
  ContextSpec,
  DataContract,
  JsonObject,
  JsonSchema,
  JsonValue,
  StreamSpec,
} from "@ggui-ai/protocol";
import { HOOK_NAME_RE, listContractGadgets } from "@ggui-ai/protocol";
import { renderBoilerplate } from "./render.js";
import { jsonSchemaTypeToTs } from "./json-schema-ts.js";

/** Shell layout modes supported by the boilerplate templates. */
export type ShellType = "chat" | "fullscreen" | "spatial";

/** Target screen size. */
export type ScreenSize = "mobile" | "tablet" | "desktop" | "universal";

// =============================================================================
// Design-system surface (pre-imported in every boilerplate)
// =============================================================================

const ALL_PRIMITIVES = [
  "Container",
  "Card",
  "Stack",
  "Row",
  "Grid",
  "Box",
  "Divider",
  "Spacer",
  "Text",
  "Heading",
  "Button",
  "Input",
  "TextArea",
  "Select",
  "Checkbox",
  "Toggle",
  "RadioGroup",
  "Slider",
  "Badge",
  "Spinner",
  "Skeleton",
  "Avatar",
  "Alert",
  "Progress",
  "Image",
  "Icon",
  "Link",
  "Tooltip",
  "Table",
  "Tabs",
  "Toast",
  "Accordion",
  "MotionKeyframes",
  "useMotion",
  "useAnimationKey",
].join(", ");

const ALL_COMPONENTS = [
  "SearchField",
  "FormField",
  "MenuItem",
  "Tag",
  "Dropdown",
  "Autocomplete",
  "Breadcrumb",
  "Pagination",
  "EmptyState",
  "Stat",
].join(", ");

// 2026-05-15 audit fix: synced against actual @ggui-ai/design/compositions
// dist exports. Previously omitted 5 names (IncidentTimeline, MakeTabLayout,
// MarketingHero, MarketingCTA, MarketingFeatures) — the LLM didn't get them
// pre-imported, reducing discoverability. The data-URL shim's allowlist
// must mirror this list (enforced by verify-shim-allowlists.test.ts).
const ALL_COMPOSITIONS = [
  "Header",
  "Sidebar",
  "CardGrid",
  "CommentThread",
  "DataTable",
  "ChatWindow",
  "NavigationBar",
  "FileUploader",
  "UserProfileCard",
  "NotificationCenter",
  "Modal",
  "CommandPalette",
  "Footer",
  "Hero",
  "IncidentTimeline",
  "MakeTabLayout",
  "MarketingHero",
  "MarketingCTA",
  "MarketingFeatures",
].join(", ");

const ALL_INTERACT = ["Clickable", "Hoverable", "Pressable"].join(", ");

// D1: the whole design system is imported through one specifier
// (`@ggui-ai/design`), so the boilerplate emits a single import line.
const ALL_DESIGN = [
  ALL_PRIMITIVES,
  ALL_COMPONENTS,
  ALL_COMPOSITIONS,
  ALL_INTERACT,
].join(", ");

// =============================================================================
// Helpers
// =============================================================================

/** Infer a TypeScript type string from an example value (when no JSON Schema is available). */
function inferTypeFromExample(example: JsonObject): string {
  const fields: string[] = [];
  for (const [k, v] of Object.entries(example)) {
    let t: string;
    if (v === null || v === undefined) t = "unknown";
    else if (typeof v === "string") t = "string";
    else if (typeof v === "number") t = "number";
    else if (typeof v === "boolean") t = "boolean";
    else if (Array.isArray(v)) {
      if (v.length === 0) t = "unknown[]";
      else if (typeof v[0] === "string") t = "string[]";
      else if (typeof v[0] === "number") t = "number[]";
      else if (typeof v[0] === "object" && v[0] !== null)
        t = `Array<${inferTypeFromExample(v[0] as JsonObject)}>`;
      else t = "unknown[]";
    } else if (typeof v === "object") {
      t = inferTypeFromExample(v as JsonObject);
    } else {
      t = "unknown";
    }
    fields.push(`${k}: ${t}`);
  }
  return `{ ${fields.join("; ")} }`;
}

// =============================================================================
// Boilerplate generator
// =============================================================================

export function generateBoilerplate(
  _userPrompt: string,
  contract?: DataContract,
  shellType?: ShellType,
  screen?: ScreenSize,
  /** Axis-composed boilerplate sections — fragments produced by `compose()`. */
  composedSections?: string,
  /**
   * Registered gadget catalog. The boilerplate emits a direct
   * `import { … } from '<package>'` per gadget package from the
   * contract's declarations; this catalog supplies the descriptor
   * metadata (`description` / `usage` / `example`) used to prime each
   * pre-emitted gadget call site so the LLM has a working starting
   * point rather than an empty `useFoo()` it might delete.
   */
  appGadgets?: readonly GadgetDescriptor[],
): string {
  // ── Props interface from data contract (data only — NO action callbacks) ──
  // Contract shape: { properties: { fieldName: { schema, required, description } } }
  const propsFields: string[] = [];
  const propsData = contract?.propsSpec as JsonObject | undefined;
  // Unwrap: contract.propsSpec may be { properties: { ... } } or flat { field: spec }
  const propsProperties = (propsData?.properties as JsonObject) ?? propsData ?? {};
  for (const [key, value] of Object.entries(propsProperties)) {
    if (typeof value === "object" && value !== null) {
      const spec = value as JsonObject;
      const schema = spec.schema as JsonObject | undefined;
      const required = spec.required !== false;
      const nullable = schema?.nullable === true;
      const tsType = schema
        ? jsonSchemaTypeToTs(schema as unknown as JsonSchema)
        : "unknown";
      const fullType = nullable ? `${tsType} | null` : tsType;
      // Build comment: description + default value hint
      const parts: string[] = [];
      if (spec.description) parts.push(String(spec.description));
      if (spec.default !== undefined) parts.push(`(default: ${JSON.stringify(spec.default)})`);
      const desc = parts.length > 0 ? ` // ${parts.join(' ')}` : "";
      propsFields.push(`  ${key}${required ? "" : "?"}: ${fullType};${desc}`);
    } else {
      propsFields.push(`  ${key}: ${typeof value === "string" ? value : "unknown"};`);
    }
  }

  // ── Actions (useAction hooks — fire-and-forget to agent) ──
  // Contract shape: { actionSpec: { actionName: { label, description, schema?, example?, tool? } } }
  // ActionEntry.dispatch: when `kind === 'tool'`, this action routes to an
  // MCP tool registered on this server (synchronous dispatch). Wire useAction
  // normally — the platform handles tool dispatch. The tool name is
  // informational (use it for button labels, icons, copy).
  const actionTypeAliases: string[] = [];
  const actionHookCalls: string[] = [];
  const actionReturnFields: string[] = [];
  const actionsMap: ActionSpec = contract?.actionSpec ?? {};
  for (const [key, entry] of Object.entries(actionsMap)) {
    const label = entry.label ?? key;
    const desc = entry.description ?? "";
    const tool = entry.nextStep ?? "";
    const typeName = `Action${key.charAt(0).toUpperCase()}${key.slice(1)}Payload`;

    // Derive TypeScript type: schema > example > void (fire-and-forget)
    let tsType = "void";
    if (entry.schema) {
      tsType = jsonSchemaTypeToTs(entry.schema);
    } else if (entry.example && typeof entry.example === "object" && !Array.isArray(entry.example)) {
      tsType = inferTypeFromExample(entry.example as JsonObject);
    }

    const toolNote = tool ? ` (label "${label}", nextStep hint → ${tool})` : "";
    actionTypeAliases.push(
      `/** Action payload: ${desc || label}${toolNote} */\ntype ${typeName} = ${tsType};`
    );
    // Inline signature tells the LLM exactly how to call this action
    const callSig = tsType === "void" ? "() => void — fire and forget" : `(data: ${tsType}) => void`;
    const toolHint = tool ? ` → nextStep: ${tool}` : "";
    actionHookCalls.push(`  const ${key} = useAction<${typeName}>('${key}'); // ${callSig}${toolHint}`);
    actionReturnFields.push(key);
  }

  // ── Stream channels (useStream hooks — real-time from agent) ──
  // Stream spec: flat map { channelName: { schema, description, example } }
  const streamChannels: StreamSpec = contract?.streamSpec ?? {};
  const streamChannelEntries = Object.entries(streamChannels);

  const streamTypeAliases: string[] = [];
  const streamHookCalls: string[] = [];
  const streamReturnFields: string[] = [];
  for (const [channelName, entry] of streamChannelEntries) {
    const desc = entry.description ?? "";
    const typeName = `Stream${channelName.charAt(0).toUpperCase()}${channelName.slice(1)}`;
    const tsType = entry.schema
      ? jsonSchemaTypeToTs(entry.schema)
      : "unknown";
    streamTypeAliases.push(`/** Stream channel: ${desc} */\ntype ${typeName} = ${tsType};`);
    // Show .latest/.all types so the LLM knows how to access stream data
    streamHookCalls.push(
      `  const ${channelName} = useStream<${typeName}>('${channelName}'); // .latest: ${typeName} | null, .all: ${typeName}[]`
    );
    streamReturnFields.push(channelName);
  }

  // ── agentCapabilities.tools catalog (NO component-side hook emission) ──
  // `agentCapabilities.tools[*]` declares tools the AGENT invokes —
  // referenced from the contract via `actionSpec[*].nextStep` (advisory
  // hint forwarded on action events) and `streamSpec[*].source.tool`
  // (channel data source). The component never calls these tools
  // directly; there is no `useWiredTool(name)` hook. The boilerplate
  // therefore emits no per-tool hook line, no request/response type
  // aliases, and no useWiredTool import.

  // ── Client capabilities (browser-capability gadget hooks declared in contract) ──
  // Contract shape: { gadgets: { '<package>': { '<exportName>': { description?, usage? } } } }
  // package-keyed two-level map. `listContractGadgets` flattens it to
  // `GadgetUse[]` — one record per used export with `package`, `name`,
  // and optional `description` / `usage` overrides. The export NAME
  // grammar discriminates kind (`use`-prefixed → hook, PascalCase →
  // component).
  // No type aliases — gadget hooks own their typed return shape.
  // No wire-import side effect — gadgets are imported from `package`
  // (default `@ggui-ai/gadgets`), not from `@ggui-ai/wire`.
  //
  // Group-by-package — emit ONE combined `import { hookA, hookB } from '<pkg>'`
  // per declared package, NOT one import per hook. Hooks ordered
  // alphabetically within each package for stable diffs across same-
  // contract regens.
  const gadgetUses = contract ? listContractGadgets(contract) : [];

  // Gadgets are DIRECT-imported from their package, grouped
  // per package below. Build a hook-name → registry export lookup so
  // each contract-declared gadget binding can be enriched with the
  // catalog's description / usage / example fields. Mirrors how wire
  // boilerplate emits typed action signatures + nextStep hints —
  // gadgets get the same priming so the LLM has a working call site to
  // start from rather than an empty `useFoo()` it might delete.
  //
  // Each `GadgetDescriptor` is a PACKAGE with `exports[]`;
  // flatten to the hook exports, keyed by hook name.
  const gadgetCatalog = new Map<
    string,
    {
      readonly description?: string;
      readonly usage?: string;
      readonly example?: JsonValue;
    }
  >();
  for (const descriptor of appGadgets ?? []) {
    for (const exp of descriptor.exports) {
      // `GadgetExport` is a type-exclusive union (`hook?: never` on the
      // component member); discriminate by VALUE presence — `"hook" in
      // exp` no longer narrows now that `hook` is an optional key of
      // both members.
      if (exp.hook === undefined) continue;
      gadgetCatalog.set(exp.hook, {
        description: exp.description,
        usage: exp.usage,
        example: exp.example,
      });
    }
  }
  // Gadget imports grouped by package: `package → set of export names`
  // (hook AND component exports). One combined
  // `import { … } from '<pkg>'` is emitted per package.
  const gadgetImportsByPackage = new Map<string, Set<string>>();
  const gadgetHookCalls: string[] = [];
  for (const use of gadgetUses) {
    const exportName = use.name;
    // Both hooks and components are DIRECT-imported from their
    // package — add every contract-declared export to the per-package
    // import group.
    const pkgExports = gadgetImportsByPackage.get(use.package);
    if (pkgExports !== undefined) pkgExports.add(exportName);
    else gadgetImportsByPackage.set(use.package, new Set([exportName]));

    // Kind discrimination is by the export-name grammar.
    // A component name (PascalCase) is import-only — the LLM renders
    // `<X … />` in the JSX tree itself, so there is no pre-emitted call
    // site. Hook names (`use`-prefixed) additionally get a pre-emitted
    // call line below so the LLM has a working invocation.
    if (!HOOK_NAME_RE.test(exportName)) continue;
    const hook = exportName;
    // Contract entry's local override wins; registry catalog is the
    // fallback (most plugin descriptors live on the registry side).
    // The wire `GadgetUse` carries only `description` / `usage`
    // overrides — `example` lives solely on the registered export.
    const contractDesc = use.description;
    const contractUsage = use.usage;
    const catalog = gadgetCatalog.get(hook) ?? {};
    const desc = contractDesc ?? catalog.description ?? hook;
    const usage = contractUsage ?? catalog.usage;
    const example = catalog.example;

    // Pre-emit the hook call so the LLM sees a working invocation
    // (and doesn't delete it as "unused"). Mirrors wire's typed-
    // signature pattern. Two example shapes in the wild:
    //   (a) plain literal — `{ center: [0,0], zoom: 12 }` — the
    //       descriptor IS the call args; inline as the call arg.
    //   (b) shaped object — `{ call: '<full TS expression>',
    //       returns: <typed return shape> }` — the canonical
    //       sample/leaflet descriptor shape; emit the `call` as a
    //       separate EXAMPLE comment so the LLM sees the literal TS
    //       it should produce.
    let callArgs = '';
    let exampleComment = '';
    if (example !== undefined && example !== null) {
      const callLine =
        typeof example === 'object' &&
        !Array.isArray(example) &&
        typeof example.call === 'string'
          ? example.call
          : undefined;
      if (callLine !== undefined) {
        exampleComment = `\n  // EXAMPLE: ${callLine.trim()}`;
      } else {
        callArgs = JSON.stringify(example);
      }
    }
    const usageNote = usage ? ` USE: ${usage}` : '';
    // Local binding name: strip the `use` prefix + lowercase the first
    // char so `useGeolocation` → `geolocation`. The wire no longer
    // carries an explicit binding name (the export name IS the inner
    // key), so the boilerplate derives a stable, readable one.
    const bindingName =
      hook.length > 3
        ? hook.charAt(3).toLowerCase() + hook.slice(4)
        : hook;
    gadgetHookCalls.push(
      `  const ${bindingName} = ${hook}(${callArgs}); // ${desc}${usageNote}${exampleComment}`,
    );
  }
  // Gadgets are DIRECT-imported, one combined
  // `import { hookA, hookB } from '<pkg>'` per registered package
  // (packages + hooks sorted for stable diffs across same-contract
  // regens). The `DO NOT EDIT` banner + tier-0 `gadget_preservation`
  // keep the LLM from deleting an import it (correctly) intuits is
  // runtime-resolved — the banner alone makes direct imports survive
  // multi-turn generation. Tier-0 verifies each registered hook is
  // still imported from its package.
  const gadgetImportLine =
    gadgetImportsByPackage.size > 0
      ? "// DO NOT EDIT — gadget imports. Each export is resolved by the iframe " +
        "runtime; keep every import line and export name. self_check fails with " +
        "gadget_preservation:<export> if a gadget import is removed.\n" +
        Array.from(gadgetImportsByPackage.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(
            ([pkg, hooks]) =>
              `import { ${Array.from(hooks).sort().join(", ")} } from '${pkg}';`,
          )
          .join("\n")
      : "";
  // ── Props interface (data only — no action callbacks) ──
  const propsInterface =
    propsFields.length > 0
      ? `// DO NOT EDIT — generated from data contract. Changing this will fail validation.\ninterface Props {\n${propsFields.join("\n")}\n}`
      : `// DO NOT EDIT — generated from data contract.\ninterface Props {\n  [key: string]: string | number | boolean | null | object;\n}`;

  // ── Context slots — `useGguiContext` hook ──
  // For each declared `contextSpec` slot, emit ONE destructure line
  // at the top of the user component:
  //   const [<slotKey>, set<PascalSlotKey>] =
  //     useGguiContext<TS>('<slotKey>');
  // The runtime owns useState per slot and wraps the user component
  // in nested SingleSlotProvider components — the user only reads
  // the live tuple via the hook. There must be NO `useState` and NO
  // `<Provider>` wrap anywhere in the LLM-authored JSX.
  const contextSpec: ContextSpec = contract?.contextSpec ?? {};
  const contextSpecEntries = Object.entries(contextSpec);
  let contextHooks = "";
  if (contextSpecEntries.length > 0) {
    const hookLines: string[] = [];
    for (const [slotKey, entry] of contextSpecEntries) {
      const valueType = entry.schema
        ? jsonSchemaTypeToTs(entry.schema)
        : "unknown";
      const setterName = `set${slotKey.charAt(0).toUpperCase()}${slotKey.slice(1)}`;
      hookLines.push(
        `  const [${slotKey}, ${setterName}] = useGguiContext<${valueType}>('${slotKey}');`,
      );
    }
    contextHooks =
      `  // DO NOT EDIT — auto-generated per contextSpec slot.\n` +
      `  // Read \`<slotKey>\` to render, write via \`set<SlotKey>\` to\n` +
      `  // surface the change to the agent's LLM context (debounced).\n` +
      `  // The runtime owns the underlying useState + Provider; you\n` +
      `  // write plain JSX, no wrap.\n` +
      `${hookLines.join("\n")}\n`;
  }

  // ── Determine which wire hooks are needed ──
  const hasActions = actionHookCalls.length > 0;
  const hasStream = streamHookCalls.length > 0;
  // Gates the gadget hook-CALL body section. A component gadget
  // contributes an import but no call site, so this is false for a
  // component-only contract — the import line is gated separately on
  // `gadgetImportLine` below.
  const hasGadgetHookCalls = gadgetHookCalls.length > 0;
  const hasContext = contextSpecEntries.length > 0;
  // `hasAnyHook` gates the "DO NOT EDIT wire hooks" header + body.
  // Client gadget HOOKS contribute call sites alongside the
  // @ggui-ai/wire hooks — their declaration needs the same emitted
  // header so the LLM sees the binding lines pre-declared and doesn't
  // strip / duplicate them. (Component gadgets add no body line.)
  const hasAnyHook =
    hasActions || hasStream || hasContext || hasGadgetHookCalls;
  const hasAnyWireFromWire = hasActions || hasStream || hasContext;

  const wireHooks: string[] = [];
  if (hasActions) wireHooks.push("useAction");
  if (hasStream) wireHooks.push("useStream");
  if (hasContext) wireHooks.push("useGguiContext");
  const wireImport = hasAnyWireFromWire
    ? `import { ${wireHooks.join(", ")} } from '@ggui-ai/wire';\n`
    : "";
  // The gadget import line is emitted whenever ANY gadget export is
  // declared — hook OR component. (`gadgetImportLine` is non-empty iff
  // `gadgetImportsByPackage` has an entry; component-only contracts
  // have an import but no `hasGadgetHookCalls`.)
  const gadgetImport =
    gadgetImportLine.length > 0 ? `${gadgetImportLine}\n` : "";

  // ── React import — only include hooks that are actually needed ──
  const reactHooks = ["useState", "useCallback", "useMemo", "useEffect", "useRef"];
  const reactImport = `import React, { ${reactHooks.join(", ")} } from 'react';`;

  // ── Hook body ──────────────────────────────────────────
  // Wire hooks are placed inside render(), before the return statement.
  const hookParts: string[] = [];
  if (hasActions) {
    hookParts.push("  // ── Actions (contract-typed, fire-and-forget to agent) ──");
    hookParts.push("  // Call these to send user interactions to the agent. Types are enforced by the compiler.");
    hookParts.push(...actionHookCalls);
  }
  if (hasStream) {
    hookParts.push("");
    hookParts.push("  // ── Streams (contract-typed, real-time from agent) ──");
    hookParts.push("  // .latest is the most recent event (or null). .all is the full history array.");
    hookParts.push(...streamHookCalls);
  }
  if (hasGadgetHookCalls) {
    hookParts.push("");
    hookParts.push("  // ── Gadgets (browser-capability hooks; UI-owned lifecycle) ──");
    hookParts.push("  // Read .value / .status; call .start() to invoke. Surface .value through");
    hookParts.push("  // an actionSpec payload or contextSpec slot if the agent needs to observe it.");
    hookParts.push(...gadgetHookCalls);
  }

  // Only emit the "DO NOT EDIT wire hooks" header when there ARE wire-side
  // OR gadget-side hook bindings to surface. An orphaned header on
  // no-wire fixtures (e.g. weather-card) makes the LLM hallucinate
  // hooks for an empty section and burn turns on missing imports.
  const hookBody = hasAnyHook
    ? `  // DO NOT EDIT wire hooks — auto-generated from the data contract\n${hookParts.join("\n")}\n`
    : "";

  // ── Type alias blocks ───────────────────────────────────
  // Auto-generated type aliases serve as documentation for the LLM. Some are
  // referenced by the wire-hook calls below (e.g. `useAction<ActionXPayload>`)
  // but request types are typically only mentioned in trailing comments —
  // ESLint flags them as unused. Without `eslint-disable` here, the LLM
  // enters a fix-rename oscillation loop (prefix `_`, break prop access,
  // revert, retry…) that drives up to 27% of cap-hit selfCheckFails on
  // wire-bearing fixtures. Suppress no-unused-vars for the generated
  // type-alias block; "DO NOT EDIT" comments + tier-0 wire-preservation
  // already prevent the LLM from removing them.
  const wrapTypes = (label: string, body: string): string =>
    `\n/* eslint-disable no-unused-vars */\n// DO NOT EDIT — ${label}\n${body}\n/* eslint-enable no-unused-vars */\n`;

  const actionTypesBlock =
    actionTypeAliases.length > 0
      ? wrapTypes("action payload types generated from action contract.", actionTypeAliases.join("\n\n"))
      : "";
  const streamTypesBlock =
    streamTypeAliases.length > 0
      ? wrapTypes("stream event types generated from stream contract.", streamTypeAliases.join("\n\n"))
      : "";
  // `clientCapabilities.gadgets` ship NO type-alias block — gadget
  // hooks own their typed return shape internally; the contract surface
  // is pure declaration. The boilerplate generator inserts a
  // `CLIENT_TOOL_TYPES` slot for legacy template compatibility but
  // fills it with an empty string under the new shape.
  const clientToolTypesBlock = "";

  return renderBoilerplate(shellType ?? "fullscreen", screen ?? "universal", {
    REACT_IMPORT: reactImport,
    ALL_DESIGN,
    WIRE_IMPORT: wireImport + gadgetImport,
    PROPS_INTERFACE: propsInterface,
    ACTION_TYPES: actionTypesBlock,
    STREAM_TYPES: streamTypesBlock,
    CLIENT_TOOL_TYPES: clientToolTypesBlock,
    CONTEXT_HOOKS: contextHooks,
    WIRE_HOOKS: hookBody,
    AXIS_SECTIONS: composedSections ?? "",
  });
}
