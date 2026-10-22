// ggui#1977 / #1981: an opening band that lost its edge. Only a first-child hero Box, a sole-child hero Card (the
// runtime's inference) or a root child that declares `bleed` meets the card's edge in every fit (design's
// EXPANDED_FRAME_BLEEDS). A hero band placed anywhere else warns (`hero-not-first`; the corpus analyzer's version read
// 14 of 14 true on the served corpus), and so does a hero Card opening the root among siblings (`hero-card-first`).
// Tiles and root-child bands that declare `bleed` never warn; the retired `painted-band` shape (7 of 8 served hits
// were contained Cards) no longer warns at all.
import { describe, expect, it } from 'vitest';
import { runTier0Checks } from './run-tier0.js';

const wrap = (jsx: string): string => `import { Box, Card, Container, Grid, Stack, Text, Heading, Input, Button } from '@ggui-ai/design';
interface Props { title?: string; heading?: string }
export default function C({ title = 'Welcome', heading }: Props) {
  return (${jsx});
}
`;
const band = async (src: string) => (await runTier0Checks(src)).filter((i) => (i.subcategory ?? '').startsWith('band-edge-lost'));
const H = `<Heading level={1}>{title}</Heading>`;

describe('band-edge-lost:hero-not-first (ggui#1977 / #1981)', () => {
  it("warns on the served shape: a Stack as the root's only child, a hero Box first inside it", async () => {
    const hits = await band(wrap(`<Box padding="none"><Stack gap="none"><Box surface="hero" paddingX="md" paddingY="sm">${H}</Box><Box padding="md"><Text>Body</Text></Box></Stack></Box>`));
    expect(hits.map((h) => [h.result, h.subcategory])).toEqual([['warn', 'band-edge-lost:hero-not-first']]);
  });
  it('warns on a hero Box that is a later root child', async () => {
    expect(await band(wrap(`<Box><Text>Intro</Text><Box surface="hero">${H}</Box></Box>`))).toHaveLength(1);
  });
  it('reads a conditional band where it renders, and says so (`heading && …` and a ternary)', async () => {
    const and = await band(wrap(`<Box><Stack>{heading && <Box surface="hero">${H}</Box>}<Box><Text>Body</Text></Box></Stack></Box>`));
    expect(and).toHaveLength(1);
    expect(and[0]!.description).toContain('renders conditionally');
    expect(await band(wrap(`<Box><Stack>{heading ? <Box surface="hero">${H}</Box> : null}<Box /></Stack></Box>`))).toHaveLength(1);
  });
  it('never warns on a tile: a hero Card among siblings, or a hero Box with its own radius, shadow or border', async () => {
    expect(await band(wrap(`<Box><Stack><Card surface="hero" padding="xl" shadow="lg" radius="xl">${H}</Card><Text>Body</Text></Stack></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Text>Intro</Text><Card surface="hero">${H}</Card></Box>`))).toHaveLength(0);
    for (const k of ['radius="lg"', 'radius={12}', 'style={{ borderRadius: 12 }}', "style={{ boxShadow: 'var(--ggui-shadow-md)' }}", "style={{ border: '1px solid' }}"]) {
      expect(await band(wrap(`<Box><Text>Intro</Text><Box surface="hero" ${k}>${H}</Box></Box>`)), k).toHaveLength(0);
    }
    // radius="none" is no edge: still a band.
    expect(await band(wrap(`<Box><Text>Intro</Text><Box surface="hero" radius="none">${H}</Box></Box>`))).toHaveLength(1);
    expect(await band(wrap(`<Container><Grid columns={2}><Card surface="hero">${H}</Card><Card>Stat</Card></Grid></Container>`))).toHaveLength(0);
  });
  it('never warns on the band where it belongs, or on a root-child band that declares bleed', async () => {
    expect(await band(wrap(`<Box><Box surface="hero" bleed>${H}</Box><Text>Body</Text></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Box surface="hero">${H}</Box><Text>Body</Text></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Text>Intro</Text><Box surface="hero" bleed>${H}</Box></Box>`))).toHaveLength(0);
  });
  it('the retired painted-band shape no longer warns (7 of 8 served hits were contained Cards)', async () => {
    expect(await band(wrap(`<Box><Box padding="lg" style={{ background: 'var(--ggui-color-primary-500)' }}>${H}</Box><Text>Body</Text></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Container><Card surface="elevated" shadow="md" radius="lg">${H}</Card></Container>`))).toHaveLength(0);
  });
  it('a painted wrapper is not a plain wrapper: a hero Box first inside it is not read as wrapped', async () => {
    expect(await band(wrap(`<Box><Box surface="sunken"><Box surface="hero">${H}</Box></Box></Box>`))).toHaveLength(0);
  });
  it('bleed is honoured on a root child only: a wrapped band that declares it still warns', async () => {
    expect(await band(wrap(`<Box><Stack><Box surface="hero" bleed>${H}</Box><Text>Body</Text></Stack></Box>`))).toHaveLength(1);
  });
  it('a horizontal Stack is not a plain wrapper: a hero side panel first in it is not an opening band', async () => {
    expect(await band(wrap(`<Box><Stack direction="horizontal"><Box surface="hero">${H}</Box><Box><Text>Body</Text></Box></Stack></Box>`))).toHaveLength(0);
  });
  it('a root that already opens on a band is left alone when a second hero Box follows', async () => {
    expect(await band(wrap(`<Box><Box surface="hero" bleed>${H}</Box><Text>Body</Text><Box surface="hero"><Text>Footer</Text></Box></Box>`))).toHaveLength(0);
  });
  it('a conditional notice before the band: warns, and says the read is conditional', async () => {
    const hits = await band(wrap(`<Box>{heading && <Text>Notice</Text>}<Box surface="hero">${H}</Box></Box>`));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.description).toContain('renders conditionally');
    // A fixed sibling before it: no conditional note.
    expect((await band(wrap(`<Box><Text>Intro</Text><Box surface="hero">${H}</Box></Box>`)))[0]!.description).not.toContain('conditionally');
  });
  it('reads `||`, the else branch of a ternary, and a nested ternary', async () => {
    for (const x of [`{heading || <Box surface="hero">${H}</Box>}`, `{heading ? null : <Box surface="hero">${H}</Box>}`, `{heading ? null : title ? <Box surface="hero">${H}</Box> : null}`]) {
      expect(await band(wrap(`<Box><Text>Intro</Text>${x}</Box>`)), x).toHaveLength(1);
    }
  });
  it('finds the component under `export default C` (a function or an arrow), not only `export default function`', async () => {
    const body = `<Box><Text>Intro</Text><Box surface="hero">${H}</Box></Box>`;
    const head = `import { Box, Text, Heading } from '@ggui-ai/design';\ninterface Props { title?: string }\n`;
    expect(await band(`${head}function C({ title = 'W' }: Props) {\n  return (${body});\n}\nexport default C;\n`)).toHaveLength(1);
    expect(await band(`${head}const C = ({ title = 'W' }: Props) => (${body});\nexport default C;\n`)).toHaveLength(1);
  });
  it('hero-card-first: a hero Card opening the root among siblings warns; a sole-child hero Card (the body) never does', async () => {
    const hits = await band(wrap(`<Box><Card surface="hero" padding="lg">${H}</Card><Text>Body</Text></Box>`));
    expect(hits.map((h) => [h.result, h.subcategory])).toEqual([['warn', 'band-edge-lost:hero-card-first']]);
    expect(hits[0]!.fix).toContain('<Box surface="hero" bleed>');
    expect(await band(wrap(`<Box><Card surface="hero" padding="lg">${H}</Card></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Card surface="hero" bleed>${H}</Card><Text>Body</Text></Box>`))).toHaveLength(0);
    expect(await band(wrap(`<Box><Card surface="elevated">${H}</Card><Text>Body</Text></Box>`))).toHaveLength(0);
  });
  it('is off in free design mode, like every design-vocabulary leg', async () => {
    const src = wrap(`<Box><Text>Intro</Text><Box surface="hero">${H}</Box></Box>`);
    expect((await runTier0Checks(src, undefined, undefined, undefined, 'free')).filter((i) => (i.subcategory ?? '').startsWith('band-edge-lost'))).toHaveLength(0);
  });
});
