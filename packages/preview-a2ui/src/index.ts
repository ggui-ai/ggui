/**
 * `@ggui-ai/preview-a2ui` — A2UI boundary for ggui's provisional
 * assembly channel.
 *
 * V1 scope:
 *   - Server → client write path only
 *   - Three messages: createSurface / updateComponents / deleteSurface
 *   - Narrow catalog (12 Basic Catalog components — see `./catalog`)
 *   - Non-interactive provisional rendering
 *
 * Anything outside this scope (data model, interactive actions,
 * broader catalog coverage) is deliberately deferred. Widen the
 * surface intentionally, not accidentally.
 *
 * Deps: `zod` only. No React, no React Native, no `@ggui-ai/protocol`
 * import — this package is framework-neutral and protocol-neutral.
 * The reserved `_ggui:preview` channel constant lives in
 * `@ggui-ai/protocol/validation/reserved-channels`; this package is
 * the other side of the boundary and must not couple to the protocol
 * root.
 */
export * from './catalog';
export * from './components';
export * from './messages';
