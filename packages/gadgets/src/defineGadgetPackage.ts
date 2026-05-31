/**
 * `defineGadgetPackage` — the wrapper-author SDK builder for a gadget
 * PACKAGE that ships one or more exports, hooks AND/OR components,
 * behind a single npm identity.
 *
 * Where {@link createGguiGadget} is the single-hook convenience (the
 * common case — returns the callable hook with `.descriptor` grafted
 * on), `defineGadgetPackage` is the general builder: it takes the
 * package identity + transport metadata once, plus a list of export
 * declarations, and returns the validated {@link GadgetDescriptor}.
 *
 * A gadget package mixing kinds — say a chart package exporting a
 * `Chart` component + a `useChartTheme` hook — is exactly one
 * descriptor with two `exports[]`. Authoring it:
 *
 *   ```ts
 *   export const Chart: ComponentType<ChartProps> = (props) => { … };
 *   export const useChartTheme: GadgetHook<ChartTheme> = () => { … };
 *
 *   export const chartDescriptor = defineGadgetPackage({
 *     package: '@my-org/gadget-chart',
 *     version: '0.0.1',
 *     styleUrl: 'https://…/chart.css',
 *     exports: [
 *       { component: 'Chart', impl: Chart,
 *         description: '…', usage: '…', example: { … } },
 *       { hook: 'useChartTheme', impl: useChartTheme,
 *         description: '…', usage: '…', example: { … } },
 *     ],
 *   });
 *   ```
 *
 * The author exports each impl directly (typed where defined — no
 * casts) and `defineGadgetPackage` produces the registry descriptor.
 * `impl` is threaded purely so the SDK can conformance-check it is a
 * function at module-load (the same fail-fast `createGguiGadget` does
 * for `hookImpl`); the builder never inspects its signature.
 *
 * Throws {@link WrapperConformanceError} synchronously on a malformed
 * spec — a bad package fails at module-load, not at first use.
 */

import {
  strictGadgetDescriptorSchema,
  type GadgetDescriptor,
  type GadgetExport,
  type JsonValue,
} from '@ggui-ai/protocol';
import { WrapperConformanceError } from './createGguiGadget.js';

/**
 * Any callable — a React hook or component. `defineGadgetPackage`
 * conformance-checks `impl` is a function but never depends on its
 * signature, so the broadest "some function" type is correct here
 * (`never[]` params accept any concrete signature without variance
 * friction; it is NOT `any` — the value stays opaque).
 */
export type GadgetImpl = (...args: never[]) => unknown;

/** Per-export teaching text — required for the registry-strict schema. */
interface GadgetExportTeaching {
  /** Human-readable description of what the export does. */
  readonly description: string;
  /** When / why / by-whom the export is used. */
  readonly usage: string;
  /** Concrete usage example for boilerplate + prompt priming. */
  readonly example: JsonValue;
  /** Anti-patterns + known gotchas surfaced in code-gen prompts. */
  readonly gotchas?: string;
  /** Optional Web-Permissions identifier the export gates on. */
  readonly permission?: string;
}

/** A hook export declaration — `use`-prefixed name + its impl. */
export interface GadgetHookExportSpec extends GadgetExportTeaching {
  /** Hook name — `use`-prefixed camelCase (`HOOK_NAME_RE`). */
  readonly hook: string;
  /** The React hook implementation. */
  readonly impl: GadgetImpl;
}

/** A component export declaration — PascalCase name + its impl. */
export interface GadgetComponentExportSpec extends GadgetExportTeaching {
  /** Component name — PascalCase (`COMPONENT_NAME_RE`). */
  readonly component: string;
  /** The React component implementation. */
  readonly impl: GadgetImpl;
}

/**
 * One export of a gadget package — a hook or a component,
 * discriminated by which identifier field is present. Mirrors the
 * protocol's {@link GadgetExport} field-presence union.
 */
export type GadgetExportSpec =
  | GadgetHookExportSpec
  | GadgetComponentExportSpec;

/** Author input to {@link defineGadgetPackage}. */
export interface GadgetPackageSpec {
  /** Bare npm package name. */
  readonly package: string;
  /** Exact semver pin. */
  readonly version: string;
  /** ggui-hosted ESM bundle URL. */
  readonly bundleUrl?: string;
  /** Registry hostname the bundle URL is derived from. */
  readonly bundleHost?: string;
  /** `sha384-<base64>` SRI of the bundle. */
  readonly bundleSri?: string;
  /** Stylesheet URL the package ships. */
  readonly styleUrl?: string;
  /** Outbound origins the package's exports call at runtime (CSP). */
  readonly connect?: readonly string[];
  /** `App.publicEnv` keys the package's exports require. */
  readonly requires?: readonly string[];
  /** Published `.d.ts` URL — required registry-side for non-stdlib. */
  readonly typesUrl?: string;
  /** `sha384-<base64>` SRI of the `.d.ts`. */
  readonly typesSri?: string;
  /** The exports the package ships — at least one, hooks and/or
   * components. */
  readonly exports: readonly GadgetExportSpec[];
}

/**
 * Build + validate a gadget package descriptor. See the file-level
 * docstring for the authoring pattern.
 *
 * Throws {@link WrapperConformanceError} synchronously when the spec
 * is malformed (non-function `impl`, missing teaching text, malformed
 * package identity / export name).
 */
export function defineGadgetPackage(
  spec: GadgetPackageSpec,
): GadgetDescriptor {
  const { exports: exportSpecs, ...packageFields } = spec;

  const violations: Array<{
    path: ReadonlyArray<string | number>;
    message: string;
  }> = [];

  if (exportSpecs.length === 0) {
    violations.push({
      path: ['exports'],
      message: 'a gadget package MUST declare at least one export',
    });
  }

  // Project each author spec into a `GadgetExport`. `impl` is
  // conformance-checked (function shape — zod can't see it) then
  // dropped; the descriptor carries only the serializable export
  // metadata. Optional fields are set only when present so the strict
  // schema's `.strict()` element never sees an explicit `undefined`.
  const exports: GadgetExport[] = exportSpecs.map((entry, index) => {
    if (typeof entry.impl !== 'function') {
      violations.push({
        path: ['exports', index, 'impl'],
        message: '`impl` MUST be a function (a React hook or component)',
      });
    }
    const teaching = {
      description: entry.description,
      usage: entry.usage,
      example: entry.example,
      ...(entry.gotchas !== undefined ? { gotchas: entry.gotchas } : {}),
      ...(entry.permission !== undefined
        ? { permission: entry.permission }
        : {}),
    };
    return 'hook' in entry
      ? { hook: entry.hook, ...teaching }
      : { component: entry.component, ...teaching };
  });

  // Registry conformance: required teaching text per export, a
  // well-formed package identity, and grammar-valid export names
  // (`use`-prefixed hooks / PascalCase components).
  const parsed = strictGadgetDescriptorSchema.safeParse({
    ...packageFields,
    exports,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      violations.push({
        path: issue.path.map((segment) =>
          typeof segment === 'symbol' ? segment.toString() : segment,
        ),
        message: issue.message,
      });
    }
  }

  // Narrow on `parsed.success` directly — throws on any conformance
  // failure and gives `parsed.data` its `GadgetDescriptor` type
  // without a cast.
  if (!parsed.success || violations.length > 0) {
    throw new WrapperConformanceError(spec.package, violations);
  }

  return parsed.data;
}
