// Tool-driven primitive docs.
//
// Replaces the ~130KB `PRIMITIVES_DOCUMENTATION` monolith in the first-turn
// system prompt with a compact name+description index (~3-6KB). The LLM
// fetches full per-component docs on demand via `get_components_info(names[])`
// (already-implemented tool handler in coding-agent/tools.ts).
//
// Two sub-profiles:
//   - "names-only"  — `Card — Container with background + shadow`
//   - "with-props"  — `Card(padding,shadow,border,radius) — Container with ...`
//
// Both preserve `## System Conventions` verbatim (onChange behavior, motion,
// elevation, import constraints) — these are cross-cutting rules the LLM
// needs regardless of primitive selection.
//
// Prepended to the index output: explicit fetch instructions. The initial
// #55 bench showed zero `get_components_info` calls across 108 cells — the
// LLM had the tool but no idea when to use it. #55b adds this preamble so
// the LLM knows to fetch BEFORE writing when enum values / exact prop
// types are unclear. Without this, the index is a trap: LLM guesses prop
// values (size="var(--ggui-font-size-sm)" instead of "sm") and thrashes
// on self-check type errors.

const FETCH_INSTRUCTIONS = `**This is a COMPACT INDEX, not full docs.** Each entry shows the component name${
  // Both modes share this header; the specifics come after.
  ""
} and a one-line description${"" /* prop names appear only in with-props mode, but instructions apply to both */}.

**Before writing JSX**, call \`get_components_info({ names: ["Component1", "Component2", ...] })\` to fetch full prop APIs when you need:
- Exact **enum values** for props like \`size\`, \`variant\`, \`weight\`, \`level\`, \`align\`, \`justify\` (these are string literals like \`"sm"\`, \`"primary"\`, NOT CSS variables)
- **Prop types** (string vs number, required vs optional, whether onChange takes a value or event)
- **Usage examples** for compositions you haven't used before (Modal, Dropdown, Autocomplete, Table, etc.)

**Fetch strategy**:
- **Batch**: one call with 5-10 names is much cheaper than 5 separate calls. Fetch upfront in turn 1 before any apply_changes.
- **Skip when safe**: don't fetch for primitives you're certain about (Text, Button, Stack with default props).
- **Always fetch** when the prop you're about to write is an enum — the index shows which props exist but NOT their allowed values.

**Common mistake to avoid**: don't pass CSS variables (\`"var(--ggui-font-size-sm)"\`) or raw numbers to props that expect enum strings (\`"sm"\`, \`"md"\`). If you're unsure whether a prop takes an enum, fetch.`;

/**
 * Parse `PRIMITIVES_DOCUMENTATION` into a compact index.
 *
 * @param fullDoc — the generated markdown from get-primitives.ts
 * @param mode    — "names-only" or "with-props"
 * @returns the compact index markdown that replaces `## Primitives` /
 *          `## Components` / `## Compositions` sections in the system prompt
 */
export function buildPrimitiveIndex(
  fullDoc: string,
  mode: "names-only" | "with-props",
): string {
  const lines = fullDoc.split("\n");
  const out: string[] = [FETCH_INSTRUCTIONS, ""];

  let currentSection: string | null = null; // "Primitives" | "Components" | "Compositions" | "System Conventions" | null
  let inSystemConventions = false;
  let componentIndex: Array<{ name: string; description: string; props: string[] }> = [];
  let sectionIntroPushed = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Top-level section header: ## X
    if (line.startsWith("## ")) {
      // Flush any pending component section
      if (componentIndex.length > 0 && currentSection) {
        flushComponentSection(out, currentSection, componentIndex, mode);
        componentIndex = [];
      }

      const sectionName = line.slice(3).trim();
      currentSection = sectionName;
      inSystemConventions = sectionName === "System Conventions";

      if (inSystemConventions) {
        // Preserve System Conventions verbatim from here to EOF or next ## header.
        out.push(line);
        i++;
        while (i < lines.length && !lines[i]!.startsWith("## ")) {
          out.push(lines[i]!);
          i++;
        }
        continue;
      }

      // Component-listing sections: keep the header + intro lines until first ###
      out.push(line);
      sectionIntroPushed = true;
      i++;
      while (i < lines.length && !lines[i]!.startsWith("### ") && !lines[i]!.startsWith("## ")) {
        out.push(lines[i]!);
        i++;
      }
      continue;
    }

    // Component subsection: ### Name
    if (line.startsWith("### ") && currentSection && currentSection !== "System Conventions") {
      const name = line.slice(4).trim();

      // Skip "Support Types" subsections entirely in the index
      if (name === "Support Types") {
        i++;
        while (i < lines.length && !lines[i]!.startsWith("### ") && !lines[i]!.startsWith("## ")) {
          i++;
        }
        continue;
      }

      // Capture description + props for this component
      i++;
      const { description, props, nextIdx } = captureComponentMeta(lines, i);
      componentIndex.push({ name, description, props });
      i = nextIdx;
      continue;
    }

    // Uncategorized line (shouldn't happen if doc is well-formed) — preserve
    if (sectionIntroPushed) out.push(line);
    i++;
  }

  // Flush any trailing section
  if (componentIndex.length > 0 && currentSection) {
    flushComponentSection(out, currentSection, componentIndex, mode);
  }

  return out.join("\n");
}

