/**
 * ggui#1106 — a stated motion tempo REACHES the card: `normalizeThemeDocument`
 * carries `motion.duration` / `motion.easing` / `motion.reduce` into the
 * DtcgTheme (they were validated at the door and then dropped on the floor),
 * and the projection emits them onto `--ggui-motion-*`. RED before, GREEN after.
 */
import { describe, expect, it } from 'vitest';
import { deriveThemeVariables } from '@ggui-ai/design/themes';
import { normalizeThemeDocument, parseThemeDocument, type ThemeDocument } from './theme.js';

const color = (hex: string) => ({ $type: 'color', $value: hex }) as const;
const dim = (v: string) => ({ $type: 'dimension', $value: v }) as const;
const baseTheme: ThemeDocument = {
  color: {
    primary: { '500': color('#0ea5e9') },
    success: { '500': color('#16a34a') },
    warning: { '500': color('#f59e0b') },
    error: { '500': color('#dc2626') },
    info: { '500': color('#2563eb') },
    ground: color('#ffffff'),
    onGround: color('#111827'),
    container: color('#ffffff'),
    onContainer: color('#111827'),
    sunken: color('#f3f4f6'),
    onSunken: color('#374151'),
  },
  spacing: { '4': dim('16px') },
  font: {
    family: { sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui'] } },
    weight: { regular: { $type: 'fontWeight', $value: 400 } },
  },
  shape: {
    radius: { md: dim('8px') },
    shadow: { sm: { $type: 'shadow', $value: { offsetX: '0', offsetY: '1px', blur: '2px', spread: '0', color: 'rgba(0,0,0,.05)' } } },
  },
};

describe('motion tempo reaches the card — ggui#1106', () => {
  it('normalizeThemeDocument carries the stated duration / easing / reduce; unstated steps stay absent', () => {
    const doc = parseThemeDocument({
      ...baseTheme,
      motion: {
        transition: {},
        duration: { fast: { $type: 'duration', $value: '150ms' } },
        easing: { standard: { $type: 'cubicBezier', $value: 'ease-out' } },
        reduce: 'ignore',
      },
    });
    const dtcg = normalizeThemeDocument(doc);
    expect(dtcg.motion.duration?.fast?.$value).toBe('150ms');
    expect(dtcg.motion.duration?.base).toBeUndefined();
    expect(dtcg.motion.easing?.standard?.$value).toBe('ease-out');
    expect(dtcg.motion.reduce).toBe('ignore');
  });

  it('a document without motion keeps the layer-1 motion block — no tempo, no easing, no reduce', () => {
    const dtcg = normalizeThemeDocument(parseThemeDocument(baseTheme));
    expect(dtcg.motion.duration).toBeUndefined();
    expect(dtcg.motion.easing).toBeUndefined();
    expect(dtcg.motion.reduce).toBeUndefined();
  });

  it('end to end: the stated tempo is what the projection emits', () => {
    const doc = parseThemeDocument({
      ...baseTheme,
      motion: { transition: {}, duration: { base: { $type: 'duration', $value: '160ms' } } },
    });
    const vars = deriveThemeVariables(normalizeThemeDocument(doc), 'light');
    expect(vars['--ggui-motion-duration-base']).toBe('160ms');
    expect(vars['--ggui-motion-duration-fast']).toBe('100ms');
  });
});
