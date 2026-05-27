/**
 * ConnectorRegistry — stable-identity resolver for external MCP servers.
 *
 * Introduced for inbound MCP Apps hosting. Today's only consumer
 * is MCP Apps outbound-host wiring — the inbound MCP Apps render
 * carries a `source.connectorId` (stable id), and the ggui proxy layer
 * resolves that id to an actual endpoint via this registry. Future
 * features that need to reference external MCP servers by stable id
 * (cross-server tool routing, connector-scoped auth, etc.) reuse the
 * same seam.
 *
 * Not MCP-Apps-specific by design — `RegisteredConnector.id` is just
 * an identifier, and the connector is just an MCP endpoint + auth
 * bits. Any future consumer that needs stable external-MCP identity
 * hooks into the same interface without a new one.
 *
 * Reference adapters:
 *   - `InMemoryConnectorRegistry` (this package's `/in-memory` entry)
 *     — test fixtures + dev.
 *   - `ggui.json#connectors` file-backed — follow-up slice.
 */

/**
 * A single registered external MCP server.
 *
 * Fields are deliberately minimal — this registry is about identity
 * + reachability, not about MCP server metadata (tool catalog etc.
 * belong to the source MCP server itself, fetched on demand).
 */
export interface RegisteredConnector {
  /**
   * Stable, URL-safe connector id. Persisted as
   * `McpAppsRender.source.connectorId`. Changing this id IS a
   * breaking operational change for renders that reference it.
   */
  readonly id: string;
  /** MCP server endpoint (absolute HTTP(S) URL). */
  readonly serverUrl: string;
  /** Optional bearer-token auth for the source server. */
  readonly auth?: {
    readonly bearer?: string;
  };
  /** Free-form adapter metadata — audit tags, owner notes, etc. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Runtime seam for resolving connector identity to an endpoint +
 * credentials.
 *
 * Implementations SHOULD be cheap (single map lookup) because the
 * resource-proxy and tools/call proxy paths hit this on every call.
 * Expensive implementations (network-backed registries) should wrap
 * a cache in front of this interface, not push work into it.
 */
export interface ConnectorRegistry {
  /** Return the connector for `id`, or `null` when unknown. */
  get(id: string): Promise<RegisteredConnector | null>;
  /** Enumerate every registered connector — admin / debugging. */
  list(): Promise<RegisteredConnector[]>;
}

/**
 * Typed error thrown by consumers when a render references an
 * unknown `connectorId`. Distinct class so transports can map to the
 * right error code; not thrown from inside the registry itself (the
 * registry just returns `null`).
 */
export class UnknownConnectorError extends Error {
  readonly connectorId: string;
  constructor(connectorId: string) {
    super(`Unknown connector id: ${connectorId}`);
    this.name = 'UnknownConnectorError';
    this.connectorId = connectorId;
  }
}
