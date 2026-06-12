// packages/ui-gen/src/tools.ts
//
// LLM tool grammars used by the generation stage. Primary tool =
// `apply_changes` (multi-range patch). Scoped fallback =
// `apply_changes` with `maxItems=1` for transport-error recovery
// (malformed_tool_call retries). Plus:
//   - hashline variants (`APPLY_CHANGES_HASHLINE_TOOL[_FLAT]`) used
//     when the `hashline: "v2"` policy profile selects them;
//   - flat-code variant (`APPLY_CHANGES_TOOL_FLAT`) — the shipped
//     default;
//   - helper tools (`GET_ICONS_TOOL`, `GET_COMPONENTS_INFO_TOOL`,
//     `WRITE_PLAN_TOOL`, `REWRITE_TOOL`) wired into the
//     `selectTurnTools` path.
//
// Harness `what.codingTools` can override with any subset; alternate
// patch grammars swap in by replacing the tool list + a matching
// `applyPatch` implementation.
//
// The tool definitions in this file are static JSON schemas + prompt
// text. The decision logic (which profile picks which tool,
// model-registry overrides, environment gating) lives in
// `./harness/policy.ts` + `run-coding-turn.ts::selectTurnTools` —
// nothing in this file reads a profile or an env var; these are data.

import type { LLMToolDef } from "./llm.js";
export type { LLMToolDef };

/** Standard multi-range patch tool — surgical edits. */
export const APPLY_CHANGES_TOOL: LLMToolDef = {
  name: "apply_changes",
  description:
    "Surgical edit: replace line ranges in ui.tsx with new code. Use line numbers from the Current File (shown as N│). Preferred for targeted changes — fixing one hook, renaming a prop, swapping a component, closing a missing tag. The patch is ALWAYS applied to the workspace even if the resulting file has syntax errors — the error location is returned as guidance so you can iterate. If the file is in a tangled state and patches aren't converging cleanly, use `write` to rewrite from scratch.",
  parameters: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        description:
          "Array of changes. Each replaces lines startLine through endLine (inclusive) with the new code lines. Applied bottom-to-top to preserve line numbers.",
        items: {
          type: "object",
          properties: {
            startLine: {
              type: "number",
              description: "First line to replace (from the N│ numbers in Current File)",
            },
            endLine: { type: "number", description: "Last line to replace (inclusive)" },
            code: {
              type: "array",
              items: { type: "string" },
              description:
                "New code lines. One source line per array element. Avoid embedding newlines inside an element. For long JSX blocks, split at statement boundaries across multiple changes.",
            },
            description: { type: "string", description: "What this change does (< 10 words)" },
          },
          required: ["startLine", "endLine", "code", "description"],
        },
      },
      commit_message: { type: "string", description: "Short summary of all changes" },
      allowBroken: {
        type: "boolean",
        description:
          "Opt-in: commit the patch even if the resulting file fails syntax preflight. Use when you want to iterate across multiple turns and accept a broken intermediate state (e.g., split a big JSX refactor into 2 patches). Default false (strict preflight).",
      },
    },
    required: ["changes", "commit_message"],
  },
};

/**
 * Scoped fallback variant for transport-error retries. Used by the LLM
 * router when `malformed_tool_call` exhausts the standard retry budget —
 * forces a single small change (≤20 lines) so the payload fits within the
 * provider's JSON-emission ceiling. Universal signal; only Gemini hits this
 * path today, but the handler is not provider-gated.
 */
export const APPLY_CHANGES_TOOL_SCOPED: LLMToolDef = {
  name: "apply_changes",
  description:
    "Replace ONE small line range in ui.tsx. Narrow schema for transport-error recovery: emit a single change covering at most 20 lines.",
  parameters: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        description: "Single change. endLine - startLine ≤ 20.",
        items: {
          type: "object",
          properties: {
            startLine: { type: "number", description: "First line to replace" },
            endLine: {
              type: "number",
              description: "Last line (inclusive). Keep endLine - startLine ≤ 20.",
            },
            code: {
              type: "array",
              items: { type: "string" },
              description:
                "New code lines (one source line per element, no embedded newlines). ≤ 20 elements.",
            },
            description: { type: "string", description: "What this change does (< 10 words)" },
          },
          required: ["startLine", "endLine", "code", "description"],
        },
      },
      commit_message: { type: "string", description: "Short summary" },
    },
    required: ["changes", "commit_message"],
  },
};