/**
 * Capture a component's first-line description and up to 5 prop names,
 * starting at line index `startIdx` (the line after `### Name`).
 * Returns description text, prop names, and the index of the next section.
 */
function captureComponentMeta(
  lines: readonly string[],
  startIdx: number,
): { description: string; props: string[]; nextIdx: number } {
  let description = "";
  const props: string[] = [];
  let inPropsTable = false;
  let propsTableRowsSeen = 0;

  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i]!;

    // Stop at next section boundary
    if (line.startsWith("### ") || line.startsWith("## ")) break;

    // Description = first non-empty line that isn't a markdown heading/label
    if (!description && line.trim() && !line.startsWith("**") && !line.startsWith("|")) {
      description = extractDescription(line);
    }

    // Detect props table header: `**Props:**`
    if (line.startsWith("**Props:**")) {
      inPropsTable = false; // table rows start 2 lines later
      propsTableRowsSeen = 0;
    }

    // Props table rows: `| propName | type | default | description |`
    if (line.startsWith("| ") && !line.startsWith("|---") && !line.startsWith("| Prop")) {
      if (propsTableRowsSeen === 0) inPropsTable = true;
      if (inPropsTable && props.length < 5) {
        const match = line.match(/^\|\s*(\w+)\s*\|/);
        if (match && match[1]) props.push(match[1]);
      }
      propsTableRowsSeen++;
    }

    i++;
  }

  return { description, props, nextIdx: i };
}

/**
 * Extract a concise description from a line like:
 *   "Button -- A clickable button primitive with multiple variants and sizes."
 *   "Button - Clickable button"
 *   "Button: primitive for clicks"
 * Returns just the description portion without the leading `Name --` prefix.
 */
function extractDescription(line: string): string {
  const trimmed = line.trim();
  // Strip leading "Name --" or "Name -" or "Name:" prefix
  const m = trimmed.match(/^[A-Z][A-Za-z0-9]*\s*(?:--|—|-|:)\s*(.+)$/);
  if (m && m[1]) {
    // Cap length; prefer first sentence
    const desc = m[1].trim();
    const firstSentence = desc.split(/\.\s+/)[0];
    return (firstSentence ?? desc).replace(/\.$/, "");
  }
  // Fallback: return first 80 chars
  return trimmed.slice(0, 80);
}

function flushComponentSection(
  out: string[],
  sectionName: string,
  items: Array<{ name: string; description: string; props: string[] }>,
  mode: "names-only" | "with-props",
): void {
  if (items.length === 0) return;
  out.push("");
  for (const item of items) {
    const signature =
      mode === "with-props" && item.props.length > 0
        ? `${item.name}(${item.props.join(",")})`
        : item.name;
    const desc = item.description ? ` — ${item.description}` : "";
    out.push(`- \`${signature}\`${desc}`);
  }
  out.push("");
  out.push(
    `Call \`get_components_info({ names: ["${items[0]!.name}", ...] })\` for full prop API + examples.`,
  );
}
