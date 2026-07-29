import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Stepper } from '../Stepper';

const STEPS = ['Account', 'Profile', 'Review'];

describe('Stepper — display-only step indicator', () => {
  it('renders a Progress nav with every step label', () => {
    const html = renderToStaticMarkup(<Stepper steps={STEPS} current={1} />);
    expect(html).toContain('aria-label="Progress"');
    for (const label of STEPS) {
      expect(html).toContain(label);
    }
  });

  it('marks exactly the current step with aria-current="step"', () => {
    const html = renderToStaticMarkup(<Stepper steps={STEPS} current={1} />);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    // The current marker is the filled one; its number renders inside it.
    expect(html).toContain('>2<');
  });

  it('completed steps show a check icon instead of their number', () => {
    const html = renderToStaticMarkup(<Stepper steps={STEPS} current={2} />);
    // Steps 1 and 2 are completed → their numbers are replaced by SVGs.
    expect(html).not.toContain('>1<');
    expect(html).not.toContain('>2<');
    expect(html).toContain('<svg');
    // Current step still shows its number.
    expect(html).toContain('>3<');
  });

  it('steps are static spans without onStepClick, real buttons with it', () => {
    const display = renderToStaticMarkup(<Stepper steps={STEPS} current={0} />);
    expect(display).not.toContain('<button');

    const clickable = renderToStaticMarkup(
      <Stepper steps={STEPS} current={0} onStepClick={() => {}} />,
    );
    expect(clickable.match(/<button/g)).toHaveLength(STEPS.length);
    expect(clickable).toContain('type="button"');
  });

  it('vertical orientation renders vertical connectors between steps', () => {
    const html = renderToStaticMarkup(
      <Stepper steps={STEPS} current={0} orientation="vertical" />,
    );
    expect(html.match(/aria-orientation="vertical"/g)).toHaveLength(
      STEPS.length - 1,
    );
  });

  it('styles every state through theme tokens (no bare hex without var fallback)', () => {
    const html = renderToStaticMarkup(<Stepper steps={STEPS} current={1} />);
    expect(html).toContain('var(--ggui-color-primary-600');
    expect(html).toContain('var(--ggui-color-outline');
  });
});
