/**
 * In-memory ConnectorRegistry — dev / test default.
 *
 * Seeded from a map at construction time. Not dynamic — registrations
 * are static for the lifetime of the instance. Callers that want
 * runtime mutability layer it in front; this reference adapter stays
 * the simplest thing that works.
 */
import type {
  ConnectorRegistry,
  RegisteredConnector,
} from '../connector-registry.js';

export class InMemoryConnectorRegistry implements ConnectorRegistry {
  private readonly byId: Map<string, RegisteredConnector>;

  constructor(seed: ReadonlyArray<RegisteredConnector> = []) {
    this.byId = new Map();
    for (const c of seed) {
      if (this.byId.has(c.id)) {
        throw new Error(
          `InMemoryConnectorRegistry: duplicate connector id "${c.id}"`,
        );
      }
      this.byId.set(c.id, c);
    }
  }

  async get(id: string): Promise<RegisteredConnector | null> {
    return this.byId.get(id) ?? null;
  }

  async list(): Promise<RegisteredConnector[]> {
    return Array.from(this.byId.values());
  }
}