/** Hashline variant of APPLY_CHANGES_TOOL.
 *  When the `hashline-v2` policy profile is active, this tool is
 *  advertised in place of the standard numeric-line APPLY_CHANGES_TOOL.
 *  The `startLine` and `endLine` fields are STRINGS in `"N:hh"` format
 *  (e.g., `"47:a3"`) — where `hh` is the 2-char content hash shown in
 *  the `## Current File` block. The handler validates the hash against
 *  the current file; if it mismatches, the edit is rejected with
 *  HASHLINE_STALE so the LLM re-reads before patching. */
export const APPLY_CHANGES_HASHLINE_TOOL: LLMToolDef = {
  name: "apply_changes",
  description:
    "Surgical edit with line-hash verification. Replace line ranges in ui.tsx. Line refs use the format `N:hh` from the Current File block (e.g., `47:a3`) — the 2-char hash anchors your view so the edit is rejected if the file drifted under you. Always use the exact hashes shown in the latest Current File view. The patch is applied even if the resulting file has syntax errors (the error location is returned as guidance); but edits with mismatched hashes are rejected BEFORE apply.",
  parameters: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        description:
          "Array of changes. Each replaces `startLine` through `endLine` (inclusive) with the new code lines. Line refs use the `N:hh` format.",
        items: {
          type: "object",
          properties: {
            startLine: {
              type: "string",
              pattern: "^\\d+:[0-9a-f]{2}$",
              description:
                "First line to replace, as `N:hh` (e.g., `47:a3`). The hash MUST match the line's hash in the latest Current File view. Format is line-number, colon, 2 lowercase hex chars — enforced by JSON schema pattern.",
            },
            endLine: {
              type: "string",
              pattern: "^\\d+:[0-9a-f]{2}$",
              description:
                "Last line to replace, as `N:hh` (e.g., `83:b1`). Hash MUST match. Format: line-number, colon, 2 lowercase hex chars.",
            },
            code: {
              type: "array",
              items: { type: "string" },
              description:
                "New code lines. One source line per array element. No embedded newlines.",
            },
            description: { type: "string", description: "What this change does (< 10 words)" },
          },
          required: ["startLine", "endLine", "code", "description"],
        },
      },
      commit_message: { type: "string", description: "Short summary of all changes" },
    },
    required: ["changes", "commit_message"],
  },
};

/**
 * Flat-code variant of APPLY_CHANGES_TOOL.
 *
 * Identical to APPLY_CHANGES_TOOL except `code` is a single string with
 * `\n`-separated lines instead of an array. One level of JSON nesting
 * shallower — a deeply-nested schema can trip some model decoders. The
 * handler in `coding-agent/tools.ts` accepts both shapes.
 */
export const APPLY_CHANGES_TOOL_FLAT: LLMToolDef = {
  name: "apply_changes",
  description:
    "Surgical edit: replace line ranges in ui.tsx with new code. Use line numbers from the Current File (shown as N│). Preferred for targeted changes. The `code` field is a single string with newlines (`\\n`) between lines. The patch is ALWAYS applied even if the resulting file has syntax errors — the error is returned as guidance. For a full rewrite, use `rewrite`.",
  parameters: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        description:
          "Array of changes. Each replaces lines startLine through endLine (inclusive). Applied bottom-to-top.",
        items: {
          type: "object",
          properties: {
            startLine: {
              type: "number",
              description: "First line to replace (from the N│ numbers in Current File)",
            },
            endLine: { type: "number", description: "Last line to replace (inclusive)" },
            code: {
              type: "string",
              description:
                "New code as a single string. Separate lines with `\\n`. Preserve leading indentation inside the string.",
            },
            description: { type: "string", description: "What this change does (< 10 words)" },
          },
          required: ["startLine", "endLine", "code", "description"],
        },
      },
      commit_message: { type: "string", description: "Short summary of all changes" },
      allowBroken: {
        type: "boolean",
        description:
          "Opt-in: commit the patch even if the resulting file fails syntax preflight.",
      },
    },
    required: ["changes", "commit_message"],
  },
};

/**
 * Flat-code + hashline variant.
 * Combines `code: string` flatness with `N:hh` hash-verified line refs
 * from hashline-v2.
 */
export const APPLY_CHANGES_HASHLINE_TOOL_FLAT: LLMToolDef = {
  name: "apply_changes",
  description:
    "Surgical edit with line-hash verification. Replace line ranges in ui.tsx using `N:hh` references from the Current File (e.g. `47:a3`). The `code` field is a single string with newlines between lines. Edits with mismatched hashes are rejected before apply.",
  parameters: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        description: "Array of changes. Line refs use `N:hh` format.",
        items: {
          type: "object",
          properties: {
            startLine: {
              type: "string",
              pattern: "^\\d+:[0-9a-f]{2}$",
              description:
                "First line to replace, as `N:hh` (e.g., `47:a3`). Hash MUST match the latest Current File view. Format: line-number, colon, 2 lowercase hex chars.",
            },
            endLine: {
              type: "string",
              pattern: "^\\d+:[0-9a-f]{2}$",
              description:
                "Last line to replace, as `N:hh` (e.g., `83:b1`). Hash MUST match.",
            },
            code: {
              type: "string",
              description:
                "New code as a single string. Separate lines with `\\n`. Preserve leading indentation.",
            },
            description: { type: "string", description: "What this change does (< 10 words)" },
          },
          required: ["startLine", "endLine", "code", "description"],
        },
      },
      commit_message: { type: "string", description: "Short summary of all changes" },
    },
    required: ["changes", "commit_message"],
  },
};

