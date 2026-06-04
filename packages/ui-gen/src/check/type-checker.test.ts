// packages/ui-gen/src/check/type-checker.test.ts
//
// Unit tests for the virtual-filesystem TypeScript type-checker.
//
// Promoted from `core/src/tools/type-checker.test.ts` as part of the
// OSS tier-0 CHECK migration. Original `describe('typecheck')`
// block kept verbatim; the companion E2E block (which exercised
// `createGeneratorTools` from `core/src/adapters/tools.ts`) relocates to
// `core/src/adapters/tools.test.ts` in the same commit — it was
// covering handler-level integration, not `typecheck` itself.
//
// These tests exercise the real on-disk `.d.ts` corpus: typescript's
// `lib.*.d.ts` (resolved via `createRequire`), hoisted `@types/react`
// under `.pnpm/@types+react@*`, and the design + wire package dists
// under `packages/{design,wire}/dist`. The migration changed the
// workspace-root anchor from `../../..` to `../../../..` — if the
// anchor drift is wrong, these tests fail with either "Cannot find
// module 'react'" errors or missing-type diagnostics on every @ggui-ai
// import.

import { describe, it, expect } from 'vitest';
import { typecheck } from './type-checker.js';

describe('typecheck', () => {
  // ---- VFS Loading ----
  describe('VFS loading', () => {
    it('should return a defined result without throwing for simple code', async () => {
      const result = await typecheck('const x = 1;');
      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(result.warnings).toBeDefined();
    });
  });

  // ---- Module Resolution ----
  describe('module resolution', () => {
    it('should resolve react imports', async () => {
      const code = `
        import React, { useState } from 'react';
        const [val, setVal] = useState(0);
      `;
      const result = await typecheck(code);
      // No "Cannot find module 'react'" error
      const moduleErrors = result.errors.filter((e) => e.code === 2307);
      expect(moduleErrors).toHaveLength(0);
    });

    it('should resolve @ggui-ai/design/primitives imports', async () => {
      const code = `
        import { Card, Text, Button } from '@ggui-ai/design/primitives';
      `;
      const result = await typecheck(code);
      const moduleErrors = result.errors.filter((e) => e.code === 2307);
      expect(moduleErrors).toHaveLength(0);
    });

    it('should resolve @ggui-ai/design/components imports', async () => {
      const code = `
        import { SearchField, FormField } from '@ggui-ai/design/components';
      `;
      const result = await typecheck(code);
      const moduleErrors = result.errors.filter((e) => e.code === 2307);
      expect(moduleErrors).toHaveLength(0);
    });

    it('should resolve @ggui-ai/design/compositions imports', async () => {
      const code = `
        import { Header, Modal } from '@ggui-ai/design/compositions';
      `;
      const result = await typecheck(code);
      const moduleErrors = result.errors.filter((e) => e.code === 2307);
      expect(moduleErrors).toHaveLength(0);
    });

    it('should surface unknown modules as warnings (not blocking errors)', async () => {
      // type-checker.ts BLOCKING_CODES deliberately demotes TS2307 ("Cannot
      // find module") from blocking to non-blocking. Lambda bundles strip
      // type declarations so the VFS can't resolve react/@ggui-ai/design;
      // forbidden-import enforcement lives in runSelfChecks regex instead.
      // Diagnostic is still surfaced — just as a warning.
      const code = `
        import { Something } from 'unknown-module';
      `;
      const result = await typecheck(code);
      const moduleErrors = result.errors.filter((e) => e.code === 2307);
      const moduleWarnings = result.warnings.filter((e) => e.code === 2307);
      expect(moduleErrors).toHaveLength(0);
      expect(moduleWarnings.length).toBeGreaterThan(0);
    });
  });

  // ---- Tiered Diagnostics ----
  describe('tiered diagnostics', () => {
    it('should flag wrong prop types as blocking errors', async () => {
      const code = `
        import { Button } from '@ggui-ai/design/primitives';
        const variant: "invalid" = "invalid";
        const el = <Button variant={variant} />;
      `;
      const result = await typecheck(code);
      // variant="invalid" is not assignable to the Button variant union type
      const typeErrors = result.errors.filter(
        (e) => e.code === 2322 || e.code === 2769,
      );
      expect(typeErrors.length).toBeGreaterThan(0);
    });

    it('should NOT flag unused variables as blocking errors', async () => {
      const code = `
        const unusedVar = 42;
      `;
      const result = await typecheck(code);
      // Unused variables (6133) are NOT in BLOCKING_CODES
      expect(result.errors).toHaveLength(0);
    });

    it('should produce zero errors for valid code', async () => {
      const code = `
        const x: number = 42;
        const y: string = 'hello';
      `;
      const result = await typecheck(code);
      expect(result.errors).toHaveLength(0);
    });

    it('reports possible undefined access as blocking error', async () => {
      const result = await typecheck(`
        import React from 'react';
        interface Props { value?: string; }
        export default function Hello({ value }: Props) {
          return <div>{value.toLowerCase()}</div>;
        }
      `);
      // strictNullChecks should catch this as a blocking error (causes runtime crash)
      const nullErrors = result.errors.filter(e => e.code === 18048 || e.code === 18047);
      expect(nullErrors.length).toBeGreaterThan(0);
    });

    it('should include fix strings on diagnostics', async () => {
      const code = `
        import { NonExistent } from '@ggui-ai/design/primitives';
      `;
      const result = await typecheck(code);
      // Should get 2305 (Module has no exported member) with a fix string
      const relevant = [...result.errors, ...result.warnings].filter(
        (e) => e.code === 2305 || e.code === 2304,
      );
      expect(relevant.length).toBeGreaterThan(0);
      for (const d of relevant) {
        expect(d.fix).toBeTruthy();
        expect(typeof d.fix).toBe('string');
      }
    });
  });

  // ---- Valid Component ----
  describe('valid component', () => {
    it('should produce zero errors for a full component using Card, Stack, Text, Button', async () => {
      const code = `
        import { useState } from 'react';
        import { Card, Stack, Text, Button } from '@ggui-ai/design/primitives';

        interface Props {
          title: string;
          onAction: () => void;
        }

        export default function MyComponent({ title, onAction }: Props) {
          const [count, setCount] = useState(0);

          return (
            <Card padding={24} shadow="md">
              <Stack gap={16}>
                <Text size="xl" weight="bold">{title}</Text>
                <Text tone="muted">Count: {count}</Text>
                <Button
                  variant="primary"
                  onClick={() => {
                    setCount(count + 1);
                    onAction();
                  }}
                >
                  Increment
                </Button>
              </Stack>
            </Card>
          );
        }
      `;
      const result = await typecheck(code);
      expect(result.errors).toHaveLength(0);
    });
  });

  // `loadGadgets()` is retired. Generated component code
  // direct-imports gadget exports: STDLIB hooks from `@ggui-ai/gadgets`
  // (the package's shipped `.d.ts` lands in the VFS unconditionally)
  // and third-party hooks from their own package specifier (resolved
  // against the wrapper's real `.d.ts`, overlaid via the `dtsMap`
  // param at `node_modules/<package>/index.d.ts`).
  describe('gadgets module resolution (direct imports)', () => {
    it('resolves a direct STDLIB import from `@ggui-ai/gadgets` without TS2307', async () => {
      const code = `
        import { useGeolocation } from '@ggui-ai/gadgets';
        const geo = useGeolocation();
      `;
      const result = await typecheck(code);
      const moduleErrors = result.errors.filter((e) => e.code === 2307);
      expect(moduleErrors).toHaveLength(0);
    });

    it('STDLIB hook resolves as a direct named export with real typing', async () => {
      const code = `
        import { useGeolocation } from '@ggui-ai/gadgets';
        export default function C() {
          const geo = useGeolocation();
          return <div>{geo.status}</div>;
        }
      `;
      const result = await typecheck(code);
      // `useGeolocation` is a plain named export of `@ggui-ai/gadgets`
      // — no TS2305 (no exported member) and no TS2339 ("Property does
      // not exist") for the hook itself. The lifecycle envelope's
      // `.status` is reachable on the real `GadgetHook` return type.
      const hookErrors = result.errors.filter(
        (e) =>
          (e.code === 2305 || e.code === 2339 || e.code === 2304) &&
          /useGeolocation/.test(e.message),
      );
      expect(hookErrors).toHaveLength(0);
      const statusErrors = result.errors.filter(
        (e) => e.code === 2339 && /status/.test(e.message),
      );
      expect(statusErrors).toHaveLength(0);
    });

    it('a non-existent STDLIB export surfaces a blocking TS2305', async () => {
      // `useNotAHook` is not exported by `@ggui-ai/gadgets`. The
      // package's `.d.ts` IS in the VFS (the module resolves), so a
      // missing named export is a blocking TS2305 ("Module has no
      // exported member") — not a silently-tolerated TS2307.
      const code = `
        import { useNotAHook } from '@ggui-ai/gadgets';
        export default function C() {
          return <div>{String(useNotAHook)}</div>;
        }
      `;
      const result = await typecheck(code);
      const missingExport = result.errors.find((e) => e.code === 2305);
      expect(missingExport?.message ?? '').toMatch(/useNotAHook/);
    });

    it('a third-party gadget import with no dtsMap entry collapses to TS2307 (non-blocking)', async () => {
      // The wrapper package is NOT in the VFS (no `dtsMap` overlay),
      // so `import { useLeafletMap } from '@ggui-samples/gadget-leaflet'`
      // resolves to nothing. TS2307 ("Cannot find module") is
      // deliberately non-blocking — degraded UX (the hook is `any`),
      // but not a generation blocker. The fix is to thread `gadgetTypes`.
      const code = `
        import { useLeafletMap } from '@ggui-samples/gadget-leaflet';
        export default function C() {
          const map = useLeafletMap();
          return <div>{String(map)}</div>;
        }
      `;
      const result = await typecheck(code);
      const moduleErrors = result.errors.filter((e) => e.code === 2307);
      expect(moduleErrors).toHaveLength(0);
      const moduleWarnings = result.warnings.filter((e) => e.code === 2307);
      expect(moduleWarnings.length).toBeGreaterThan(0);
    });

    // Third-party-wrapper STRICT typing via direct imports.
    // The render handler fetches each non-stdlib gadget's `.d.ts` and
    // threads it through `typecheck`'s `dtsMap` param. The `.d.ts` is
    // overlaid at `node_modules/<package>/index.d.ts`, so a generated
    // `import { useLeafletMap } from '@ggui-samples/gadget-leaflet'`
    // resolves through the bare-specifier branch directly against the
    // real wrapper declaration — named option/return types preserved.
    // A wrong-typed call surfaces a blocking TS error instead of
    // collapsing to `any`.
    const LEAFLET_DTS = `
      export interface LeafletMapOptions {
        center: [number, number];
        zoom: number;
      }
      export interface GadgetHookResult<T> {
        value: T | undefined;
        status: 'idle' | 'prompting' | 'active' | 'completed' | 'denied' | 'error';
        error?: Error;
      }
      export interface LeafletMapValue {
        containerRef: (el: HTMLDivElement | null) => void;
      }
      export declare const useLeafletMap: (
        options?: LeafletMapOptions,
      ) => GadgetHookResult<LeafletMapValue>;
    `;

    it('dtsMap overlay surfaces a wrong-typed wrapper-hook call as a blocking error', async () => {
      const code = `
        import { useLeafletMap } from '@ggui-samples/gadget-leaflet';
        export default function C() {
          // zoom must be a number — passing a string is a type error.
          const map = useLeafletMap({ center: [0, 0], zoom: 'not-a-number' });
          return <div>{String(map)}</div>;
        }
      `;
      const result = await typecheck(code, {
        '@ggui-samples/gadget-leaflet': LEAFLET_DTS,
      });
      // The mistyped `zoom` surfaces as a blocking diagnostic — TS2322
      // (type not assignable) or TS2769 (no overload matches).
      const typeError = result.errors.find(
        (e) => e.code === 2322 || e.code === 2769,
      );
      expect(typeError).toBeDefined();
      expect(typeError?.message ?? '').toMatch(/zoom|number|string/i);
    });

    it('dtsMap overlay typechecks a correctly-typed wrapper-hook call clean', async () => {
      const code = `
        import { useLeafletMap } from '@ggui-samples/gadget-leaflet';
        export default function C() {
          const map = useLeafletMap({ center: [37.77, -122.41], zoom: 12 });
          return <div ref={map.value?.containerRef} />;
        }
      `;
      const result = await typecheck(code, {
        '@ggui-samples/gadget-leaflet': LEAFLET_DTS,
      });
      // A correctly-typed call against the overlaid `.d.ts` produces no
      // blocking type errors on the `useLeafletMap` call.
      const callErrors = result.errors.filter(
        (e) =>
          (e.code === 2322 || e.code === 2769 || e.code === 2339) &&
          /useLeafletMap|zoom|center/.test(e.message),
      );
      expect(callErrors).toHaveLength(0);
    });
  });
});
