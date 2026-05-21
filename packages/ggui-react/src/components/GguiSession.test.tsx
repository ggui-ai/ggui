import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GguiProvider } from './GguiProvider';
import { GguiSession } from './GguiSession';

describe('GguiSession', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <GguiProvider appId="app_123">{children}</GguiProvider>
  );

  it('renders children', () => {
    render(
      <GguiSession sessionId="sess_123">
        <div data-testid="child">Hello</div>
      </GguiSession>,
      { wrapper }
    );
    expect(screen.getByTestId('child')).toBeTruthy();
    expect(screen.getByTestId('child').textContent).toBe('Hello');
  });

  it('calls onSessionStart on mount', () => {
    const onSessionStart = vi.fn();
    render(
      <GguiSession sessionId="sess_123" onSessionStart={onSessionStart}>
        <div>Content</div>
      </GguiSession>,
      { wrapper }
    );
    expect(onSessionStart).toHaveBeenCalledWith({ sessionId: 'sess_123' });
  });

  it('calls onSessionEnd on unmount', () => {
    const onSessionEnd = vi.fn();
    const { unmount } = render(
      <GguiSession sessionId="sess_123" onSessionEnd={onSessionEnd}>
        <div>Content</div>
      </GguiSession>,
      { wrapper }
    );
    unmount();
    expect(onSessionEnd).toHaveBeenCalledWith(
      { sessionId: 'sess_123' },
      'unmount'
    );
  });

  it('calls onBeforeAction and sends event', () => {
    const onBeforeAction = vi.fn((data) => ({ ...data, transformed: true }));
    const onAfterAction = vi.fn();

    render(
      <GguiSession
        sessionId="sess_123"
        onBeforeAction={onBeforeAction}
        onAfterAction={onAfterAction}
      >
        {({ action }) => (
          <button onClick={() => action({ name: 'test' })}>Submit</button>
        )}
      </GguiSession>,
      { wrapper }
    );

    fireEvent.click(screen.getByText('Submit'));

    expect(onBeforeAction).toHaveBeenCalledWith(
      { name: 'test' },
      expect.any(Object)
    );
  });
});
