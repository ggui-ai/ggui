# @ggui-ai/artifact-manifest

Strict [Zod](https://zod.dev) schemas and parsers for the two ggui marketplace artifact manifests:

- **`ggui.gadget.json`** — gadget bundles (reusable client capabilities).
- **`ggui.blueprint.json`** — cached UI blueprints (TSX + data contract).

Plus a discriminated union over both kinds for tooling that handles them generically (signing, registry upload, search-index ingestion).

Browser-safe — pure schema + parsers, no Node dependencies.

```bash
npm install @ggui-ai/artifact-manifest
```

## Usage

```ts
import {
  parseGadgetManifest,
  safeParseBlueprintManifest,
  parseArtifactManifest,
} from "@ggui-ai/artifact-manifest";

// Throws on invalid input, returns a typed GadgetManifest.
const gadget = parseGadgetManifest(json);

// Non-throwing — returns Zod's { success, data | error }.
const result = safeParseBlueprintManifest(json);

// Discriminated union — accepts either kind.
const artifact = parseArtifactManifest(json);
```

## Exports

| Symbol                                                                                | What it is                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `gadgetManifestSchema`, `parseGadgetManifest`, `safeParseGadgetManifest`              | Gadget manifest schema + parsers           |
| `blueprintManifestSchema`, `parseBlueprintManifest`, `safeParseBlueprintManifest`     | Blueprint manifest schema + parsers        |
| `artifactManifestSchema`, `parseArtifactManifest`, `safeParseArtifactManifest`        | Discriminated union over both kinds        |
| `manifestToRegistryEntry`                                                             | Translate a manifest into a registry entry |
| `GADGET_NAME_RE`, `BLUEPRINT_NAME_RE`, `ArtifactScopeSchema`, `ArtifactVersionSchema` | Shared name + version validators           |
| `GGUI_GADGET_JSON_FILENAME`, `GGUI_BLUEPRINT_JSON_FILENAME`                           | Canonical manifest filenames               |

`GadgetManifest`, `BlueprintManifest`, and `ArtifactManifest` types are exported alongside their schemas.

## License

Apache-2.0.
