/**
 * In-memory runner for the RenderIdentityStore conformance suite
 * (#457). Two runs: the default declaration (`'ephemeral'` — the
 * honest answer for process memory) and the binder-declared
 * `'durable'` variant test fixtures use when the store stands in for a
 * durable one — proving the declaration is the BINDER's and flows.
 */
import { describe } from 'vitest';
import { InMemoryRenderIdentityStore } from '../in-memory/render-identity-store.js';
import { runRenderIdentityStoreConformance } from './render-identity-store.conformance.js';

describe('InMemoryRenderIdentityStore', () => {
  runRenderIdentityStoreConformance('in-memory (default declaration)', {
    create: async () => new InMemoryRenderIdentityStore(),
    expectedDurability: 'ephemeral',
  });

  runRenderIdentityStoreConformance('in-memory (binder-declared durable)', {
    create: async () => new InMemoryRenderIdentityStore({ durability: 'durable' }),
    expectedDurability: 'durable',
  });
});
