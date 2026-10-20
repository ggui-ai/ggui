// ggui#1966 — a kit control's ink and fill are its variant's: an inline `color` / `background` on one is a tier-0 fail,
// a token as much as a literal. The same style on the model's own element (a Box) is not a kit control's and passes.
import { describe, expect, it } from 'vitest';
import { runTier0Checks } from './run-tier0.js';

const wrap = (jsx: string): string => `import { Box, Button, Input } from '@ggui-ai/design';
interface Props { title?: string }
export default function C({ title = 'Hi' }: Props) {
  return (${jsx});
}
`;
const colorFails = async (src: string) => (await runTier0Checks(src)).filter((i) => i.subcategory === 'control-inline-color');

describe('control-inline-color (ggui#1966)', () => {
  it('fails a token colour inline on a Button (the outline chips of #1385 try 4)', async () => {
    const hits = await colorFails(wrap(`<Button variant="outline" style={{ color: 'var(--ggui-color-onContainer)' }}>{title}</Button>`));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.description).toContain('<Button> sets an inline `color`');
  });
  it('fails a background on a control, inline or through a same-file style object', async () => {
    expect(await colorFails(wrap(`<Input style={{ backgroundColor: '#fff' }} />`))).toHaveLength(1);
    expect(await colorFails(`const chip = { background: 'var(--ggui-color-primary-500)' };\n` + wrap(`<Button style={chip}>{title}</Button>`))).toHaveLength(1);
  });
  it("passes the same colour on the model's own element, and a control with no inline colour", async () => {
    expect(await colorFails(wrap(`<Box style={{ color: 'var(--ggui-color-onContainer)' }}>{title}</Box>`))).toHaveLength(0);
    expect(await colorFails(wrap(`<Button variant="outline" style={{ borderRadius: 999 }}>{title}</Button>`))).toHaveLength(0);
  });
});
