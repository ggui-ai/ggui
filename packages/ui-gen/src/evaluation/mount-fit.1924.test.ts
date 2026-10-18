/**
 * The evaluator reads the same mount fit the runtime serves by: the bundle's canvas export (read from
 * the compiled code exactly as the runtime reads it from the module) through `resolveMountFit`, and
 * its frame statement follows that fit. The generator writes the export under the one name.
 */
import { describe, expect, it } from 'vitest';
import { transform } from 'esbuild';
import { FRAMED_CARD_GROUND, GGUI_MOUNT_CANVAS_EXPORT, resolveMountFit } from '@ggui-ai/design/rendering';
import { buildRenderHTML, mountCanvasOf } from './visual-evaluator.js';
import { criteriaFrameLine } from './criteria/resolve.js';
import { generateBoilerplate } from '../boilerplate/generate.js';
import { canvasForRendering } from '../design-mode.js';

const SOURCE = (canvas: string): string =>
  `export const ${GGUI_MOUNT_CANVAS_EXPORT} = "${canvas}";\nexport default function Component() { return null; }\n`;

describe('mountCanvasOf — the canvas export, read from compiled code', () => {
  it('reads it from minified and unminified esbuild output alike', async () => {
    for (const minify of [true, false]) {
      const { code } = await transform(SOURCE('xs-chat-card'), { loader: 'tsx', format: 'esm', minify });
      expect(mountCanvasOf(code)).toBe('xs-chat-card');
    }
  });

  it('a bundle with no export reads undefined, and the fit fails closed to fill', async () => {
    const { code } = await transform('export default function C() { return null; }', { loader: 'tsx', format: 'esm', minify: true });
    expect(mountCanvasOf(code)).toBeUndefined();
    expect(resolveMountFit({ canvas: mountCanvasOf(code), displayMode: 'fullscreen' })).toBe('fill');
  });

  it('a value that is not a canvas class is read as written and refused by the rule', async () => {
    const { code } = await transform(SOURCE('chat-card-ish'), { loader: 'tsx', format: 'esm', minify: true });
    expect(mountCanvasOf(code)).toBe('chat-card-ish');
    expect(resolveMountFit({ canvas: mountCanvasOf(code), displayMode: 'fullscreen' })).toBe('fill');
  });
});

describe('criteriaFrameLine follows the fit, never the canvas alone', () => {
  const md = { canvas: 'md' as const, width: 816, height: 736, hostLabel: 'host chat widget, pane, 1280×800 embedded' };
  it('framed-card states the served geometry: natural height, the card\'s own frame, the host\'s ground', () => {
    const line = criteriaFrameLine({ ...md, fit: 'framed-card' });
    expect(line).toContain('with the card at its natural height at the top');
    expect(line).toContain("inside the card's own frame");
    expect(line).toContain("read the ground round it as the host's, not the card's");
    expect(line).not.toContain('fixed full-screen box');
  });
  it('the same md frame under fill keeps the fixed-box statement; changing the fit changes the sentence', () => {
    expect(criteriaFrameLine({ ...md, fit: 'fill' })).toContain('816×736, a fixed full-screen box the card fills');
    expect(criteriaFrameLine({ ...md, fit: 'fill' })).not.toBe(criteriaFrameLine({ ...md, fit: 'framed-card' }));
  });
});

describe('the boilerplate emits the one export name with the rendering canvas', () => {
  const contract = { propsSpec: { properties: {} }, actionSpec: {} };
  it.each([
    ['chat', 'universal'],
    ['fullscreen', 'tablet'],
    ['fullscreen', 'mobile'],
    [undefined, undefined],
  ] as const)('shell %s × screen %s', (shell, screen) => {
    const text = generateBoilerplate('x', contract, shell, screen);
    expect(text).toContain(`export const ${GGUI_MOUNT_CANVAS_EXPORT} = "${canvasForRendering(shell, screen)}";`);
    expect(text.match(new RegExp(`\\b${GGUI_MOUNT_CANVAS_EXPORT}\\b`, 'g'))).toHaveLength(1);
  });
});

describe('the judge page for a framed card', () => {
  const page = buildRenderHTML('', undefined, undefined, 'panel', undefined, 10);
  const panelRule = /\.ggui-judge-panel \{([^}]*)\}/.exec(page)?.[1] ?? '';
  it("paints the panel with the framed card's ground, the same constant the runtime paints, after the stand-in's own", () => {
    const grounds = [...panelRule.matchAll(/background:\s*([^;]+);/g)].map((m) => m[1]);
    expect(grounds.at(-1)).toBe(FRAMED_CARD_GROUND);
  });
  it("makes the panel a block formatting context, so the card's 16 px top margin stays inside it", () => {
    expect(panelRule).toContain('display: flow-root');
  });
});
