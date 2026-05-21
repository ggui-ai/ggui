# @ggui-ai/registry-server

OSS-runnable HTTP server for the **ggui marketplace registry**. Wraps [`@ggui-ai/registry-core`](https://github.com/ggui-ai/ggui/tree/main/registry-core) with [hono](https://hono.dev) + filesystem storage + bearer-token auth. Self-hostable via `npx @ggui-ai/registry-server` for local dev, CI, and enterprise on-prem deployments.

## Quick start

```bash
# Filesystem storage, bearer auth
npx @ggui-ai/registry-server \
  --storage fs:./registry-data \
  --token   $(openssl rand -hex 32) \
  --port    9001 \
  --bundle-host http://localhost:9001 \
  --registry-hostname localhost:9001

# In-memory storage (e2e / dev)
GGUI_REGISTRY_TOKEN=test-token \
  npx @ggui-ai/registry-server --storage memory --port 9001 \
    --bundle-host http://localhost:9001 \
    --registry-hostname localhost:9001
```

Once running:

```bash
ggui gadget publish --auth=bearer --token=$GGUI_REGISTRY_TOKEN \
  --registry=http://localhost:9001
```

## Routes

| Method | Path                                           | Auth   | Description                                                |
| ------ | ---------------------------------------------- | ------ | ---------------------------------------------------------- |
| GET    | `/healthz`                                     | none   | Liveness probe                                             |
| GET    | `/search`                                      | none   | Filtered scan over the public metadata rows                |
| GET    | `/pkg/:scope/:name`                            | none\* | List the version timeline for an artifact                  |
| GET    | `/pkg/:scope/:name/:version`                   | none\* | Read a published version (manifest + URLs)                 |
| POST   | `/publish`                                     | bearer | Publish a new artifact version (gadget or blueprint)       |
| POST   | `/author-keys`                                 | bearer | Register a publisher Ed25519 public key                    |
| POST   | `/conformance/check`                           | none   | Pre-flight conformance gate (the publish flow re-verifies) |
| GET    | `/bundles/:scope/:name/:version/bundle.js`     | none   | Serve a gadget bundle (immutable cache)                    |
| GET    | `/bundles/:scope/:name/:version/bundle.js.sig` | none   | Serve the signature envelope (immutable cache)             |
| GET    | `/bundles/:scope/:name/:version/manifest.json` | none   | Serve the manifest verbatim (immutable cache)              |

\* Reads of `visibility: 'private'` rows require bearer; unauthenticated callers see only public rows.

## Storage modes

- `--storage=fs:<path>` Filesystem — JSON row files under `<path>/state/`, blobs under `<path>/bundles/`. Persists across restarts.
- `--storage=memory` In-memory — process-local state. Wiped on restart. Used by the e2e suite + CI.

## Auth

Pass `--token=<token>` or set `GGUI_REGISTRY_TOKEN`. The server constant-time compares the `Authorization: Bearer <token>` header against the configured token. The verified caller subject is configurable via `--subject=<id>` (default: a hash prefix of the token).

## Non-goals

This server is **MVP-scoped** for self-hosters who want the marketplace surface without the AWS deployment cost. Out of scope for now:

- Rate limiting (use a reverse proxy)
- TLS termination (use a reverse proxy)
- Backup automation (the filesystem mode is single-machine)
- Per-org private artifact scoping (treat `visibility: 'private'` as a label, not enforcement)
- Sigstore transparency log integration

If you need any of the above, build your own transport on top of [`@ggui-ai/registry-core`](https://github.com/ggui-ai/ggui/tree/main/registry-core).

## Programmatic embedding

```ts
import { createRegistryServer } from "@ggui-ai/registry-server";
import { inMemoryRegistryStorage, inMemoryBundleStorage } from "@ggui-ai/registry-core";
import { createBearerAuthn } from "@ggui-ai/registry-server";

const handle = createRegistryServer({
  storage: inMemoryRegistryStorage(),
  bundleStorage: inMemoryBundleStorage({ bundleHost: "http://localhost:9001" }),
  authn: createBearerAuthn({ token: "test-token" }),
  port: 9001,
  bundleHost: "http://localhost:9001",
  registryHostname: "localhost:9001",
});

await handle.start();
// … use it …
await handle.stop();
```
