/**
 * `@ggui-ai/gadgets/codegen` — wrapper-author build helper.
 *
 * Emits `descriptor.json` for registry consumption ({@link
 * writeDescriptorJson}). A gadget wrapper's type narrowing comes from
 * its own real `.d.ts` (emitted by `tsc --declaration` / `tsup --dts`)
 * — the registry serves it via `typesUrl`, and the code-gen sandbox
 * overlays it per-package so a direct `import { useLeafletMap } from
 * '@scope/wrapper-leaflet'` resolves against the strict hook
 * signatures. Gadgets are direct-imported — one idiom with the design
 * primitives — so there is no catalog-augmentation codegen step.
 *
 * This file is Node-only — it uses `node:fs/promises`. The codegen
 * lives at a separate entry (`@ggui-ai/gadgets/codegen`) so the
 * browser-runtime bundle's import graph stays minimal.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GadgetDescriptor } from '@ggui-ai/protocol';

/**
 * Emit `descriptor.json` for registry consumption.
 *
 * Wrapper authors structure their build like:
 *
 * ```ts
 * // build.ts
 * import { writeDescriptorJson } from '@ggui-ai/gadgets/codegen';
 * import { useLeafletMap } from './src/index';
 *
 * await writeDescriptorJson({
 *   descriptors: [useLeafletMap.descriptor],
 *   outputPath: 'dist/descriptor.json',
 * });
 * ```
 *
 * The author's build is responsible for type metadata: run
 * `tsup --dts` (or `tsc --declaration`) to emit the wrapper's
 * `.d.ts`, compute its SHA-384 SRI, and set `typesUrl` + `typesSri`
 * on each descriptor BEFORE calling this helper. `writeDescriptorJson`
 * itself is pure I/O + validation — no TS Compiler API, no signature
 * extraction. Type narrowing is sourced from the real emitted `.d.ts`
 * file, not an inline signature string.
 *
 * The helper:
 *   1. Validates each descriptor against
 *      `registeredGadgetDescriptorSchema` (every registered descriptor
 *      MUST pass — same gate the `App.gadgets` registration handler
 *      applies, including the `typesUrl`-required refinement for
 *      non-stdlib gadgets).
 *   2. Writes a JSON document `{ version: 'gg2', descriptors: [...] }`.
 */
export interface WriteDescriptorJsonInput {
  /**
   * Descriptors authored via `createGguiGadget(...).descriptor` (or
   * hand-written), with `typesUrl` + `typesSri` already populated by
   * the wrapper build.
   */
  readonly descriptors: readonly GadgetDescriptor[];
  /**
   * Output path for the JSON document. Parent directories are
   * created as needed.
   */
  readonly outputPath: string;
}

/**
 * Output payload of {@link writeDescriptorJson}. Returned for tests
 * + callers that want to introspect the validated descriptors without
 * re-reading the file.
 */
export interface DescriptorJsonDocument {
  /** Schema-format marker for the descriptor.json document. */
  readonly version: 'gg2';
  /** Strict-validated descriptors. */
  readonly descriptors: readonly GadgetDescriptor[];
}

export async function writeDescriptorJson(
  input: WriteDescriptorJsonInput,
): Promise<DescriptorJsonDocument> {
  const { descriptors, outputPath } = input;

  const { registeredGadgetDescriptorSchema } = await import(
    '@ggui-ai/protocol'
  );
  const validated: GadgetDescriptor[] = [];
  for (const descriptor of descriptors) {
    // Registration-validate — catches typos, missing required teaching
    // text, a missing `typesUrl` on a non-stdlib wrapper, or other
    // registry violations BEFORE we write the JSON.
    const parsed = registeredGadgetDescriptorSchema.safeParse(descriptor);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new Error(
        `writeDescriptorJson: descriptor for package '${descriptor.package}@${descriptor.version}' failed strict validation:\n${issues}`,
      );
    }
    validated.push(parsed.data);
  }

  const document: DescriptorJsonDocument = {
    version: 'gg2',
    descriptors: validated,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(document, null, 2)}\n`,
    'utf8',
  );
  return document;
}
