/**
 * StreamBusContext — internal seam carrying `<GguiRender>`'s per-render
 * `StreamBus` (from `@ggui-ai/wire`) down to in-tree subscribers that
 * need full `StreamEnvelope`s rather than the `StreamDelivery` shape
 * `WireConfig.subscribe` hands out (today: `useChannelStream`, which
 * feeds `<ProvisionalRenderer>`'s `_ggui:preview` reducer).
 *
 * The bus carries the bounded reserved-channel replay ring, so a
 * subscriber that mounts AFTER frames arrived (the ack → provisional
 * mount race) is caught up synchronously — the same semantics the
 * iframe runtime's boot path has.
 *
 * `null` = no ambient `<GguiRender>` (standalone preview mounts).
 * There is no live channel in that state, so there are no frames to
 * deliver — consumers stay on their empty state, matching the
 * standalone no-op `WireConfig` posture in `DynamicComponent`'s
 * `EnsureWireContext`.
 */
import { createContext } from 'react';
import type { StreamBus } from '@ggui-ai/wire';

export const StreamBusContext = createContext<StreamBus | null>(null);
