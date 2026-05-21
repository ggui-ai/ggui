// Accessibility regression guard for design-system primitives.
//
// The UI-gen LLM evaluator is told (in its mother prompt) exactly which
// ARIA each primitive bakes in, so it stops false-flagging accessible
// code. If a primitive silently loses a baked-in role/aria attribute,
// the evaluator's table goes stale — these tests fail first so the
// evaluator table gets updated in lockstep.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../Icon';
import { Progress } from '../Progress';
import { Spinner } from '../Spinner';
import { Skeleton } from '../Skeleton';
import { Alert } from '../Alert';

describe('Icon — decorative by default', () => {
  it('hides a Lucide icon from screen readers when no aria-label is given', () => {
    const html = renderToStaticMarkup(<Icon name="check" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });

  it('hides an emoji icon from screen readers when no aria-label is given', () => {
    const html = renderToStaticMarkup(<Icon name="☀️" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });

  it('exposes role="img" + the label for a meaningful Lucide icon', () => {
    const html = renderToStaticMarkup(<Icon name="check" aria-label="Saved" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Saved"');
    expect(html).not.toContain('aria-hidden');
  });

  it('exposes role="img" + the label for a meaningful emoji icon', () => {
    const html = renderToStaticMarkup(<Icon name="☀️" aria-label="Sunny" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Sunny"');
    expect(html).not.toContain('aria-hidden');
  });
});

describe('Progress — baked-in progressbar semantics', () => {
  it('always exposes a named progressbar with value bounds', () => {
    const html = renderToStaticMarkup(<Progress value={50} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Progress"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
  });

  it('uses the label prop as both the accessible name and visible text', () => {
    const html = renderToStaticMarkup(
      <Progress value={3} max={5} label="Survey progress" showLabel />,
    );
    expect(html).toContain('aria-label="Survey progress"');
    expect(html).toContain('Survey progress');
    expect(html).toContain('aria-valuemax="5"');
  });
});

describe('primitives that bake in their own ARIA', () => {
  it('Spinner is a status region', () => {
    expect(renderToStaticMarkup(<Spinner />)).toContain('role="status"');
  });

  it('Skeleton is decorative', () => {
    expect(renderToStaticMarkup(<Skeleton />)).toContain('aria-hidden="true"');
  });

  it('Alert is an alert region', () => {
    expect(renderToStaticMarkup(<Alert>Heads up</Alert>)).toContain('role="alert"');
  });
});
