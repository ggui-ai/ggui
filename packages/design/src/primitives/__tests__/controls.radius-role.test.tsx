/**
 * Pin (ggui#1093, the harvest half — radius by ROLE): the CONTROL primitives read the control
 * role's radius, falling to the `md` stop, then to the literal — and the surfaces do not.
 *
 * Bought by a measurement (guuey-team-landing, guuey#1320): on real host pages cards sit at
 * 2–12px while buttons are pills on two of eight. Button / Input / Select / TextArea used to read
 * `--ggui-shape-radius-md`, the stop Card defaults to, so a harvested host could be its cards or
 * its buttons but never both. The projector now always emits `--ggui-shape-radius-control`
 * (see derive-theme-variables.radius-role.pin.test.ts); this pin holds the consumer side, and the
 * consumed-token manifest holds the name.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../Button';
import { Card } from '../Card';
import { Checkbox } from '../Checkbox';
import { Input } from '../Input';
import { Select } from '../Select';
import { TextArea } from '../TextArea';

const ROLE = 'border-radius:var(--ggui-shape-radius-control, var(--ggui-shape-radius-md, 8px))';

describe('controls read the radius ROLE (ggui#1093 harvest half)', () => {
  it('Button, Input, Select, TextArea: the control role, then the md stop, then the literal', () => {
    expect(renderToStaticMarkup(<Button>Book</Button>)).toContain(ROLE);
    expect(renderToStaticMarkup(<Input label="Name" />)).toContain(ROLE);
    expect(renderToStaticMarkup(<Select label="Size" options={[{ value: 's', label: 'Small' }]} />)).toContain(ROLE);
    expect(renderToStaticMarkup(<TextArea label="Bio" />)).toContain(ROLE);
  });

  it('a surface does not: Card keeps the ladder (a card is not a control), Checkbox keeps its own sm stop', () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).not.toContain('--ggui-shape-radius-control');
    const checkbox = renderToStaticMarkup(<Checkbox label="Agree" />);
    expect(checkbox).toContain('--ggui-shape-radius-sm');
    expect(checkbox).not.toContain('--ggui-shape-radius-control');
  });
});
