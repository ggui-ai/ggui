/**
 * Adapter registry pass-through tests.
 *
 * The declaration-is-a-grant model was retired in Bucket B
 * (2026-05-18, LOCKED-22). Grant decisions now live entirely on
 * `clientCapabilities.gadgets[*].permission` (the iframe's
 * Permissions-Policy header derives from there). The SDK's
 * `adapterImpls` registry is purely a runtime implementation slot —
 * the Provider passes whatever the host wires verbatim, and
 * `useAdapter(name)` returns whatever's there.
 *
 * These tests pin the simplified semantics: no filtering, no warning,
 * no manifest-mirror prop.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import {
  GguiProvider,
  useAdapter,
  useGguiContext,
  type AdapterRegistry,
} from '../components/GguiProvider';

// Augment the registry for this test file only — lets us exercise
// typed slots without depending on any external capability package.
declare module '../context/GguiContext' {
  interface AdapterRegistry {
    camera?: { mark: 'camera-impl' };
    bluetooth?: { mark: 'bt-impl' };
  }
}

function harness(
  children: ReactNode,
  props: { adapterImpls?: AdapterRegistry } = {},
) {
  return render(
    <GguiProvider appId="test" adapterImpls={props.adapterImpls}>
      {children}
    </GguiProvider>,
  );
}

describe('AdapterRegistry — runtime impl pass-through', () => {
  it('useAdapter returns the impl the host wired', () => {
    let captured: AdapterRegistry['camera'] | undefined;
    function Probe() {
      captured = useAdapter('camera');
      return null;
    }
    harness(<Probe />, {
      adapterImpls: { camera: { mark: 'camera-impl' } },
    });
    expect(captured).toEqual({ mark: 'camera-impl' });
  });

  it('useAdapter returns undefined when no impl is registered', () => {
    let captured: AdapterRegistry['camera'] | undefined = { mark: 'camera-impl' };
    function Probe() {
      captured = useAdapter('camera');
      return null;
    }
    harness(<Probe />, { adapterImpls: {} });
    expect(captured).toBeUndefined();
  });

  it('passes the entire adapterImpls registry to the context verbatim', () => {
    let registry: AdapterRegistry | undefined;
    function Probe() {
      registry = useGguiContext().adapterImpls;
      return null;
    }
    harness(<Probe />, {
      adapterImpls: {
        camera: { mark: 'camera-impl' },
        bluetooth: { mark: 'bt-impl' },
      },
    });
    expect(registry).toBeDefined();
    expect(Object.keys(registry!).sort()).toEqual(['bluetooth', 'camera']);
    expect(registry!.camera).toEqual({ mark: 'camera-impl' });
    expect(registry!.bluetooth).toEqual({ mark: 'bt-impl' });
  });

  it('empty impls: context registry is empty', () => {
    let registry: AdapterRegistry | undefined;
    function Probe() {
      registry = useGguiContext().adapterImpls;
      return null;
    }
    harness(<Probe />, {});
    expect(registry).toEqual({});
  });
});
