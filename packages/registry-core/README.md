# @ggui-ai/registry-core

Pure-TypeScript registry operations + storage interfaces for the **ggui marketplace** — the shared business-logic layer behind the hosted ggui registry and the OSS-publishable [`@ggui-ai/registry-server`](https://github.com/ggui-ai/ggui/tree/main/registry-server). No I/O, no HTTP, no cloud SDK — operations take typed inputs + a `{ storage, bundleStorage, authn, clock }` deps bag and return discriminated-union results.

## Why this package exists

The registry's business logic — manifest validation, conformance gating, signature verification, version immutability — is identical regardless of where the registry runs. This package extracts that logic so:

- The hosted registry's transport layer is a thin shell over these ops.
- The OSS server is a [hono](https://hono.dev) + filesystem/memory adapter over the same ops.
- A third-party operator can build their own transport (Express, Fastify, gRPC) by implementing two storage interfaces.

## Architecture

```
@ggui-ai/registry-core (this package)
├── interfaces/
│   ├── RegistryStorage  — rows: artifacts, versions, compiled blobs, author keys
│   ├── BundleStorage    — blobs: bundle, signature, manifest
│   └── AuthnContext     — { subject: string } (vendor-neutral)
└── ops/
    ├── publishArtifact      — full publish flow with conformance + signing
    ├── readArtifact         — visibility-aware read + 410 on yanks
    ├── listArtifactVersions — semver-ordered version timeline
    ├── searchArtifacts      — filtered scan over metadata rows
    ├── registerAuthorKey    — register a publisher Ed25519 public key
    └── checkConformance     — static manifest + bundle/source validation gates
```

An "artifact" is the umbrella noun: the registry stores both **gadgets** (compiled UI components/hooks) and **blueprints** (TSX UI sources), discriminated by `kind`.

## Quick start

```ts
import {
  publishArtifact,
  inMemoryRegistryStorage,
  inMemoryBundleStorage,
} from "@ggui-ai/registry-core";

const result = await publishArtifact(
  { manifest, bundle: bundleB64, bundleSha384, signature },
  {
    storage: inMemoryRegistryStorage(),
    bundleStorage: inMemoryBundleStorage({ bundleHost: "http://localhost:9001" }),
    authn: { subject: "user-1" },
    clock: () => new Date(),
    registryHostname: "localhost:9001",
  }
);

if (result.ok) {
  console.log(result.body.installCommand);
} else {
  console.error(result.status, result.body);
}
```

## Contract tests

Every storage impl runs the same contract suite, so behavior drift between impls is caught at the contract level:

```ts
import { registryStorageContract } from "@ggui-ai/registry-core/testing";
import { inMemoryRegistryStorage } from "@ggui-ai/registry-core";

describe("memory impl", () => {
  registryStorageContract(() => inMemoryRegistryStorage());
});
```

The OSS filesystem adapter and the hosted adapter both run this suite.

## License

Apache-2.0
