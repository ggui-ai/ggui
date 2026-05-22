import { useEffect, useState } from 'react';

export function useTestProbe(props = {}) {
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
