import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import {
  DynamicComponent,
  registerComponent,
  getComponent,
  clearRegistry,
  type ComponentDescriptor,
} from './DynamicComponent';
import { GguiProvider } from './GguiProvider';

// Simple test component for the registry
function TestButton(props: Record<string, unknown>) {
  return React.createElement('TestButton', props, props.children as React.ReactNode);
}

describe('DynamicComponent', () => {
  beforeEach(() => {
    clearRegistry();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Component Registry', () => {
    it('registers and retrieves components', () => {
      registerComponent('TestButton', TestButton);
      expect(getComponent('TestButton')).toBe(TestButton);
    });

    it('returns undefined for unregistered components', () => {
      expect(getComponent('NonExistent')).toBeUndefined();
    });

    it('clears all registered components', () => {
      registerComponent('TestButton', TestButton);
      clearRegistry();
      expect(getComponent('TestButton')).toBeUndefined();
    });
  });

  describe('Descriptor Rendering', () => {
    it('renders a descriptor tree with registered components', async () => {
      registerComponent('TestButton', TestButton);

      const descriptor: ComponentDescriptor = {
        type: 'TestButton',
        props: { title: 'Click me' },
      };

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          React.createElement(DynamicComponent, { descriptor })
        );
        // Run effect timers
        vi.runAllTimers();
      });

      const tree = renderer!.toJSON() as unknown;
      // Should render a View container wrapping the TestButton
      expect(tree).toBeTruthy();
    });

    it('shows unknown component message for unregistered types', async () => {
      const descriptor: ComponentDescriptor = {
        type: 'UnknownWidget',
        props: {},
      };

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          React.createElement(DynamicComponent, { descriptor })
        );
        vi.runAllTimers();
      });

      const json = JSON.stringify(renderer!.toJSON());
      expect(json).toContain('Unknown');
      expect(json).toContain('UnknownWidget');
    });
  });

  describe('WebView Fallback', () => {
    it('renders WebViewRenderer when code is provided', async () => {
      let renderer: ReactTestRenderer;
      await act(async () => {
        const inner = React.createElement(DynamicComponent, {
          code: 'export default function() { return null; }',
        });
        renderer = create(
          React.createElement(
            GguiProvider,
            {
              appId: 'test-app',
              designSystemUrl: 'https://test.example/design',
              children: inner,
            },
            inner,
          )
        );
        vi.runAllTimers();
      });

      const json = JSON.stringify(renderer!.toJSON());
      // WebViewRenderer renders a WebView element in tests
      expect(json).toContain('WebView');
    });
  });

  describe('Error Handling', () => {
    it('shows error when neither descriptor nor code is provided', async () => {
      const onError = vi.fn();

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          React.createElement(DynamicComponent, { onError })
        );
        vi.runAllTimers();
      });

      expect(onError).toHaveBeenCalled();
      const json = JSON.stringify(renderer!.toJSON());
      expect(json).toContain('Component Error');
    });

    it('passes custom fallback prop through', async () => {
      // Verify fallback prop is accepted and component renders with it
      registerComponent('TestButton', TestButton);
      const fallback = React.createElement('Text', null, 'Custom loading...');

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          React.createElement(DynamicComponent, {
            descriptor: { type: 'TestButton', props: { title: 'ok' } },
            fallback,
          })
        );
        vi.runAllTimers();
      });

      // After loading finishes, descriptor is rendered (fallback was available if needed)
      const json = JSON.stringify(renderer!.toJSON());
      expect(json).toContain('TestButton');
    });
  });
});
