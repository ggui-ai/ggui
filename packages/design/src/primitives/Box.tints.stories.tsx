import type { Meta, StoryObj } from '@storybook/react-vite';
import { Box } from './Box';
import { Text } from './Text';
import { TINT_STEPS, type TintStep } from './color-slots';
import { generateScopedCssVariables } from '../themes/parser';
import { getRawTheme } from '../themes/registry';

/**
 * ggui#1847 — the read fixture for the categorical tints: the first four
 * periods of the periodic table, each cell filled by its element category,
 * with a legend, in the ggui theme's light and dark schemes side by side.
 * Read at 375 and 1024 px wide.
 */
const meta: Meta = {
  title: 'Primitives/Layout/Box/Categorical tints',
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Category =
  | 'alkali metal'
  | 'alkaline earth metal'
  | 'transition metal'
  | 'post-transition metal'
  | 'metalloid'
  | 'nonmetal'
  | 'halogen'
  | 'noble gas';

/** Eight categories, one tint each, in the order the legend lists them. */
const CATEGORY_TINT: Readonly<Record<Category, TintStep>> = {
  'alkali metal': TINT_STEPS[0],
  'alkaline earth metal': TINT_STEPS[1],
  'transition metal': TINT_STEPS[2],
  'post-transition metal': TINT_STEPS[3],
  metalloid: TINT_STEPS[4],
  nonmetal: TINT_STEPS[5],
  halogen: TINT_STEPS[6],
  'noble gas': TINT_STEPS[7],
};

interface Element {
  readonly z: number;
  readonly symbol: string;
  readonly period: number;
  readonly group: number;
  readonly category: Category;
}

const E = (z: number, symbol: string, period: number, group: number, category: Category): Element => ({ z, symbol, period, group, category });

const ELEMENTS: readonly Element[] = [
  E(1, 'H', 1, 1, 'nonmetal'), E(2, 'He', 1, 18, 'noble gas'),
  E(3, 'Li', 2, 1, 'alkali metal'), E(4, 'Be', 2, 2, 'alkaline earth metal'), E(5, 'B', 2, 13, 'metalloid'),
  E(6, 'C', 2, 14, 'nonmetal'), E(7, 'N', 2, 15, 'nonmetal'), E(8, 'O', 2, 16, 'nonmetal'), E(9, 'F', 2, 17, 'halogen'), E(10, 'Ne', 2, 18, 'noble gas'),
  E(11, 'Na', 3, 1, 'alkali metal'), E(12, 'Mg', 3, 2, 'alkaline earth metal'), E(13, 'Al', 3, 13, 'post-transition metal'), E(14, 'Si', 3, 14, 'metalloid'),
  E(15, 'P', 3, 15, 'nonmetal'), E(16, 'S', 3, 16, 'nonmetal'), E(17, 'Cl', 3, 17, 'halogen'), E(18, 'Ar', 3, 18, 'noble gas'),
  E(19, 'K', 4, 1, 'alkali metal'), E(20, 'Ca', 4, 2, 'alkaline earth metal'),
  E(21, 'Sc', 4, 3, 'transition metal'), E(22, 'Ti', 4, 4, 'transition metal'), E(23, 'V', 4, 5, 'transition metal'), E(24, 'Cr', 4, 6, 'transition metal'),
  E(25, 'Mn', 4, 7, 'transition metal'), E(26, 'Fe', 4, 8, 'transition metal'), E(27, 'Co', 4, 9, 'transition metal'), E(28, 'Ni', 4, 10, 'transition metal'),
  E(29, 'Cu', 4, 11, 'transition metal'), E(30, 'Zn', 4, 12, 'transition metal'), E(31, 'Ga', 4, 13, 'post-transition metal'), E(32, 'Ge', 4, 14, 'metalloid'),
  E(33, 'As', 4, 15, 'metalloid'), E(34, 'Se', 4, 16, 'nonmetal'), E(35, 'Br', 4, 17, 'halogen'), E(36, 'Kr', 4, 18, 'noble gas'),
];

function Table() {
  return (
    <Box surface="default" padding="md" radius="lg">
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(18, minmax(34px, 1fr))', gap: 4, minWidth: 18 * 38 }}>
          {ELEMENTS.map((el) => (
            <Box
              key={el.z}
              tint={CATEGORY_TINT[el.category]}
              radius="sm"
              padding="xs"
              style={{ gridColumn: el.group, gridRow: el.period, textAlign: 'center' }}
              aria-label={`${el.symbol}, ${el.category}`}
            >
              <Text size="xs">{el.z}</Text>
              <div style={{ fontWeight: 600 }}>{el.symbol}</div>
            </Box>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        {(Object.keys(CATEGORY_TINT) as Category[]).map((c) => (
          <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Box tint={CATEGORY_TINT[c]} radius="sm" style={{ width: 16, height: 16 }} />
            <Text size="sm">{c}</Text>
          </div>
        ))}
      </div>
    </Box>
  );
}

function Scheme({ mode }: { mode: 'light' | 'dark' }) {
  const cls = `ggui-tints-${mode}`;
  const theme = getRawTheme('ggui', mode)!;
  return (
    <div className={cls} style={{ background: 'var(--ggui-color-ground)', color: 'var(--ggui-color-onGround)', padding: 16 }}>
      <style>{generateScopedCssVariables(theme, `.${cls}`, mode)}</style>
      <Text size="sm" tone="muted">ggui · {mode}</Text>
      <Table />
    </div>
  );
}

export const PeriodicTable: StoryObj = {
  render: () => (
    // Block layout, so each scheme is as wide as the pane and the table scrolls inside its card.
    <div>
      <Scheme mode="light" />
      <Scheme mode="dark" />
    </div>
  ),
};
