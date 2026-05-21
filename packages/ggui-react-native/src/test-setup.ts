/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Global test setup for @ggui-ai/react-native
 *
 * Mocks react-native, AsyncStorage, NetInfo, and WebView
 * so tests can run in a plain Node environment.
 */
import { vi } from 'vitest';
import React from 'react';

// --- react-native mock ---

const appStateListeners: ((state: string) => void)[] = [];

vi.mock('react-native', async () => {
  const R = (await vi.importActual<typeof import('react')>('react'));

  return {
    AppState: {
      currentState: 'active',
      addEventListener: vi.fn((_event: string, handler: (state: string) => void) => {
        appStateListeners.push(handler);
        return { remove: () => { const i = appStateListeners.indexOf(handler); if (i >= 0) appStateListeners.splice(i, 1); } };
      }),
    },
    Platform: { OS: 'ios', Version: '17.0', select: (obj: Record<string, unknown>) => obj.ios ?? obj.default },
    PixelRatio: { get: () => 3 },
    Dimensions: {
      get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
      addEventListener: vi.fn((_event: string, _handler: () => void) => ({ remove: vi.fn() })),
    },
    Easing: {
      bezier: (x1: number, y1: number, x2: number, y2: number) => ({ _bezier: [x1, y1, x2, y2] }),
      linear: { _type: 'linear' },
    },
    Animated: {
      Value: class { constructor(public _value: number) {} },
      timing: vi.fn(() => ({ start: vi.fn() })),
      spring: vi.fn(() => ({ start: vi.fn() })),
    },
    AccessibilityInfo: {
      isReduceMotionEnabled: vi.fn(async () => false),
      addEventListener: vi.fn((_event: string, _handler: (enabled: boolean) => void) => ({
        remove: vi.fn(),
      })),
    },
    Linking: {
      openURL: vi.fn(async (_url: string) => undefined),
      canOpenURL: vi.fn(async (_url: string) => true),
      addEventListener: vi.fn((_event: string, _handler: (state: unknown) => void) => ({
        remove: vi.fn(),
      })),
    },
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T): T => styles },
    View: R.forwardRef(({ children, ...props }: any, ref: any) => R.createElement('View', { ...props, ref }, children)),
    Text: ({ children, ...props }: any) => R.createElement('Text', props, children),
    TextInput: (props: any) => R.createElement('TextInput', props),
    Image: (props: any) => R.createElement('Image', props),
    ScrollView: ({ children, ...props }: any) => R.createElement('ScrollView', props, children),
    Switch: (props: any) => R.createElement('Switch', props),
    Pressable: ({ children, ...props }: any) => R.createElement('Pressable', props, typeof children === 'function' ? children({ pressed: false }) : children),
    ActivityIndicator: (props: any) => R.createElement('ActivityIndicator', props),
    useColorScheme: () => 'light',
  };
});

// --- AsyncStorage mock (in-memory) ---

const asyncStore = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStore.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { asyncStore.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { asyncStore.delete(key); }),
    clear: vi.fn(async () => { asyncStore.clear(); }),
  },
}));

// --- NetInfo mock ---

let netInfoListener: ((state: { isConnected: boolean; isInternetReachable: boolean }) => void) | null = null;

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: vi.fn((listener: (state: { isConnected: boolean; isInternetReachable: boolean }) => void) => {
      netInfoListener = listener;
      return () => { netInfoListener = null; };
    }),
    fetch: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
  },
}));

// --- react-native-webview mock ---

vi.mock('react-native-webview', async () => {
  const R = (await vi.importActual<typeof import('react')>('react'));
  return {
    default: R.forwardRef((props: any, ref: any) => R.createElement('WebView', { ...props, ref })),
    WebView: R.forwardRef((props: any, ref: any) => R.createElement('WebView', { ...props, ref })),
  };
});

// Suppress unused import warning — React is needed for JSX in vi.mock factories
void React;

// Helpers to simulate state changes in tests
export function simulateAppStateChange(state: string): void {
  for (const listener of appStateListeners) {
    listener(state);
  }
}

export function simulateNetInfoChange(state: { isConnected: boolean; isInternetReachable: boolean }): void {
  netInfoListener?.(state);
}

export function clearAsyncStore(): void {
  asyncStore.clear();
}
