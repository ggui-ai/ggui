/**
 * `@ggui-ai/gadgets` — v1 catalog of browser-capability hooks
 * for ggui's `DataContract.clientCapabilities`. Each hook conforms to
 * `GadgetHook<TOutput, TOptions>` from `@ggui-ai/protocol`.
 *
 * Contract authors declare a capability — `clientCapabilities.gadgets`
 * is keyed by npm package, then by export name:
 *
 *   ```ts
 *   clientCapabilities: {
 *     gadgets: {
 *       '@ggui-ai/gadgets': { useGeolocation: {} },
 *     },
 *   }
 *   ```
 *
 * The UI generator emits a matching import + call site in the
 * component code. Values surface to the agent via the contract's
 * inbound specs (`contextSpec` for state, `actionSpec` for events).
 *
 * Seven stdlib hooks ship: `useGeolocation`, `useClipboardWrite`,
 * `useClipboardPaste`, `useNotifications`, `useFilePicker`,
 * `useMicrophone`, `useCamera`.
 *
 * Also exports the wrapper-author SDK — `defineGadgetPackage` (general
 * builder for hook and/or component gadget packages) and
 * `createGguiGadget` (single-hook convenience) — plus the catalog
 * adapter port for push-time descriptor resolution.
 *
 * Re-exports the runtime types (`GadgetHook`,
 * `GadgetStatus`, `GadgetError`) so component code in the UI-generator
 * boilerplate can import them from a single
 * `@ggui-ai/gadgets` entry point without reaching into the
 * protocol package.
 */

export type {
  GadgetError,
  GadgetStatus,
  GadgetHook,
} from '@ggui-ai/protocol';

export {
  createGguiGadget,
  WrapperConformanceError,
  type GguiGadgetSpec,
  type GguiGadget,
} from './createGguiGadget';

export {
  defineGadgetPackage,
  type GadgetPackageSpec,
  type GadgetExportSpec,
  type GadgetHookExportSpec,
  type GadgetComponentExportSpec,
  type GadgetImpl,
} from './defineGadgetPackage';

export {
  type GadgetCatalogAdapter,
  InMemoryGadgetCatalog,
  CachingGadgetCatalog,
  type CachingGadgetCatalogOptions,
} from './catalog-adapter';

export {
  getPublicEnv,
  type GetPublicEnvOptions,
} from './getPublicEnv';

export {
  useGeolocation,
  type GeolocationCoords,
  type GeolocationOptions,
} from './useGeolocation';

export {
  useClipboardWrite,
  type ClipboardWriteOptions,
} from './useClipboardWrite';

export { useClipboardPaste } from './useClipboardPaste';

export {
  useNotifications,
  type NotificationOptions_ as NotificationOptions,
  type NotificationResult,
} from './useNotifications';

export {
  useFilePicker,
  type FilePickerOptions,
  type FilePickerResult,
  type PickedFile,
} from './useFilePicker';

export {
  useMicrophone,
  type MicrophoneOptions,
  type MicrophoneResult,
} from './useMicrophone';

export {
  useCamera,
  type CameraOptions,
  type CameraResult,
} from './useCamera';
