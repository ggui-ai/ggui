// ggui#1977: an opening band that lost its edge. Only a first-child `surface="hero"` band or a `bleed` element meets the
// card's edge in every fit (design's EXPANDED_FRAME_BLEEDS). The painted opening band warns; the shapes that keep the
// edge, and the look-alikes (a sunken panel opening a form, a hero tile in a grid or a wrapper), pass.
import { describe, expect, it } from 'vitest';
import { runTier0Checks } from './run-tier0.js';

const wrap = (jsx: string): string => `import { Box, Card, Grid, Stack, Text, Input, Button } from '@ggui-ai/design';
interface Props { title?: string }
export default function C({ title = 'Welcome' }: Props) {
  return (${jsx});
}
`;
const band = async (src: string) => (await runTier0Checks(src)).filter((i) => (i.subcategory ?? '').startsWith('band-edge-lost'));
const HEADING = `<Text size="2xl" weight="bold">{title}</Text>`;

describe('band-edge-lost (ggui#1977)', () => {
  it('warns on the #1385 hello: an opening band the generator painted itself', async () => {
    const hits = await band(wrap(`<Box padding="lg"><Box padding="lg" style={{ background: 'var(--ggui-color-primary-500)' }}>${HEADING}</Box><Text>Body</Text></Box>`));
    expect(hits.map((h) => [h.result, h.subcategory])).toEqual([['warn', 'band-edge-lost:painted-band']]);
  });
  it('warns on a painted surface or a tint opening the card, not only an inline background', async () => {
    expect(await band(wrap(`<Box><Box surface="accent">${HEADING}</Box><Text>Body</Text></Box>`))).toHaveLength(1);
    expect(await band(wrap(`<Box><Box tint="primary-100">${HEADING}</Box><Text>Body</Text></Box>`))).toHaveLength(1);
  });
  it('does NOT warn on a hero that is not the root\'s first child: on #1977\'s A/B every such hit was a hero tile, not a band', async () => {
    // The A/B's shape, verbatim in kind: a hero card with its own radius and shadow inside a wrapper.
    expect(await band(wrap(`<Box><Stack gap="md"><Card surface="hero" padding="xl" shadow="lg" radius="xl">${HEADING}</Card><Text>Body</Text></Stack></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Text>Intro</Text><Box surface="hero">${HEADING}</Box></Box>`))).toHaveLength(0);
  });
  it('passes the shapes that keep the edge: a first-child hero band, and a painted band that declares bleed', async () => {
    expect(await band(wrap(`<Box><Box surface="hero" padding="lg">${HEADING}</Box><Text>Body</Text></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Box surface="sunken" bleed>${HEADING}</Box><Text>Body</Text></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Text>Intro</Text><Box surface="hero" bleed>${HEADING}</Box></Box>`))).toHaveLength(0);
  });
  it('passes the look-alikes: a sunken panel opening a form, a painted first child with no heading, a hero tile in a grid', async () => {
    expect(await band(wrap(`<Box><Box surface="sunken">${HEADING}<Input label="Email" /><Button>Go</Button></Box></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Box surface="sunken"><Text>Three rows</Text></Box><Text>Body</Text></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Grid columns={2}><Card surface="hero">${HEADING}</Card><Card>Stat</Card></Grid></Box>`))).toHaveLength(0);
  });
  it('is off in free design mode, like every design-vocabulary leg', async () => {
    const src = wrap(`<Box><Box style={{ background: '#123' }}>${HEADING}</Box></Box>`);
    expect((await runTier0Checks(src, undefined, undefined, undefined, 'free')).filter((i) => (i.subcategory ?? '').startsWith('band-edge-lost'))).toHaveLength(0);
  });
});
