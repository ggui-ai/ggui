/**
 * ggui#1569 — a Select with a `placeholder` and neither `value` nor
 * `defaultValue` shows the placeholder, muted, until the user picks.
 *
 * The placeholder renders as a disabled first option, and nothing selected
 * it: the browser's selectedness rule picks the first option that is NOT
 * disabled, so the first real option showed as if the user had chosen it
 * (and a form reading the element's value got it). These read the DOM the
 * browser builds, not SSR markup, because SSR does not run that rule.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Select } from '../Select';

const OPTIONS = [
  { value: 'us', label: 'United States' },
  { value: 'br', label: 'Brazil' },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(element: React.ReactElement): Promise<HTMLSelectElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  const select = container.querySelector('select');
  if (select === null) throw new Error('no <select> rendered');
  return select;
}

/** What the select shows: the text of its selected option. */
const shown = (select: HTMLSelectElement): string => select.options[select.selectedIndex]?.text ?? '';
/** The role its text colour reads: `onContainer` or `onSunken`. */
const role = (select: HTMLSelectElement): string =>
  /--ggui-color-([A-Za-z]+)/.exec(select.style.color)?.[1] ?? select.style.color;

describe('Select placeholder (ggui#1569)', () => {
  it('with a placeholder and no value, shows the placeholder, muted, and its value is empty', async () => {
    const select = await mount(<Select options={OPTIONS} placeholder="Pick a country" />);
    expect(select.value).toBe('');
    expect(shown(select)).toBe('Pick a country');
    expect(role(select)).toBe('onSunken');
  });

  it('once the user picks, shows the choice at body strength', async () => {
    const select = await mount(<Select options={OPTIONS} placeholder="Pick a country" />);
    await act(async () => {
      select.value = 'br';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(shown(select)).toBe('Brazil');
    expect(role(select)).toBe('onContainer');
  });

  it('a controlled value still shows the value, at body strength', async () => {
    const select = await mount(<Select options={OPTIONS} placeholder="Pick a country" value="us" onChange={() => {}} />);
    expect(shown(select)).toBe('United States');
    expect(role(select)).toBe('onContainer');
  });

  it('a defaultValue still wins over the placeholder', async () => {
    const select = await mount(<Select options={OPTIONS} placeholder="Pick a country" defaultValue="br" />);
    expect(shown(select)).toBe('Brazil');
    expect(role(select)).toBe('onContainer');
  });

  it('without a placeholder, the first option shows, as before', async () => {
    const select = await mount(<Select options={OPTIONS} />);
    expect(shown(select)).toBe('United States');
    expect(role(select)).toBe('onContainer');
  });

  it('an empty placeholder renders no placeholder option, so the first option shows', async () => {
    const select = await mount(<Select options={OPTIONS} placeholder="" />);
    expect(shown(select)).toBe('United States');
    expect(role(select)).toBe('onContainer');
  });
});
