# @ggui-ai/project-config

> Schema and loader for `ggui.json` — the portable app/agent manifest for the [ggui](https://github.com/ggui-ai/ggui) protocol.

[![npm version](https://img.shields.io/npm/v/@ggui-ai/project-config.svg)](https://www.npmjs.com/package/@ggui-ai/project-config)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

`ggui.json` is the single source of truth for a ggui app: its identity, the agent entry point, storage, theme, primitives, and blueprints. This package owns the schema (a [Zod](https://zod.dev) document) and the loaders that read, validate, and write it.

## Install

```bash
npm install @ggui-ai/project-config
```

## Two entry points

| Import                         | Environment  | Contains                                                                                           |
| ------------------------------ | ------------ | -------------------------------------------------------------------------------------------------- |
| `@ggui-ai/project-config`      | browser-safe | Schema + pure parsers — no Node dependencies.                                                      |
| `@ggui-ai/project-config/node` | Node only    | Filesystem helpers (`findGguiJson`, `loadGguiJson`, `saveGguiJson`) plus everything from the root. |

The root barrel carries no `node:fs` imports, so it can run in a browser — for example to validate a manifest pasted into a web UI.

## Usage

```ts
// Browser-safe: validate a manifest object.
import { parseGguiJson, safeParseGguiJson } from "@ggui-ai/project-config";

const manifest = parseGguiJson(JSON.parse(rawText)); // throws on invalid input

const result = safeParseGguiJson(JSON.parse(rawText));
if (result.success) {
  // result.data is a validated GguiJsonV1
}
```

```ts
// Node: locate and load ggui.json from disk.
import { findGguiJson, loadGguiJson } from "@ggui-ai/project-config/node";

const path = findGguiJson(process.cwd()); // walks up the directory tree
if (path) {
  const manifest = loadGguiJson(path); // throws GguiJsonLoadError on failure
}
```

## Manifest shape

```json
{
  "schema": "1",
  "protocol": "<current PROTOCOL_VERSION>",
  "app": { "slug": "my-app", "name": "My App" },
  "agent": { "entry": "./agent.ts" }
}
```

`protocol` MUST match `PROTOCOL_VERSION` exported by `@ggui-ai/protocol` in the version installed.

Optional blocks: `storage` (renders / vectors / threads via `memory` or `sqlite`), `theme`, `primitives`, `blueprints`, `mcpMounts`, and `operator`. See the exported Zod schema for the full, authoritative shape.

## License

Apache 2.0
