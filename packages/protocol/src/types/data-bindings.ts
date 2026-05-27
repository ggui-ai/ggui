/**
 * Client-side data-binding subsystem for React Native controllers.
 *
 * **NOT to be confused with {@link ClientCapabilitiesSpec} on
 * `DataContract.clientCapabilities`.** These types describe the
 * data-RESOLVER toolkit consumed by `@ggui-ai/ggui-react-native`
 * (`fetch` / `auth` / `storage` / `subscription` / `voice` / `camera` /
 * `chain` / `transform` / `merge`) — the controllers wire one of these
 * tool configs onto a binding name and the runtime resolves the value
 * at render time.
 *
 * `clientCapabilities.gadgets` is the wire-level declaration that the
 * UI calls a browser-capability hook (`useMicrophone` /
 * `useGeolocation` / `useClipboardWrite` / …); those hooks are
 * implemented in `@ggui-ai/gadgets` and surfaced into the
 * agent only when the UI threads their value into a `contextSpec` slot
 * or an `actionSpec` payload.
 *
 * The shared word "tool" is historical:
 *
 *   - `ClientToolName` here = a runtime data-resolver identifier.
 *   - `clientCapabilities.gadgets` = a package-keyed wire map
 *     (`Record<package, Record<exportName, GadgetExportUse>>`); the
 *     export name is the inner map key, not a field.
 *   - `agentCapabilities.tools` = MCP tool catalog.
 *
 * All three are distinct namespaces.
 */

import type { JsonObject, JsonValue } from './data-contract';
import type { EndUserIdentity } from './auth';

// ============================================================================
// Tool Names
// ============================================================================

/**
 * Available client-side tools
 */
export type ClientToolName =
  // Data tools
  | 'fetch' // HTTP requests
  | 'auth' // Authentication context
  | 'storage' // localStorage/sessionStorage
  | 'subscription' // Real-time subscriptions (WebSocket, SSE)
  // Device tools
  | 'voice' // Voice input/output
  | 'camera' // Camera access
  // Orchestration tools
  | 'chain' // Sequential execution
  | 'transform' // Data transformation
  | 'merge'; // Combine multiple sources

// ============================================================================
// Base Tool Configuration
// ============================================================================

/**
 * Base configuration for all tools.
 * Extends {@link JsonObject} for JSON serialization compatibility.
 * Generic `TConfig` defaults to {@link JsonObject} for the tool-specific configuration shape.
 */
export interface ClientToolConfig<TConfig extends JsonObject = JsonObject> extends JsonObject {
  tool: ClientToolName;
  config: TConfig;
  /**
   * Other bindings this depends on (resolved first in topological order)
   * Example: ['user'] means this tool waits for 'user' binding to resolve
   */
  dependsOn?: string[];
}

// ============================================================================
// Data Tools
// ============================================================================

/**
 * Fetch tool - HTTP requests with interpolation support
 *
 * Example:
 * ```
 * { tool: 'fetch', config: { endpoint: '/api/users/{user.id}' } }
 * ```
 */
export interface FetchToolConfig extends ClientToolConfig {
  tool: 'fetch';
  config: {
    /**
     * Endpoint with optional interpolation: '/api/users/{user.id}'
     * Values in braces are replaced from resolved dependencies
     */
    endpoint: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    /** Request body. Typed as {@link JsonValue} (any JSON-safe value). */
    body?: JsonValue;
    /**
     * Cache configuration
     */
    cache?: {
      /** Time-to-live in milliseconds */
      ttl: number;
      /** Cache key (defaults to endpoint) */
      key?: string;
    };
    /**
     * Transform response before returning
     * Dot path to extract: 'data.users' extracts response.data.users
     */
    extract?: string;
  };
}

/**
 * Auth tool - Access authentication context
 *
 * Example:
 * ```
 * { tool: 'auth', config: { field: 'currentUser' } }
 * ```
 */
export interface AuthToolConfig extends ClientToolConfig {
  tool: 'auth';
  config: {
    /**
     * Field to extract from auth context
     * - 'currentUser': Full user object
     * - 'userId': Just the user ID
     * - 'token': Access token
     * - 'isAuthenticated': Boolean
     */
    field: 'currentUser' | 'userId' | 'token' | 'isAuthenticated' | string;
  };
}

/**
 * Storage tool - localStorage/sessionStorage access
 *
 * Example:
 * ```
 * { tool: 'storage', config: { key: 'userPrefs', storage: 'local' } }
 * ```
 */
export interface StorageToolConfig extends ClientToolConfig {
  tool: 'storage';
  config: {
    key: string;
    storage?: 'local' | 'session';
    /** Default value if key doesn't exist. Typed as {@link JsonValue}. */
    defaultValue?: JsonValue;
    /** Parse as JSON (default: true) */
    parse?: boolean;
  };
}

/**
 * Subscription tool - Real-time data subscriptions
 *
 * Example:
 * ```
 * { tool: 'subscription', config: { channel: 'notifications/{user.id}' } }
 * ```
 */
export interface SubscriptionToolConfig extends ClientToolConfig {
  tool: 'subscription';
  config: {
    /** Channel/topic with optional interpolation */
    channel: string;
    /** Protocol type */
    type?: 'websocket' | 'sse' | 'polling';
    /** Polling interval in ms (for polling type) */
    interval?: number;
    /** Initial data before first message. Typed as {@link JsonValue}. */
    initialData?: JsonValue;
  };
}

