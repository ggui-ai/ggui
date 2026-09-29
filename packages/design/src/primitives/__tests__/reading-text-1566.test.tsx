/**
 * ggui#1566 — the text you READ is drawn with `onContainer`; `onSunken` is the
 * muted tier (labels, helpers, descriptions, headers, timestamps). Six
 * components drew their reading text with the muted role, in light as in
 * dark: the other party's chat message, the Select's chosen value, Table body
 * cells, the Accordion answer, the option labels of Checkbox / RadioGroup /
 * Toggle, and the secondary and ghost Button labels. These pins read the
 * EFFECTIVE colour: the nearest inline `color` on or above the element that
 * holds the text, so an inherited colour counts as it does in the browser.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { RadioGroup } from '../RadioGroup';
import { Toggle } from '../Toggle';
import { Accordion } from '../Accordion';
import { Table } from '../Table';
import { Select } from '../Select';
import { ChatWindow } from '../../compositions/ChatWindow';
import { theme as ggui } from '../../themes/definitions/ggui';

/** The role the text's effective colour reads: `onContainer`, `onSunken`, … */
function roleOf(element: ReactElement, text: string): string {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  const holder = Array.from(host.querySelectorAll<HTMLElement>('*')).find(
    (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').includes(text)),
  );
  if (holder === undefined) throw new Error(`no element holds "${text}"`);
  for (let el: HTMLElement | null = holder; el !== null && el !== host; el = el.parentElement) {
    const color = el.style.color;
    if (color !== '') return /--ggui-color-([A-Za-z0-9-]+)/.exec(color)?.[1] ?? color;
  }
  return 'inherited-from-page';
}

describe('reading text is onContainer; the muted tier stays onSunken (ggui#1566)', () => {
  it('Button: the secondary and ghost labels (rank comes from the chip and the outline, not greyer text)', () => {
    expect(roleOf(<Button variant="secondary">Save draft</Button>, 'Save draft')).toBe('onContainer');
    expect(roleOf(<Button variant="ghost">Cancel</Button>, 'Cancel')).toBe('onContainer');
  });

  it('Checkbox and Toggle: the option label reads; its description stays muted', () => {
    const cb = <Checkbox label="Email me" description="Weekly digest" />;
    expect(roleOf(cb, 'Email me')).toBe('onContainer');
    expect(roleOf(cb, 'Weekly digest')).toBe('onSunken');
    expect(roleOf(<Toggle label="Dark mode" />, 'Dark mode')).toBe('onContainer');
  });

  it('RadioGroup: each option label reads; descriptions and the field label stay muted', () => {
    const rg = (
      <RadioGroup
        label="Plan"
        options={[{ value: 'pro', label: 'Pro', description: 'For teams' }]}
      />
    );
    expect(roleOf(rg, 'Pro')).toBe('onContainer');
    expect(roleOf(rg, 'For teams')).toBe('onSunken');
    expect(roleOf(rg, 'Plan')).toBe('onSunken');
  });

  it('Accordion: the answer reads like its own question', () => {
    const acc = <Accordion items={[{ key: 'q', title: 'What is it?', content: 'An answer to read.' }]} expandedKeys={['q']} />;
    expect(roleOf(acc, 'What is it?')).toBe('onContainer');
    expect(roleOf(acc, 'An answer to read.')).toBe('onContainer');
  });

  it('Table: body cells are the data; the header stays muted', () => {
    const table = <Table columns={[{ key: 'name', header: 'Name' }]} data={[{ name: 'Ada Lovelace' }]} />;
    expect(roleOf(table, 'Ada Lovelace')).toBe('onContainer');
    expect(roleOf(table, 'Name')).toBe('onSunken');
  });

  it('Select: the displayed choice reads; only a displayed placeholder is muted', () => {
    const options = [{ value: 'us', label: 'United States' }];
    // A chosen value.
    expect(roleOf(<Select options={options} value="us" onChange={() => {}} />, 'United States')).toBe('onContainer');
    // Uncontrolled: the browser displays the first real option (the placeholder option is disabled), so it reads.
    expect(roleOf(<Select options={options} placeholder="Pick one" />, 'United States')).toBe('onContainer');
    // The placeholder is what shows only when the value is the empty choice, controlled or by default.
    expect(roleOf(<Select options={options} placeholder="Pick one" value="" onChange={() => {}} />, 'Pick one')).toBe('onSunken');
    expect(roleOf(<Select options={options} placeholder="Pick one" defaultValue="" />, 'Pick one')).toBe('onSunken');
    // An empty placeholder renders no placeholder option, so a real option shows, and it reads.
    expect(roleOf(<Select options={options} placeholder="" value="" onChange={() => {}} />, 'United States')).toBe('onContainer');
  });

  it("ChatWindow: the other party's message reads; its timestamp stays muted; own messages are unchanged", () => {
    const chat = (
      <ChatWindow
        currentUserId="me"
        messages={[
          { id: '1', content: 'Their message', sender: { id: 'them', name: 'Alice' }, timestamp: '10:30 AM' },
          { id: '2', content: 'My message', sender: { id: 'me', name: 'You' }, timestamp: '10:31 AM' },
        ]}
      />
    );
    expect(roleOf(chat, 'Their message')).toBe('onContainer');
    expect(roleOf(chat, '10:30 AM')).toBe('onSunken');
    expect(roleOf(chat, 'My message')).toBe('onPrimary');
  });
});

/** WCAG 2.x contrast of two `#rrggbb` hexes. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, b2] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the ggui themes\' muted tier (ggui#1566)', () => {
  for (const [name, doc] of [['light', ggui.light], ['dark', ggui.dark]] as const) {
    const c = doc.color;
    it(`${name}: onSunken is text on both grounds, and a clear step back from the reading ink`, () => {
      // AA for small text on the card and on the well, the two grounds muted text moves between.
      expect(contrast(c.onSunken.$value, c.container.$value)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.onSunken.$value, c.sunken.$value)).toBeGreaterThanOrEqual(4.5);
      // A separate tier: light's ink-3 sits 2.11x back from its ink, and the dark muted step 2.26x.
      // The dark value this replaced (#d9d9d9) sat 1.27x back, so secondary text read as primary.
      expect(contrast(c.onContainer.$value, c.onSunken.$value)).toBeGreaterThanOrEqual(2);
    });
  }
});
