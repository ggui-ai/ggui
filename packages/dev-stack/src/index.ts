/**
 * `@ggui-ai/dev-stack` — shared open dev engine for the ggui
 * protocol. Every CLI / host that runs the local dev loop
 * (`ggui dev` today, future `ggui dev --tunnel`, the local hub,
 * any closed-CLI compat shim) consumes this barrel.
 *
 * Layering:
 *
 *   @ggui-ai/ui-registry        — contract (types-only)
 *   @ggui-ai/project-config     — manifest schema / loaders
 *   @ggui-ai/agent-runtime      — agent runtime adapter seam
 *           │
 *           ▼
 *   @ggui-ai/dev-stack          — THIS PACKAGE: local engine
 *           │
 *           ▼
 *   @ggui-ai/cli                — `ggui` binary; thin shell
 *
 * Design rule: the agent framework is never hardcoded — one engine
 * composes under every host, with the runtime supplied via an
 * adapter seam.
 */

// Local UI registry
export {
  LocalUiRegistry,
  type LocalUiRegistryOptions,
  type LocalBundleResult,
  type BundleErrorLocation,
} from './local-registry/local-registry.js';

// Discovery — re-export from @ggui-ai/project-config/node for
// consumers that have historically imported these symbols from the
// dev-stack barrel. The canonical home is the schema-owner package;
// dev-stack's `LocalUiRegistry` consumes the same helper directly.
export {
  discoverLocalUis,
  discoverFromGguiJsonPath,
  type DiscoveredUi,
  type DiscoveryIssue,
  type DiscoveryResult,
  type DiscoverOptions,
} from '@ggui-ai/project-config/node';

// Compile-on-demand
export {
  compileUiOnDemand,
  resolveEntryFile,
  COMPILED_BUNDLE_CONTENT_TYPE,
  type CompileResult,
} from './local-registry/compile-ui.js';

// Watcher
export {
  createLocalWatcher,
  statOrNull,
  type LocalWatcher,
  type LocalWatcherOptions,
  type WatchListener,
} from './local-registry/watcher.js';

// HTTP dev server
export {
  startDevServer,
  type DevServerOptions,
  type DevServerHandle,
} from './dev-server/http.js';

// SSE event stream
export { openEventStream, type SseOptions } from './dev-server/events.js';

// Local dev hub — HTML shell served from the same server at `/hub`.
export {
  renderHubHtml,
  serveHubShell,
  type HubShellContext,
} from './dev-server/hub.js';

// Local dev hub — preview iframe shell served at `/hub/preview`.
export {
  renderHubPreviewHtml,
  serveHubPreviewShell,
  serveHubPreviewBundle,
  resolveHubPreviewBundlePath,
  extractSelectedId,
  type HubPreviewShellContext,
} from './dev-server/hub-preview.js';

// Auth / CORS policy
export {
  createSecurityPolicy,
  type CreatePolicyOptions,
  type DevServerSecurityPolicy,
  type PolicyOutcome,
} from './dev-server/auth.js';

// Orchestration — the seam every local-dev host composes against.
export {
  runDev,
  GguiDevError,
  DEFAULT_DEV_PORT,
  DEFAULT_DEV_HOST,
  type DevOptions,
  type DevBootstrap,
} from './run-dev.js';

// Runtime supervision — ring-buffered view of the supervised agent
// runtime, consumed by the CLI banner, the future hub, and the
// HTTP `/runtime/...` snapshot surface.
export {
  RuntimeSupervisor,
  DEFAULT_RUNTIME_BUFFER_SIZE,
  emptyRuntimeSnapshot,
  formatRuntimeEventLine,
  type RuntimeSupervisorOptions,
  type RuntimeStateSnapshot,
  type EmptyRuntimeStateSnapshot,
  type AnyRuntimeStateSnapshot,
  type RuntimeEventRecord,
} from './runtime-supervisor.js';
