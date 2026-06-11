/**
 * `ggui.ui.json` v1 — per-UI manifest, colocated with source.
 *
 * One of three file-format surfaces in the ggui manifest model (see
 * `schema.ts` header for the full context). Each authored UI ships
 * its own `ggui.ui.json` next to its TSX source:
 *
 * ```
 * ui/weather-card/
 * ├── ggui.ui.json        ← this file
 * └── index.tsx
 * ```
 *
 * The root `ggui.json`'s `blueprints.include` globs index these
 * files at OSS-server boot. The `id` field is the stable identifier
 * that crosses source boundaries — it's how publish, pull, conflict
 * detection, and agent references address a UI independent of path
 * or display name.
 *
 * **Identity rules:**
 *
 * 1. `id` is **required**. Zero-config isn't allowed here — a UI
 *    without an id can't be published, pulled, or referenced.
 * 2. `id` is **stable across content edits**. Do NOT derive it from
 *    `contentHash` (which changes on every edit) or the display
 *    name (which is user-editable prose).
 * 3. `id` is **machine-oriented**. Lowercase-ish, URL-safe. Not a
 *    UUID requirement — any stable-ish identifier works — but it
 *    must be grep-friendly, not a human display name.
 * 4. `id` is **not path-derived**. Renaming or moving a UI file
 *    MUST NOT invalidate references. The id follows the UI.
 *
 * `contentHash` stays as a separate, derived field. It versions the
 * compiled artifact and drives conflict detection on publish. It is
 * NOT the identity.
 */
import { z } from 'zod';
import type { DataContract } from '@ggui-ai/protocol';

/**
 * Stable UI identity — lowercase-ish, URL-safe, ≤128 chars. Accepts
 * letters, digits, hyphens, underscores, dots, and colons (for
 * scoping like `company:weather-card`). Deliberately permissive
 * enough to admit common conventions (uuids, nanoids, slug-like ids)
 * without forcing one shape.
 *
 * Rejects whitespace, slashes, and unprintables so file paths can
 * safely embed the id without escaping.
 */
const UiIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, {
    message:
      'ggui.ui.json.id must be 1-128 chars of A-Za-z0-9 plus . _ : -, starting with an alphanumeric.',
  });

/**
 * UI class — matches `UiClass` from `@ggui-ai/protocol` (vocabulary
 * owned there so the `classifyUi()` runtime classifier can ship
 * without a reverse dep on this package).
 */
const UiClassSchema = z.union([z.literal('sandboxed'), z.literal('fullstack')]);

/**
 * Per-UI manifest schema. Strict-object for v1 — unknown fields
 * fail parse. Additive fields land as coordinated schema changes.
 */
export const UiManifestV1 = z.strictObject({
  /** Stable identity. See identity rules in module docstring. */
  id: UiIdSchema,

  /** Human-readable name (e.g., "Weather Card", "Kanban Board"). */
  name: z.string().min(1).max(120),

  /** One-line description of what this UI does. */
  description: z.string().max(500).optional(),

  /** Data contract: propsSpec, actionSpec, streamSpec, contextSpec, agentCapabilities/clientCapabilities. */
  contract: z.custom<DataContract>((v) => typeof v === 'object' && v !== null),

  /** Category for browsing/filtering (e.g., "dashboard", "form", "data-viz"). */
  category: z.string().max(60).optional(),

  /** Phrases that help blueprint-first matching find this UI. */
  matchPatterns: z.array(z.string().min(1)).optional(),

  // ── MCP Pairing (optional) ─────────────────────────────────────────

  /** MCP tool names this UI is designed for. Used for discovery-layer matching. */
  mcpTools: z.array(z.string().min(1)).optional(),

  /** MCP server name this UI is optimized for (e.g., "github", "stripe"). */
  mcpServer: z.string().min(1).optional(),

  // ── Classification & Lineage ───────────────────────────────────────

  /** UI class: sandboxed (portable) or fullstack (requires client bundle). */
  uiClass: UiClassSchema.optional(),

  /** Content hash of the compiled ESM output — versions the artifact.
   * Derived, not authored. NOT the identity (see `id`). */
  contentHash: z.string().min(1).optional(),

  /** Parent content hash (for exported → modified → re-registered lineage). */
  parentHash: z.string().min(1).optional(),

  /** Source entry point relative to project root (e.g., "src/component.tsx"). */
  entryPoint: z.string().min(1).optional(),
});

/** Static TypeScript type derived from the v1 schema. */
export type UiManifestV1 = z.infer<typeof UiManifestV1>;

/**
 * Canonical type alias — `UiManifest` is the term used in protocol
 * docs, code, and plan docs. `UiManifestV1` is the version-pinned
 * name. Both resolve to the same shape; consumers may import either.
 */
export type UiManifest = UiManifestV1;

/**
 * Canonical filename for the per-UI manifest. Always this name,
 * always colocated with the UI's source. Exported so tooling uses
 * the constant instead of hard-coding the string.
 */
export const GGUI_UI_JSON_FILENAME = 'ggui.ui.json';

/**
 * Parse a raw JSON value into a validated {@link UiManifest}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 */
export function parseUiManifest(raw: unknown): UiManifest {
  return UiManifestV1.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result.
 * Prefer this inside CLI tooling where you want to render the issue
 * list without try/catch.
 */
export function safeParseUiManifest(
  raw: unknown,
): ReturnType<typeof UiManifestV1.safeParse> {
  return UiManifestV1.safeParse(raw);
}
