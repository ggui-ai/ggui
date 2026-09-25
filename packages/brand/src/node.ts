/**
 * A framework-neutral element tree: the plain `{ type, props, key }` objects
 * satori renders, and the same shape a React element has, so Next's
 * `ImageResponse` takes it directly.
 */

/** The subset of CSS the social card uses, in satori's (React-style) naming. */
export interface CardStyle {
  readonly display?: 'flex';
  readonly flexDirection?: 'column' | 'row';
  readonly alignItems?: 'center' | 'flex-start';
  readonly position?: 'relative' | 'absolute';
  readonly top?: number;
  readonly left?: number;
  readonly right?: number;
  readonly width?: number;
  readonly height?: number;
  readonly marginTop?: number;
  readonly padding?: string;
  readonly background?: string;
  readonly color?: string;
  readonly border?: string;
  readonly borderRadius?: number;
  readonly fontFamily?: 'Inter' | 'Geist Mono';
  readonly fontSize?: number;
  readonly fontWeight?: 400 | 700;
  readonly letterSpacing?: number;
  readonly lineHeight?: number;
  readonly textTransform?: 'uppercase';
  readonly whiteSpace?: 'pre-line';
}

export interface CardNodeProps {
  readonly style?: CardStyle;
  readonly children?: CardChild | readonly CardChild[];
  // SVG attributes, for the wordmark.
  readonly viewBox?: string;
  readonly width?: number;
  readonly height?: number;
  readonly d?: string;
  readonly x?: number;
  readonly y?: number;
  readonly fill?: string;
}

export interface CardNode {
  readonly type: 'div' | 'svg' | 'path' | 'rect';
  readonly props: CardNodeProps;
  readonly key: null;
}

export type CardChild = CardNode | string;

export function el(type: CardNode['type'], props: CardNodeProps): CardNode {
  return { type, props, key: null };
}
