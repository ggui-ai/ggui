/**
 * `@ggui-ai/ui-registry` — source-contract barrel.
 *
 * Pure-types package today. Implementations (local `ggui dev`,
 * cloud, etc.) live in their own packages and depend on this one
 * for the shape. The wider model layers a UI registry, a provider,
 * and a negotiator on top of these contract types.
 */
export type {
  UiRegistry,
  UiRegistryCapabilities,
  UiRegistryEvent,
  UiManifestEntry,
  UiBundle,
  WriteResult,
} from './types.js';