/** Helper icon-lookup tool — not a patch grammar, attached to the same LLM turn. */
export const GET_ICONS_TOOL: LLMToolDef = {
  name: "get_available_icons",
  description: 'List all 185 available Lucide icon names for the <Icon name="..."> component.',
  parameters: { type: "object", properties: {} },
};

/**
 * Component-docs fetch tool (tool-driven primitive docs). Advertised
 * alongside `apply_changes` when `ContextPolicy.primitiveIndex` is
 * active (a compact name+description index replaces the full ~130KB
 * primitives doc in the system prompt; the LLM fetches the full
 * per-component API on demand).
 *
 * The handler lives in `coding-agent/tools.ts` under the
 * `get_components_info` case.
 */
export const GET_COMPONENTS_INFO_TOOL: LLMToolDef = {
  name: "get_components_info",
  description:
    "Fetch full prop API + example + variant mappings for one or more design-system components. Use when the compact index doesn't give you enough detail to write correct JSX (e.g., you need to know the exact prop values for `variant` or the shape of an options array). Batch names in one call — cheaper than multiple fetches.",
  parameters: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description:
          "Component names to fetch (e.g., ['Card', 'Stack', 'Input']). Names must match the index entries exactly.",
      },
    },
    required: ["names"],
  },
};

/**
 * Plan-commitment tool.
 *
 * Forced on turn 2 when the harness runs the `fetch → plan → write`
 * pipeline. After turn-1 fetching, the LLM must produce a short
 * structured plan before any apply_changes is allowed. The plan
 * echoes back in the tool result so turn 3+ patches can reference it —
 * this breaks fetch-loops where the model over-fetches without
 * committing to a structure.
 */
export const WRITE_PLAN_TOOL: LLMToolDef = {
  name: "write_plan",
  description:
    "Commit to a concrete plan before writing code. Produce a short structured outline: which components you'll use, rough JSX structure, and wiring (state/actions/streams). After this call, on the next turn you'll be able to write code with `apply_changes`. Keep it brief — this is a commitment, not a design doc.",
  parameters: {
    type: "object",
    properties: {
      components: {
        type: "array",
        items: { type: "string" },
        description:
          "Primitive/component names you'll use in the final JSX (e.g., ['Card', 'Stack', 'Input', 'Button']).",
      },
      structure: {
        type: "string",
        description:
          "Brief JSX structure outline — a few lines of pseudocode showing nesting. Example: 'Card > Stack > [Heading, Input x3, Button].'",
      },
      wiring: {
        type: "string",
        description:
          "Brief note on state/actions/streams you'll wire. Example: 'useState for form payload; invokeAction(submit) on Button click.'",
      },
    },
    required: ["components", "structure", "wiring"],
  },
};

/**
 * Full-file write tool. Flat JSON payload (two top-level strings) — much
 * easier for brittle tool-call serializers (e.g., Google Gemini Flash-Lite)
 * than `apply_changes`' nested array-of-objects-of-arrays-of-strings.
 *
 * Offered alongside `apply_changes` on turn 1 so the LLM can pick whichever
 * shape it emits more reliably. On patch-repair turns, `apply_changes` is
 * preferred (minimal diff, preserves session), but turn-1 has no existing
 * scaffold state to preserve — write is equivalent semantically.
 *
 * Implementation note: `executeTool` in `coding-agent/tools.ts`
 * already handles the `write` case; the harness just needs to
 * advertise it to the LLM.
 */
export const REWRITE_TOOL: LLMToolDef = {
  name: "rewrite",
  description:
    "Escape hatch: rewrite the entire ui.tsx file in one call. Use only when surgical `apply_changes` patches have accumulated into a tangled broken state and you need to reset the file to a clean implementation. Single-string payload; auto-compiles + validates. Prefer `apply_changes` for normal edits.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "Complete TSX component source — the whole file.",
      },
      commit_message: {
        type: "string",
        description: "Short description (< 10 words)",
      },
    },
    required: ["code", "commit_message"],
  },
};
