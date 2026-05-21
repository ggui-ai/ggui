import { describe, it, expect } from 'vitest';
import { parseComponent } from './components.js';
import { GGUI_PREVIEW_CATALOG_V1_COMPONENTS } from './catalog.js';

describe('parseComponent — happy path by component type', () => {
  it('accepts Row with children, gap, align, justify', () => {
    const result = parseComponent({
      id: 'header_row',
      component: 'Row',
      children: ['icon', 'title'],
      gap: '8px',
      align: 'center',
      justify: 'between',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.component).toBe('Row');
  });

  it('accepts Column with minimal shape (id + component only)', () => {
    const result = parseComponent({ id: 'col1', component: 'Column' });
    expect(result.ok).toBe(true);
  });

  it('accepts Card with singular `child` reference (A2UI shape)', () => {
    const result = parseComponent({
      id: 'root',
      component: 'Card',
      child: 'form_container',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.component === 'Card') {
      expect(result.value.child).toBe('form_container');
    }
  });

  it('accepts List with children', () => {
    const result = parseComponent({
      id: 'items',
      component: 'List',
      children: ['a', 'b', 'c'],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts Divider with orientation', () => {
    const result = parseComponent({
      id: 'sep',
      component: 'Divider',
      orientation: 'horizontal',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts Text with markdown + variant', () => {
    const result = parseComponent({
      id: 'title',
      component: 'Text',
      text: '# Contact Us',
      variant: 'h2',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.component === 'Text') {
      expect(result.value.text).toBe('# Contact Us');
    }
  });

  it('accepts Text without a variant (optional)', () => {
    const result = parseComponent({
      id: 'body',
      component: 'Text',
      text: 'hello',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts Image with src + alt', () => {
    const result = parseComponent({
      id: 'hero',
      component: 'Image',
      src: 'https://cdn/example.png',
      alt: 'hero',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts Icon with name', () => {
    const result = parseComponent({
      id: 'icon',
      component: 'Icon',
      name: 'mail',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts Button with label', () => {
    const result = parseComponent({
      id: 'submit',
      component: 'Button',
      label: 'Submit',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts TextField with label + placeholder', () => {
    const result = parseComponent({
      id: 'name',
      component: 'TextField',
      label: 'Name',
      placeholder: 'Jane Doe',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts CheckBox with label + checked', () => {
    const result = parseComponent({
      id: 'agree',
      component: 'CheckBox',
      label: 'I agree',
      checked: false,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts ChoicePicker with options', () => {
    const result = parseComponent({
      id: 'color',
      component: 'ChoicePicker',
      label: 'Color',
      options: [
        { label: 'Red', value: 'red' },
        { label: 'Blue', value: 'blue' },
      ],
      value: 'red',
    });
    expect(result.ok).toBe(true);
  });

  it('covers every catalog component type with at least one happy-path case', () => {
    // Drift guard: if the catalog grows or shrinks, this list must too.
    // Keeping the types + test coverage pinned together is the point.
    expect(GGUI_PREVIEW_CATALOG_V1_COMPONENTS).toHaveLength(12);
  });
});

describe('parseComponent — rejection path', () => {
  it('rejects unknown component name (catalog gate)', () => {
    const result = parseComponent({
      id: 'x',
      component: 'Tabs',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects entirely invented component name', () => {
    const result = parseComponent({
      id: 'x',
      component: 'SuperWidget',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects missing id', () => {
    const result = parseComponent({ component: 'Row' });
    expect(result.ok).toBe(false);
  });

  it('rejects empty-string id', () => {
    const result = parseComponent({ id: '', component: 'Row' });
    expect(result.ok).toBe(false);
  });

  it('rejects missing component discriminator', () => {
    const result = parseComponent({ id: 'x' });
    expect(result.ok).toBe(false);
  });

  it('rejects Text without required `text` field', () => {
    const result = parseComponent({ id: 'title', component: 'Text' });
    expect(result.ok).toBe(false);
  });

  it('rejects Button without required `label` field', () => {
    const result = parseComponent({ id: 'btn', component: 'Button' });
    expect(result.ok).toBe(false);
  });

  it('rejects Icon without required `name` field', () => {
    const result = parseComponent({ id: 'i', component: 'Icon' });
    expect(result.ok).toBe(false);
  });

  it('rejects Image without required `src` field', () => {
    const result = parseComponent({ id: 'img', component: 'Image' });
    expect(result.ok).toBe(false);
  });

  it('rejects ChoicePicker option missing value', () => {
    const result = parseComponent({
      id: 'p',
      component: 'ChoicePicker',
      options: [{ label: 'one' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects non-array children on container', () => {
    const result = parseComponent({
      id: 'row',
      component: 'Row',
      children: 'not-an-array',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects non-string component ref inside children array', () => {
    const result = parseComponent({
      id: 'row',
      component: 'Row',
      children: [123],
    });
    expect(result.ok).toBe(false);
  });

  it('rejection result carries structured issues (not Zod internals)', () => {
    const result = parseComponent({
      id: '',
      component: 'Row',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
      const [issue] = result.issues;
      expect(Array.isArray(issue.path)).toBe(true);
      expect(typeof issue.message).toBe('string');
    }
  });
});

describe('parseComponent — tolerance', () => {
  it('silently strips unknown fields on a known component', () => {
    // Haiku may emit hints we don't model. Strict rejection would be
    // too brittle here; drop extras rather than fail the whole frame.
    const result = parseComponent({
      id: 'title',
      component: 'Text',
      text: 'hello',
      futureHint: 'unknown-future-field',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.component === 'Text') {
      expect('futureHint' in result.value).toBe(false);
    }
  });

  it('rejects primitive input (parser needs an object)', () => {
    expect(parseComponent(null).ok).toBe(false);
    expect(parseComponent('string').ok).toBe(false);
    expect(parseComponent(42).ok).toBe(false);
  });
});
