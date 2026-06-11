# @ggui-ai/ui-registry

Source-contract for UI artifacts. Tooling reads from this. Local
`ggui dev` exposes this. Any remote registry implements this.

## Three-layer model

| Layer                | Role                                                                 | Package                                          | Read this package? |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------ | ------------------ |
| **Registry**         | Source of UI artifacts — list / get / bundle / optional subscribe    | `@ggui-ai/ui-registry` (this package)            | —                  |
| **Provider / Index** | Search / catalog seam — ranked retrieval over one or more registries | `@ggui-ai/mcp-server-core` (`BlueprintProvider`) | Yes, consumes      |
| **Negotiator**       | Decision / ranking layer — registry-agnostic                         | `@ggui-ai/negotiator`                            | No                 |

Dependency direction: negotiator → provider → registry. Never the
reverse.

## What this package is NOT

- A search engine (that's `BlueprintProvider`).
- A compiler (the registry serves bundles; it doesn't produce them).
- A sync engine (cache layering is a composable on top, not baked
  in).
- An auth layer (each implementation handles auth internally —
  local uses pairing tokens, remote implementations bring their own
  sessions; the interface is auth-neutral).
- A write surface (no publish/remove methods — the contract is
  read + subscribe; a write arm lands together with its first
  writable implementation).

## Minimum contract

```ts
interface UiRegistry {
  list(): Promise<UiManifestEntry[]>;
  get(id: string): Promise<UiManifestEntry | undefined>;
  getBundle(id: string): Promise<UiBundle | undefined>;

  subscribe?(handler: (event: UiRegistryEvent) => void): () => void;

  readonly capabilities: {
    readonly observable: boolean;
  };
}
```

Reads are required. Subscriptions are optional — probe
`capabilities.observable` before calling. Full JSDoc on the types;
no implementation in this package.

## Status

- ✅ Types + shape tests
- ✅ First implementation (local `ggui dev` — `LocalUiRegistry` in
  `@ggui-ai/dev-stack`, read + subscribe)
