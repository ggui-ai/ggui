// packages/protocol/src/gadgets/stdlib-gadgets.test.ts
//
// Internal consistency checks on the stdlib gadget descriptor
// list. Cross-package parity (hooks match the actual exports of
// `@ggui-ai/gadgets`) lives in that package's
// `stdlib-parity.test.ts`; this test covers the protocol-internal
// invariants.
//
// Slice GG.8.1 — `STDLIB_GADGETS` is now a 1-element array: the
// `@ggui-ai/gadgets` package descriptor whose `exports` array carries
// the stdlib hook exports. The per-hook teaching text moved onto each
// `exports[*]`.

import { describe, expect, it } from 'vitest';
import {
  STDLIB_GADGETS,
  STDLIB_GADGETS_PACKAGE,
  STDLIB_GADGET_HOOKS,
} from './stdlib-gadgets';
import { strictGadgetDescriptorSchema } from '../schemas/data-contract';
import { gadgetExportName } from './resolve-contract-gadgets';
import type { GadgetHookExport } from '../types/data-contract';

/** Every export across every stdlib package descriptor. */
const allExports = STDLIB_GADGETS.flatMap((pkg) => pkg.exports);
/**
 * Every hook export across every stdlib package descriptor.
 * `GadgetExport` is a type-exclusive union discriminated by VALUE
 * presence — `exp.hook !== undefined` narrows to
 * {@link GadgetHookExport} (no `kind` field; `hook` is an optional
 * `never` key of the component member, so `'hook' in exp` no longer
 * narrows on its own).
 */
const hookExports = allExports.filter(
  (exp): exp is GadgetHookExport => exp.hook !== undefined,
);

describe('STDLIB_GADGETS', () => {
  it('declares at least one gadget package descriptor', () => {
    expect(STDLIB_GADGETS.length).toBeGreaterThan(0);
  });

  it('declares at least one export per descriptor', () => {
    for (const pkg of STDLIB_GADGETS) {
      expect(pkg.exports.length).toBeGreaterThan(0);
    }
  });

  it('every export carries a non-empty field-presence-discriminated name', () => {
    for (const exp of allExports) {
      const name = gadgetExportName(exp);
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('every hook name starts with `use` and a capital letter', () => {
    for (const exp of hookExports) {
      expect(exp.hook).toMatch(/^use[A-Z]/);
    }
  });

  it('every descriptor declares the stdlib package as its identity', () => {
    for (const pkg of STDLIB_GADGETS) {
      expect(pkg.package).toBe(STDLIB_GADGETS_PACKAGE);
    }
  });

  it('export names are unique across the catalog', () => {
    const names = allExports.map(gadgetExportName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('hook names are alphabetically sorted (stable diff across minor bumps)', () => {
    const names = hookExports.map((exp) => exp.hook);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('every export has a description string', () => {
    for (const exp of allExports) {
      expect(typeof exp.description).toBe('string');
      expect(exp.description!.length).toBeGreaterThan(0);
    }
  });

  it('every export has a usage string', () => {
    for (const exp of allExports) {
      expect(typeof exp.usage).toBe('string');
      expect(exp.usage!.length).toBeGreaterThan(0);
    }
  });

  it('STDLIB_GADGET_HOOKS is consistent with the descriptor list', () => {
    const fromExports = new Set(hookExports.map((exp) => exp.hook));
    expect(STDLIB_GADGET_HOOKS).toEqual(fromExports);
  });

  it('STDLIB_GADGETS_PACKAGE is the canonical scope', () => {
    expect(STDLIB_GADGETS_PACKAGE).toMatch(/^@ggui-ai\//);
  });

  // Audit Issue 14 (2026-05-18) — guards against stdlib drift past the
  // strict `strictGadgetDescriptorSchema`. P2-G34 (cloud + OSS read paths)
  // relies on this round-trip: a stdlib descriptor that fails the strict
  // schema would silently demote every read from `App.gadgets` to a
  // broken fallback. Failing the test here catches the drift the
  // moment a new STDLIB export is added without the required
  // teaching text + package/version coordinates.
  it('every descriptor round-trips through strictGadgetDescriptorSchema.parse', () => {
    for (const pkg of STDLIB_GADGETS) {
      // Throws ZodError on failure — vitest renders the path + issue
      // list so the diff against a passing baseline is one read.
      expect(() => strictGadgetDescriptorSchema.parse(pkg)).not.toThrow();
    }
  });
});
