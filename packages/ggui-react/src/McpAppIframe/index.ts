/**
 * `<McpAppIframe>` barrel — generic MCP Apps iframe host for web.
 *
 * Re-exported at the package root (`@ggui-ai/react`) — consumers
 * import from the root barrel, not this path.
 */

export { McpAppIframe } from './McpAppIframe.js';
export type {
  McpAppIframeDimensions,
  McpAppIframePermissions,
  McpAppIframeProps,
  McpAppIframeRef,
} from './types.js';
export type { UiMessageEvent } from './dispatch.js';