// ============================================================================
// Device Tools
// ============================================================================

/**
 * Voice tool - Voice input/output
 */
export interface VoiceToolConfig extends ClientToolConfig {
  tool: 'voice';
  config: {
    mode: 'input' | 'output' | 'both';
    language?: string;
    continuous?: boolean;
  };
}

/**
 * Camera tool - Camera access
 */
export interface CameraToolConfig extends ClientToolConfig {
  tool: 'camera';
  config: {
    mode: 'photo' | 'video' | 'stream';
    facing?: 'user' | 'environment';
    resolution?: { width: number; height: number };
  };
}

// ============================================================================
// Orchestration Tools
// ============================================================================

/**
 * Chain tool - Sequential execution of tools
 * Each step receives previous result as {prev}
 *
 * Example:
 * ```
 * {
 *   tool: 'chain',
 *   config: {
 *     steps: [
 *       { tool: 'auth', config: { field: 'currentUser' } },
 *       { tool: 'fetch', config: { endpoint: '/api/dashboard/{prev.id}' } },
 *       { tool: 'transform', config: { pick: ['stats', 'notifications'] } }
 *     ]
 *   }
 * }
 * ```
 */
export interface ChainToolConfig extends ClientToolConfig {
  tool: 'chain';
  config: {
    /** Sequential tool steps, each receives previous result as {prev} */
    steps: ClientToolConfig[];
  };
}

/**
 * Transform tool - Data transformation
 *
 * Example:
 * ```
 * { tool: 'transform', config: { pick: ['name', 'email'], rename: { email: 'contactEmail' } } }
 * ```
 */
export interface TransformToolConfig<TDefaults extends JsonObject = JsonObject> extends ClientToolConfig {
  tool: 'transform';
  config: {
    /** Pick specific fields from data */
    pick?: string[];
    /** Omit specific fields from data */
    omit?: string[];
    /** Rename fields: { oldName: 'newName' } */
    rename?: Record<string, string>;
    /** Map array items through a transformation */
    mapArray?: {
      /** Field containing array */
      field?: string;
      /** Fields to pick from each item */
      pick?: string[];
      /** Fields to rename in each item */
      rename?: Record<string, string>;
    };
    /** Flatten nested object: 'user.profile' moves profile fields to top level */
    flatten?: string;
    /** Default values for missing fields */
    defaults?: TDefaults;
  };
}

/**
 * Merge tool - Combine multiple data sources
 *
 * Example:
 * ```
 * {
 *   tool: 'merge',
 *   config: { sources: ['user', 'profile', 'settings'] },
 *   dependsOn: ['user', 'profile', 'settings']
 * }
 * ```
 */
export interface MergeToolConfig extends ClientToolConfig {
  tool: 'merge';
  config: {
    /** Binding names to merge (must be in dependsOn) */
    sources: string[];
    /** How to handle conflicts */
    strategy?: 'first' | 'last' | 'deep';
    /** Rename sources in merged result */
    rename?: Record<string, string>;
  };
}

// ============================================================================
// Data Bindings
// ============================================================================

/**
 * Type-safe tool config union
 */
export type TypedToolConfig =
  | FetchToolConfig
  | AuthToolConfig
  | StorageToolConfig
  | SubscriptionToolConfig
  | VoiceToolConfig
  | CameraToolConfig
  | ChainToolConfig
  | TransformToolConfig
  | MergeToolConfig;

/**
 * Data bindings - map of binding names to tool configurations
 *
 * Example:
 * ```
 * const bindings: DataBindings = {
 *   user: { tool: 'auth', config: { field: 'currentUser' } },
 *   profile: {
 *     tool: 'fetch',
 *     config: { endpoint: '/api/users/{user.id}/profile' },
 *     dependsOn: ['user']
 *   }
 * };
 * ```
 */
export type DataBindings = Record<string, TypedToolConfig>;

// ============================================================================
// Tool Execution Types
// ============================================================================

/**
 * Context provided to tool execution.
 * Generic `TResolved` defaults to {@link JsonObject} for the resolved dependency values.
 */
export interface ToolContext<TResolved = JsonObject> {
  /** Resolved values from previous bindings */
  resolved: TResolved;
  /** Auth context (user, token, etc.) */
  auth?: {
    currentUser?: EndUserIdentity;
    userId?: string;
    token?: string;
    isAuthenticated: boolean;
  };
  /** App configuration */
  appId: string;
  renderId: string;
  /** Base URL for API calls */
  apiBaseUrl?: string;
}

/**
 * Result from tool execution
 */
export interface ToolResult<T = unknown> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Tool implementation interface
 */
export interface ClientTool<TConfig extends ClientToolConfig = ClientToolConfig> {
  name: ClientToolName;
  /**
   * Execute the tool with given config and context
   */
  execute(config: TConfig['config'], context: ToolContext): Promise<unknown>;
}

// ============================================================================
// Controller Props Types
// ============================================================================

/**
 * Controller metadata - describes what props a controller expects
 * Note: Actual controller components receive children as ReactNode,
 * but we use 'unknown' here to avoid React dependency in shared package.
 */
export interface ControllerPropSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description: string;
  /** Default value for this prop. Typed as {@link JsonValue}. */
  defaultValue?: JsonValue;
}
