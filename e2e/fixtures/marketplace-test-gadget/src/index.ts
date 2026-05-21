/**
 * Test probe gadget — fires a deterministic `window.postMessage`
 * on first render so Playwright tests can wait for a known signal
 * (matches the postMessage-probe pattern referenced in `docs/testing.md`).
 *
 * NOT a real wrapper — the manifest passes the registry conformance
 * gate (kind=gadget, allowed imports, named hook export) and the hook
 * mounts the probe at first execution. Consumers should NOT call this
 * gadget for any production purpose.
 */
import { useEffect, useState } from 'react';

export function useTestProbe(props: { probeValue?: string } = {}): {
  probeValue: string;
  fired: boolean;
} {
  const probeValue = props.probeValue ?? 'OK';
  const [fired, setFired] = useState(false);

  useEffect(() => {
    if (fired) return;
    window.postMessage(
      { type: 'GGUI_TEST_PROBE_FIRED', payload: { value: probeValue } },
      '*',
    );
    setFired(true);
  }, [fired, probeValue]);

  return { probeValue, fired };
}
