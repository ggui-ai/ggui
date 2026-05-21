import { useState, useEffect, useRef } from 'react';
import { useWireContext } from './context';

export interface StreamResult<T> {
  /** Most recent payload delivered on this channel, or null if none received yet. */
  latest: T | null;
  /**
   * All payloads accumulated on this channel.
   *
   * - `mode: 'append'` deliveries are pushed to the tail (continuous stream).
   * - `mode: 'replace'` deliveries collapse `all` to a single-element array
   *   containing the latest payload — matching the channel's
   *   "full replacement" semantics.
   */
  all: T[];
  /**
   * Truthy after the channel has delivered an envelope with
   * `complete: true`. Subscribers flip into a "channel closed"
   * rendering state based on this signal; further deliveries on a
   * completed channel are still accumulated, since the underlying
   * wire doesn't enforce quiescence.
   */
  isComplete: boolean;
}

/**
 * Subscribe to deliveries on a named stream channel.
 *
 * Honors the channel's per-delivery `mode` ('append' vs 'replace')
 * and the optional `complete` terminal marker. Channels declared
 * `mode: 'replace'` on the spec typically emit every delivery with
 * `mode: 'replace'` — this hook folds them into a single-latest
 * value without accumulating history.
 *
 * @param channelName - Channel name from the session's streamSpec
 * @returns { latest, all, isComplete }
 */
export function useStream<T = unknown>(channelName: string): StreamResult<T> {
  const { subscribe } = useWireContext();
  const [latest, setLatest] = useState<T | null>(null);
  const [all, setAll] = useState<T[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const allRef = useRef(all);
  allRef.current = all;

  useEffect(() => {
    // `WireConfig<DataContract>.subscribe`'s handler receives
    // `StreamDelivery<WireStreamPayload<DataContract, N>>` — which
    // tightens to `StreamDelivery<unknown>`. The hook's `T` generic
    // narrows at the CALLER site (the caller expects their payload
    // shape); typed contract-bound usage rides through
    // `useContract(contract).useStream`. This is the loose → typed
    // boundary — the cast takes `unknown` out of the provider and
    // hands `T` to the caller's setState.
    return subscribe(channelName, (delivery) => {
      const typed = delivery.payload as T;
      setLatest(typed);
      if (delivery.mode === 'replace') {
        setAll([typed]);
      } else {
        setAll([...allRef.current, typed]);
      }
      if (delivery.complete) {
        setIsComplete(true);
      }
    });
  }, [channelName, subscribe]);

  return { latest, all, isComplete };
}
