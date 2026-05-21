# @ggui-ai/dev-stack

> Shared local dev engine for the [ggui](https://github.com/ggui-ai/ggui) protocol.

[![npm version](https://img.shields.io/npm/v/@ggui-ai/dev-stack.svg)](https://www.npmjs.com/package/@ggui-ai/dev-stack)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

This package is the engine behind `ggui dev`. It owns the local UI registry, compile-on-demand, a filesystem watcher with SSE, and a small read-only HTTP surface. It is framework-neutral — agent runtime supervision plugs in through an adapter seam, so no agent SDK is hardcoded.

Most developers consume this engine indirectly via [`@ggui-ai/cli`](https://www.npmjs.com/package/@ggui-ai/cli) (`ggui dev`). Install this package directly only if you are embedding the dev loop into your own tooling.

## Install

```bash
npm install @ggui-ai/dev-stack
```

## What's inside

| Area                | Exports                                                          |
| ------------------- | ---------------------------------------------------------------- |
| Orchestration       | `runDev`, `GguiDevError`, `DEFAULT_DEV_PORT`, `DEFAULT_DEV_HOST` |
| Local UI registry   | `LocalUiRegistry` — esbuild-backed compile-on-demand             |
| Compile-on-demand   | `compileUiOnDemand`, `resolveEntryFile`                          |
| Filesystem watcher  | `createLocalWatcher`                                             |
| HTTP dev server     | `startDevServer`, `openEventStream` (SSE)                        |
| Dev hub             | `renderHubHtml`, `serveHubShell`, `serveHubPreviewShell`         |
| Runtime supervision | `RuntimeSupervisor`, `formatRuntimeEventLine`                    |

## Usage

```ts
import { runDev } from "@ggui-ai/dev-stack";

const bootstrap = await runDev({
  serve: true,
  port: 6780,
  host: "127.0.0.1",
});

// bootstrap.server is bound and listening; close it to shut down.
await bootstrap.server?.close();
```

`runDev` reads `ggui.json` from the current project, discovers local UIs, and starts the dev server. Pass a `runtime` adapter to also supervise a local agent process.

## Layering

```
@ggui-ai/ui-registry      contract (types only)
@ggui-ai/project-config   manifest schema + loaders
@ggui-ai/agent-runtime    agent runtime adapter seam
        │
        ▼
@ggui-ai/dev-stack        this package — the local engine
        │
        ▼
@ggui-ai/cli              the `ggui` binary (thin shell)
```

## License

Apache 2.0
