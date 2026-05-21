/**
 * ggui_render_blueprint — resolve a registered blueprint to its
 * compiled bundle.
 *
 * Given a `blueprintId` (the stable identity from
 * `ggui.ui.json#id`), the handler:
 *
 *   1. Looks up the manifest entry via `UiRegistry.get(id)`. Unknown
 *      id → throw with a clear error.
 *   2. Fetches the compiled bundle via `UiRegistry.getBundle(id)`.
 *      The reference OSS registry (`@ggui-ai/dev-stack::
 *      LocalUiRegistry`) compiles on demand from the colocated TSX
 *      entry via esbuild. A registry that has no bundle for the id
 *      (source-only dev, compile-failed) returns `undefined`; the
 *      handler surfaces that as a distinct error.
 *   3. Reads the bundle to a string. The `UiBundle.code` field is
 *      `string | ReadableStream`; a streaming bundle is materialized
 *      here so the MCP wire gets a single JSON field.
 *   4. Returns `{blueprintId, blueprintName, code, contentType}` inline.
 *
 * ## Why the factory shape (vs. the old deprecation shim)
 *
 * The pre-2026-04-22 handler was a always-throws deprecation shim with
 * the explanation "use ggui_push — the generator will render it". That
 * collapsed the registered-blueprint path onto generation, which in
 * turn required BYOK + an LLM round-trip even for authored UIs that
 * were already fully compiled. This factory restores the direct path:
 * a registered blueprint, a compile, a componentCode — no LLM.
 *
 * ## Why inline code instead of a signed URL
 *
 * Hosted S3 with signed URLs is a deployment detail, not a protocol
 * shape. The OSS server has no object-store layer. Inline JS keeps the
 * contract single-shot and self-contained for both deployment modes.
 * If/when a hosted signed-URL variant returns, it layers on optional
 * fields; today the inline shape is the baseline.
 *
 * ## Zero-config fallback
 *
 * `createRenderBlueprintHandler` is a factory — dependencies are
 * required. `createGguiServer` registers the handler only when a
 * `UiRegistry` is wired. A server booted without a registry (legacy
 * hosted config, minimal embedded case) does NOT register the tool at
 * all, rather than shipping a tool that throws on every call. The
 * previous "always throw" shape was the worst of both worlds — tool
 * surface advertised, zero functionality — and is retired here.
 */
import { z } from 'zod';
import type { UiRegistry } from '@ggui-ai/ui-registry';
import type { GguiRenderBlueprintOutput } from '@ggui-ai/protocol';
import type { SharedHandler } from '../types.js';

const inputSchema = {
  blueprintId: z
    .string()
    .min(1)
    .describe(
      'The stable blueprint id declared via ggui.ui.json#id. Must match an entry in this server\'s UI registry.',
    ),
};

const outputSchema = {
  blueprintId: z.string(),
  blueprintName: z.string(),
  code: z.string(),
  contentType: z.string(),
};

/** Deps for {@link createRenderBlueprintHandler}. */
export interface RenderBlueprintDeps {
  /**
   * UI registry that resolves `blueprintId → (manifest, bundle)`. For
   * OSS the reference impl is `@ggui-ai/dev-stack::LocalUiRegistry`
   * (manifest-backed, compile-on-demand via esbuild). Any
   * `UiRegistry` implementation works — hosted can plug in a
   * signed-URL-aware registry without changing the handler.
   */
  readonly uiRegistry: UiRegistry;
}

/**
 * Build a render-blueprint handler bound to a concrete `UiRegistry`.
 * The handler is ONLY useful when the registry can resolve ids — a
 * caller booting without one should omit this handler entirely rather
 * than constructing it with a no-op registry.
 */
export function createRenderBlueprintHandler(
  deps: RenderBlueprintDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiRenderBlueprintOutput> {
  return {
    name: 'ggui_render_blueprint',
    title: 'Render blueprint',
    audience: ['agent'],
    description:
      "Render a registered blueprint (ggui.json#blueprints.include → ggui.ui.json) into its compiled JS bundle. Returns inline `code` + `contentType` — the caller mounts it directly. Fails with a clear error when the id is unknown or the registry has no bundle available (source-only dev, compile-failed).",
    inputSchema,
    outputSchema,
    async handler(rawInput: Record<string, unknown>): Promise<GguiRenderBlueprintOutput> {
      const { blueprintId } = z.object(inputSchema).parse(rawInput);

      const entry = await deps.uiRegistry.get(blueprintId);
      if (!entry) {
        throw new Error(
          `ggui_render_blueprint: no blueprint registered with id "${blueprintId}". ` +
            `Check ggui.json#blueprints.include globs + ggui.ui.json#id values.`,
        );
      }

      const bundle = await deps.uiRegistry.getBundle(blueprintId);
      if (!bundle) {
        throw new Error(
          `ggui_render_blueprint: blueprint "${blueprintId}" (${entry.manifest.name}) has no bundle available. ` +
            `Either the TSX entry is missing (check the manifest directory for a \`ggui.ui.tsx\` / \`index.tsx\` / \`component.tsx\` file or a \`manifest.entryPoint\` pointer), or compile-on-demand failed.`,
        );
      }

      const code = await materializeCode(bundle.code);
      return {
        blueprintId,
        blueprintName: entry.manifest.name,
        code,
        contentType: bundle.contentType,
      };
    },
  };
}

/**
 * Materialize a `UiBundle.code` to a plain string. `UiRegistry.getBundle`
 * allows `code: string | ReadableStream` for cloud origins that stream
 * large bundles; the reference OSS impl always returns strings. We
 * collapse the union here because the MCP wire carries a single JSON
 * field, not a streamed response.
 */
async function materializeCode(code: string | ReadableStream): Promise<string> {
  if (typeof code === 'string') return code;
  const reader = code.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let result = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (typeof value === 'string') {
      result += value;
    } else if (value instanceof Uint8Array) {
      chunks.push(value);
    }
  }
  if (chunks.length > 0) {
    for (const chunk of chunks) result += decoder.decode(chunk, { stream: true });
    result += decoder.decode();
  }
  return result;
}
