import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider } from './ThemeProvider';

describe('ThemeProvider', () => {
  it('renders children inside a wrapper with the resolved color scheme', () => {
    const { getByTestId, getByText } = render(
      <ThemeProvider colorScheme="dark">
        <span data-testid="child">hello</span>
      </ThemeProvider>,
    );
    expect(getByText('hello')).toBeTruthy();
    const wrapper = getByTestId('child').parentElement;
    expect(wrapper?.getAttribute('data-ggui-color-scheme')).toBe('dark');
  });

  it('falls back to a system scheme when colorScheme is omitted', () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <span data-testid="child">hello</span>
      </ThemeProvider>,
    );
    const wrapper = getByTestId('child').parentElement;
    const attr = wrapper?.getAttribute('data-ggui-color-scheme');
    expect(attr === 'light' || attr === 'dark').toBe(true);
  });
});
