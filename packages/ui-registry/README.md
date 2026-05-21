# @ggui-ai/ui-registry

Source-contract for UI artifacts. Studio reads from this. Local
`ggui dev` exposes this. Cloud storage implements this. Publish
and pull are copy operations between two instances of this
contract.

## Three-layer model

| Layer                | Role                                                                               | Package                                          | Read this package? |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------ |
| **Registry**         | Source of UI artifacts — list / get / bundle / optional write / optional subscribe | `@ggui-ai/ui-registry` (this package)            | —                  |
| **Provider / Index** | Search / catalog seam — ranked retrieval over one or more registries               | `@ggui-ai/mcp-server-core` (`BlueprintProvider`) | Yes, consumes      |
| **Negotiator**       | Decision / ranking layer — registry-agnostic                                       | `@ggui-ai/negotiator`                            | No                 |

Dependency direction: negotiator → provider → registry. Never the
reverse.

## What this package is NOT

- A search engine (that's `BlueprintProvider`).
- A compiler (the registry serves bundles; it doesn't produce them).
- A sync engine (cache layering is a composable on top, not baked
  in).
- An auth layer (each implementation handles auth internally —
  local uses pairing tokens, cloud uses sessions; the interface is
  auth-neutral).

## Minimum contract

```ts
interface UiRegistry {
  list(): Promise<UiManifestEntry[]>;
  get(id: string): Promise<UiManifestEntry | undefined>;
  getBundle(id: string): Promise<UiBundle | undefined>;

  subscribe?(handler: (event: UiRegistryEvent) => void): () => void;
  write?(entry: UiManifestEntry, bundle?: UiBundle): Promise<WriteResult>;
  remove?(id: string): Promise<void>;

  readonly capabilities: {
    readonly writable: boolean;
    readonly observable: boolean;
  };
}
```

Reads are required. Writes and subscriptions are optional — probe
`capabilities` before calling. Full JSDoc on the types; no
implementation in this package.

## Status

- ✅ Types + shape tests
- ⏳ First implementation (local `ggui dev`)
- ⏳ Cloud implementation
