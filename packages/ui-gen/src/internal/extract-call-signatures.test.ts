// packages/ui-gen/src/internal/extract-call-signatures.test.ts
//
// Tests for the in-memory `.d.ts` signature extractor.
//
// Pin shape:
//   - Input is a `.d.ts` STRING (not a path) — the consumption-side
//     mirror of the retired `extractGadgetSignatures`.
//   - For each requested hook, the printed value is a self-contained
//     TS function-type expression carrying the param + return shape.
//   - Hooks absent from the `.d.ts` are omitted (no throw).

import { describe, expect, it } from 'vitest';
import {
  extractCallSignaturesFromDts,
  extractComponentPropsFromDts,
} from './extract-call-signatures';

describe('extractCallSignaturesFromDts', () => {
  it('extracts a const-declared hook signature, inlining wrapper-local named types', () => {
    const dts = `
export interface LeafletOptions { center: [number, number]; zoom: number }
export interface LeafletResult {
  value: { lat: number; lng: number } | undefined;
  status: 'idle' | 'active' | 'completed';
}
export declare const useLeafletMap: (
  options?: LeafletOptions,
) => LeafletResult;
`;
    const out = extractCallSignaturesFromDts(dts, ['useLeafletMap']);
    expect(Object.keys(out)).toEqual(['useLeafletMap']);
    const sig = out['useLeafletMap']!;
    // Param shape — wrapper-local `LeafletOptions` is inlined
    // structurally so the prompt line is self-contained.
    expect(sig).toContain('options');
    expect(sig).toContain('center');
    expect(sig).toContain('zoom');
    // Return shape — wrapper-local `LeafletResult` inlined too.
    expect(sig).toContain('status');
    expect(sig).toContain('value');
    // Wrapper-local type NAMES do not survive — they are expanded.
    expect(sig).not.toContain('LeafletOptions');
    expect(sig).not.toContain('LeafletResult');
    // It is a function-type expression.
    expect(sig).toContain('=>');
  });

  it('keeps non-local named types (DOM lib) by name instead of expanding them', () => {
    const dts = `
export interface MapValue { containerRef: (el: HTMLDivElement | null) => void }
export declare const useMap: () => MapValue;
`;
    const out = extractCallSignaturesFromDts(dts, ['useMap']);
    const sig = out['useMap']!;
    // `HTMLDivElement` is a TS DOM-lib type — kept by name, NOT
    // expanded into hundreds of DOM members.
    expect(sig).toContain('HTMLDivElement');
    expect(sig).toContain('containerRef');
  });

  it('extracts a function-declared hook signature', () => {
    const dts = `
export interface GeoValue { lat: number; lng: number }
export declare function useGeolocation(): GeoValue;
`;
    const out = extractCallSignaturesFromDts(dts, ['useGeolocation']);
    expect(Object.keys(out)).toEqual(['useGeolocation']);
    const sig = out['useGeolocation']!;
    expect(sig).toContain('=>');
    expect(sig).toContain('lat');
    expect(sig).toContain('lng');
  });

  it('extracts multiple hooks in one pass', () => {
    const dts = `
export declare const useAlpha: (x: number) => string;
export declare const useBeta: (y: string) => boolean;
`;
    const out = extractCallSignaturesFromDts(dts, ['useAlpha', 'useBeta']);
    expect(Object.keys(out).sort()).toEqual(['useAlpha', 'useBeta']);
    expect(out['useAlpha']).toContain('number');
    expect(out['useAlpha']).toContain('string');
    expect(out['useBeta']).toContain('string');
    expect(out['useBeta']).toContain('boolean');
  });

  it('omits hooks not found in the `.d.ts` (no throw)', () => {
    const dts = `export declare const useAlpha: () => void;`;
    const out = extractCallSignaturesFromDts(dts, ['useAlpha', 'useMissing']);
    expect(Object.keys(out)).toEqual(['useAlpha']);
    expect(out['useMissing']).toBeUndefined();
  });

  it('omits a non-callable export', () => {
    const dts = `export declare const notAHook: { foo: number };`;
    const out = extractCallSignaturesFromDts(dts, ['notAHook']);
    expect(out).toEqual({});
  });

  it('returns an empty map for empty input', () => {
    expect(extractCallSignaturesFromDts('', ['useAlpha'])).toEqual({});
    expect(extractCallSignaturesFromDts('export const x = 1;', [])).toEqual({});
  });
});

// Component prop-signature extraction.
describe('extractComponentPropsFromDts', () => {
  it('extracts a component props object, inlining wrapper-local named types', () => {
    const dts = `
export interface ChartDatum { label: string; value: number }
export interface ChartProps {
  data: readonly ChartDatum[];
  height?: number;
  barColor?: string;
}
export declare function Chart(props: ChartProps): JSX.Element;
`;
    const out = extractComponentPropsFromDts(dts, ['Chart']);
    expect(Object.keys(out)).toEqual(['Chart']);
    const props = out['Chart']!;
    // Each declared prop surfaces, optionals marked.
    expect(props).toContain('data');
    expect(props).toContain('height?');
    expect(props).toContain('barColor?');
    // The wrapper-local `ChartProps` is expanded — not kept as a name.
    expect(props).not.toContain('ChartProps');
    // It is an object type, not a function-type expression.
    expect(props.trimStart().startsWith('{')).toBe(true);
    expect(props).not.toContain('=>');
  });

  it('extracts a const-declared component (arrow function component)', () => {
    const dts = `
export interface BadgeProps { label: string; tone?: 'info' | 'warn' }
export declare const Badge: (props: BadgeProps) => JSX.Element;
`;
    const out = extractComponentPropsFromDts(dts, ['Badge']);
    const props = out['Badge']!;
    expect(props).toContain('label');
    expect(props).toContain('tone?');
  });

  it('yields `{}` for a zero-parameter component', () => {
    const dts = `export declare function Logo(): JSX.Element;`;
    const out = extractComponentPropsFromDts(dts, ['Logo']);
    expect(out['Logo']).toBe('{}');
  });

  it('omits components not found in the `.d.ts` (no throw)', () => {
    const dts = `export declare function Chart(props: { data: number[] }): JSX.Element;`;
    const out = extractComponentPropsFromDts(dts, ['Chart', 'Missing']);
    expect(Object.keys(out)).toEqual(['Chart']);
    expect(out['Missing']).toBeUndefined();
  });

  it('omits a non-callable export', () => {
    const dts = `export declare const notAComponent: { foo: number };`;
    const out = extractComponentPropsFromDts(dts, ['notAComponent']);
    expect(out).toEqual({});
  });

  it('returns an empty map for empty input', () => {
    expect(extractComponentPropsFromDts('', ['Chart'])).toEqual({});
    expect(extractComponentPropsFromDts('export const x = 1;', [])).toEqual({});
  });
});
