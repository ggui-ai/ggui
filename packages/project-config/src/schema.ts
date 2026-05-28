/**
 * `ggui.json` v1 — the OSS `ggui` server's runtime source of truth.
 *
 * When a developer runs `ggui serve`, the OSS server reads this file
 * to discover everything it needs: app identity, protocol version,
 * blueprint manifests, primitive packages, theme tokens, declared
 * adapter intent. The schema is framework-neutral — it describes
 * *the ggui app*, never the internal orchestration of any specific
 * agent runtime. LLM choice, system prompt, framework-specific tool
 * inventory belong in each framework's own config, not here.
 *
 * The manifest surface model:
 *
 * - `ggui.json`     — this file. Open. Root manifest.
 * - `ggui.ui.json`  — one per authored UI, colocated with source.
 *                     Indexed via `blueprints.include` globs.
 *
 * **Rules for extending:**
 *
 * 1. **Additive only within `schema: '1'`.** Optional fields with
 *    defaults are safe. New top-level fields MUST default to
 *    behavioural no-ops so older tooling can ignore them.
 * 2. **Framework-neutral.** If a field is meaningful only to one
 *    agent framework (Claude SDK, Vercel AI SDK, LangGraph, ADK,
 *    CrewAI, Mastra, etc.), it does NOT belong here. Same manifest
 *    describes the same ggui app across all frameworks.
 * 3. **Host-neutral.** Build / runtime / deploy / sizing fields live
 *    in a hosting-vendor overlay, never here.
 * 4. **No vendor names in enum values.** `residency: 'acme-cloud'`
 *    is the exact mistake a previous draft made. If an enum needs
 *    to name a hosting provider, it belongs in that provider's
 *    overlay.
 *
 * **Strictness (locked 2026-04-18):**
 *
 * Root object is strict — unknown top-level keys cause parse to
 * fail. This catches typos (`"blueprint"` singular, `"component"`
 * for `"primitives"`, etc.) and prevents silent drift toward the
 * agent-runtime-centric shape we explicitly rejected. Nested
 * objects are also strict for v1; additive fields are a coordinated
 * schema change, not a drive-by.
 */
import { z } from 'zod';
import {
  appPublicEnvSchema,
  parseAnyLlmRoute,
  strictGadgetDescriptorSchema,
  type LlmRoute,
} from '@ggui-ai/protocol';

/**
 * App slug — URL-safe identifier. 2–64 chars, lowercase
 * alphanumeric + hyphens, no leading/trailing hyphen. Used as a
 * namespace primitive by the ggui protocol for addressing.
 */
const SlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, {
    message:
      'Slug must be lowercase alphanumeric with hyphens, 2-64 chars, not starting or ending with a hyphen.',
  });

/**
 * ggui protocol version. Two accepted shapes:
 *
 *   - **Prelaunch draft-date** — `draft-YYYY-MM-DD` (e.g.,
 *     `draft-2026-04-19`). This is the canonical prelaunch form;
 *     `@ggui-ai/protocol#PROTOCOL_VERSION` currently ships this shape.
 *   - **Semver** — `major.minor`, `major.minor.patch`, with optional
 *     pre-release suffix (e.g., `1.0.0`, `2.0.0-alpha.1`). This becomes
 *     canonical once the protocol is frozen for launch (first release:
 *     `1.0.0`).
 *
 * The wire contract version this app speaks — distinct from the
 * `schema` field which versions the file format itself.
 *
 * Future tightening: could import a known-versions list from
 * `@ggui-ai/protocol` and validate membership. Deliberately left as
 * pattern-only for v1 to avoid the cross-package dep until a real
 * consumer benefits from the tighter check.
 */
const ProtocolVersionSchema = z
  .string()
  .regex(
    /^(draft-\d{4}-\d{2}-\d{2}|\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)$/,
    {
      message:
        'Protocol version must be `draft-YYYY-MM-DD` (prelaunch) or semver `major.minor[.patch][-pre-release]`.',
    },
  );

/**
 * App identity — the minimal set of fields every ggui consumer
 * needs to address this app. **Identity only.** No mode, no
 * framework, no LLM config, no runtime policy.
 */
const AppSchema = z.strictObject({
  slug: SlugSchema,
  name: z.string().min(1).max(120),
  /**
   * Per-app gadget catalog. The CLI
   * passes these through to `InMemoryAppMetadataStore` so the
   * handshake / push / ops handlers can validate every
   * `clientCapabilities.gadgets[*]` ref against the registered
   * set's package identity + export names. Each entry is a gadget
   * PACKAGE and MUST satisfy the strict
   * `strictGadgetDescriptorSchema` from `@ggui-ai/protocol`
   * (a non-empty `exports[]` array, each export carrying required
   * description / usage / example).
   *
   * Omitting this field falls back to the protocol's
   * `STDLIB_GADGETS` defaults (the 7 first-party hooks).
   * Declared 3rd-party wrappers (Leaflet, Mapbox, Stripe, …) land
   * here.
   */
  gadgets: z
    .array(strictGadgetDescriptorSchema)
    .optional(),
  /**
   * Public env channel. Operator-stamped key→value map that
   * the server projects (filtered to declared wrappers' `requires`)
   * onto `globalThis.__ggui__.publicEnv` so wrapper hooks can read
   * values via `getPublicEnv(key)`.
   *
   * Keys MUST match `GGUI_PUBLIC_APP_[A-Z0-9_]+` — the `GGUI_PUBLIC_USER_`
   * namespace is reserved for a future per-user channel. Values are
   * arbitrary strings; the server projects only keys whose values are
   * declared in some registered wrapper's `requires`. Operators who
   * declare a key without a value can use the empty string (the
   * Mapbox SDK will surface "Invalid token" on first request rather
   * than a missing-key error from the push gate).
   *
   * Omitting this field is equivalent to `{}` — wrappers without
   * `requires` work unchanged; wrappers that declare `requires` will
   * fail at push-gate validation if their required keys are missing.
   */
  publicEnv: appPublicEnvSchema.optional(),
  /**
   * App-default display-mode hint stamped on every `ggui_render` from
   * this app via `_meta.ui.displayMode`. Spec-aligned with MCP App
   * display literals (`'inline' | 'fullscreen' | 'pip'`).
   *
   * Honored by hosts as a PRESENTATION preference — `'fullscreen'`
   * says "render as a main view"; `'inline'` says "stack vertically in
   * the chat log"; `'pip'` says "render as picture-in-picture overlay".
   * The wire mechanism is identical regardless of mode (every push
   * stamps its own `_meta.ui.resourceUri` and every iframe goes
   * through the same runtime mount path); display mode controls ONLY
   * how the host arranges the iframes it mounts. Agents can override
   * per push via `ggui_render.input.displayMode`.
   *
   * Absent ⇒ no per-push hint stamped (host falls back to its own
   * default, typically `'inline'`).
   */
  defaultDisplayMode: z.enum(['inline', 'fullscreen', 'pip']).optional(),
});

/**
 * Operator identity — who's running this server. Surfaced on the
 * public welcome page at `/` so visitors see "operated by X" instead
 * of unbranded server chrome.
 *
 * **Privacy-first by default.** Every field is optional. Nothing is
 * shown when nothing is set — no "anonymous" placeholder, no
 * hostname-derived fallback. The visitor sees just server identity
 * and public-surface affordances (login link, share-link hints).
 *
 * Distinct from `app` (which identifies the *server*) — `operator`
 * identifies the *human/entity* running the server. A single
 * operator can run multiple `app`s, but the welcome page always
 * shows ONE operator block (one server = one ggui.json).
 *
 * **What this is NOT:**
 *   - Not auth (the admin token is its own credential)
 *   - Not telemetry (server doesn't phone home with operator info)
 *   - Not user/builder identity (those are MCP-pairing concerns)
 */
const OperatorSchema = z.strictObject({
  /** Display name shown on the welcome page. e.g. "Wanseob Lim" or
   * "Loqu Inc.". Free-form — no slug constraint. */
  name: z.string().min(1).max(200).optional(),
  /** Operator's homepage / brand URL. Linkified on the welcome page
   * if set. Must be a valid http(s) URL. */
  url: z
    .url({ message: 'operator.url must be a valid http(s) URL' })
    .optional(),
  /** One-line description shown under the operator name. e.g.
   * "personal ggui server — tinkering only" or "Loqu's hosted ggui
   * for friends + family". Plain text, no markup. */
  tagline: z.string().min(1).max(280).optional(),
  /** mailto-eligible contact address. Linkified as `mailto:` on the
   * welcome page if set. Operators uncomfortable putting this on a
   * public page should leave it unset — `name` and `url` carry the
   * "how to reach me" load just as well. */
  contact: z
    .email({ message: 'operator.contact must be a valid email' })
    .optional(),
});

/** Public type alias for the operator block. */
export type OperatorConfig = z.infer<typeof OperatorSchema>;

/**
 * Blueprint discovery block. Points at per-UI `ggui.ui.json`
 * manifests colocated with their TSX sources. The OSS server
 * resolves the globs at boot and indexes the matched manifests.
 *
 * Glob-based by design — adding a new UI is a filesystem
 * operation, not a `ggui.json` edit. If a project needs explicit
 * per-manifest declarations (mixed source roots, selective
 * registration), a `list` field can land later as an additive
 * union; for v1 the blessed path is globs.
 */
const BlueprintsSchema = z.strictObject({
  /** Glob patterns relative to the `ggui.json` directory. Each match
   * should resolve to a `ggui.ui.json` file. */
  include: z.array(z.string().min(1)).default([]),
});

/**
 * Primitive discovery block. Tells the OSS server where to find
 * the component primitives the UI generator can compose from.
 *
 * - `packages` — npm package specifiers (`@ggui-ai/design/primitives`,
 *   `@mycompany/ui`). The server resolves the package and
 *   enumerates its declared primitives. The exact package-level
 *   discovery convention (`package.json#ggui.primitives`,
 *   per-primitive manifests, etc.) is an open design question
 *   pending its own slice — the schema accepts the declaration
 *   shape regardless of which convention wins.
 * - `local` — glob patterns resolving to per-primitive manifest
 *   files (`ggui.primitive.json`) for primitives authored inside
 *   the project. Symmetric with `blueprints.include`.
 */
const PrimitivesSchema = z.strictObject({
  packages: z
    .array(z.string().min(1))
    .default(['@ggui-ai/design/primitives']),
  local: z.array(z.string().min(1)).default([]),
});

/**
 * Agent block — tells `ggui serve` where the user's agent lives.
 *
 * Only one field in v1: `entry`, a path (relative to the directory
 * containing `ggui.json`) to the agent's entrypoint. The `ggui serve`
 * command resolves this path, maps the extension to a spawn command
 * (`.js/.mjs/.cjs` → `node <entry>`; `.ts/.tsx/.mts` →
 * `node --import=tsx <entry>`), and supervises the subprocess
 * alongside the MCP server.
 *
 * Namespace justification: the thing we're pointing at IS the agent
 * (user code), not the "runtime" (the supervisor). `agent.*` has room
 * to grow (`agent.env`, `agent.port` if/when real needs surface); none
 * of that is in this slice. `app.agent` was rejected — `app.*` is
 * identity, not execution config. `runtime.*` was rejected — muddles
 * user-code vs supervisor.
 *
 * Deliberately not in v1: env vars, restart policies, port hints,
 * arg arrays. Every one of those fields has a reasonable default
 * (empty env / crash-and-exit / OS-assigned / no args) and can be
 * added additively later under `schema: '1'`.
 *
 * **Block-level optional**: The entire `agent` block is optional.
 * Absent means "run MCP-only" — `ggui serve` boots the MCP server
 * without attaching an agent loop.
 */
const AgentSchema = z.strictObject({
  /** Path to the agent's entry file, relative to the ggui.json
   * directory. Supported extensions: .js, .mjs, .cjs, .ts, .tsx,
   * .mts. Validation of extension happens at `ggui serve` time —
   * the schema stays permissive so malformed entries surface with
   * the CLI's error message (which can list supported extensions +
   * remediation), not a zod issue trace. */
  entry: z.string().min(1, 'agent.entry must not be empty'),
});

/**
 * Theme color mode. The same identifier the design registry uses
 * (`@ggui-ai/design`'s `ThemeMode`). Held here as a literal union
 * so project-config can validate without a runtime dep on design —
 * the two stay structurally identical (single source of truth is
 * the JSON wire shape, not either type alias).
 */
const ThemeModeSchema = z.enum(['light', 'dark']);

/**
 * Flat dot-path token overrides applied on top of a registered
 * preset's tokens.
 *
 * Keys are dot-paths into the DTCG token tree (`color.primary.500`,
 * `shape.radius.lg`, `font.family.sans`). Values replace the
 * resolved leaf's `$value`. Unknown paths are silently ignored at
 * load time — the console token editor mints valid keys, and an
 * accidentally-stale override should not fail manifest parse.
 *
 * Why flat (not deep tree): the editor mutates leaves one at a
 * time and serializes a diff; flat keys make the diff trivially
 * computable and `JSON.stringify` round-trip stable. Authoring by
 * hand is a side path.
 */
const ThemeOverridesSchema = z.record(z.string(), z.string());

/**
 * `theme: { preset, mode?, overrides? }` — pick a registered preset
 * from `@ggui-ai/design`'s registry. `preset` is the registry key
 * (e.g. `'claudic'`, `'ggui'`, `'premium-zen'`). The loader
 * returns an issue when the id is unregistered.
 */
const ThemePresetConfigSchema = z.strictObject({
  preset: z.string().min(1),
  mode: ThemeModeSchema.optional(),
  overrides: ThemeOverridesSchema.optional(),
});

/**
 * `theme: { file, mode? }` — load tokens from a project-relative
 * DTCG JSON file. The `mode` is metadata only (the file's tokens
 * ARE the resolved theme, not a switch); it propagates to consumers
 * that need to vary based on color scheme (e.g. injecting
 * `color-scheme: dark` on the document).
 */
const ThemeFileConfigSchema = z.strictObject({
  file: z.string().min(1),
  mode: ThemeModeSchema.optional(),
});

/**
 * Discriminated theme selection. Three accepted shapes:
 *
 *   1. `string` — preset id shorthand (`theme: 'claudic'` ≡
 *      `theme: { preset: 'claudic' }`)
 *   2. `{ preset, mode?, overrides? }` — registered preset with
 *      optional mode + override layer
 *   3. `{ file, mode? }` — DTCG JSON file
 *
 * Strict objects on shapes 2 and 3 reject unknown keys to catch
 * typos at parse (`{ presset: 'claudic' }` fails, not silently
 * loads default).
 */
export const ThemeConfigSchema = z.union([
  z.string().min(1),
  ThemePresetConfigSchema,
  ThemeFileConfigSchema,
]);

/**
 * Storage block — opt-in persistence wiring for the OSS `ggui serve`
 * runtime. Absent means **every storage surface stays in-memory** —
 * the zero-config OSS default (state resets on process restart).
 * Present means the operator has explicitly asked for the named
 * adapters; no surface ever silently creates a file on disk without
 * the operator declaring it here.
 *
 * ## Why `{sessions, vectors}` together
 *
 * Sessions + vectors are the two substantial persistence surfaces
 * the OSS server honors today. Shipping them in the same block from
 * v1 avoids a second schema churn when vectors or a future store
 * (e.g. threads) lands — there's one `storage` shape and each known
 * surface is an optional child. A future `storage.threads` or
 * `storage.blueprints` slice adds a sibling field without reshaping
 * the block.
 *
 * ## Why per-surface `driver`
 *
 * Explicit driver makes the choice visible at a glance — both to
 * the operator reading the file and to future adapters that land
 * against the same interfaces (`postgres`, `redis`, `libsql`, …).
 * A flat `sessions: "./path.sqlite"` shape would bake sqlite into
 * the schema and force a breaking redesign the first time another
 * driver landed.
 *
 * ## Why per-surface `path` instead of a shared root
 *
 * Sessions + vectors can (and typically should) live in separate
 * files: session data is small + hot-path; vector data is large +
 * append-heavy. Coupling them into one file conflates two different
 * IO profiles. Operators who want co-located storage can point both
 * paths at the same file — but the schema doesn't force that.
 *
 * ## Deliberately out of scope (v1)
 *
 *   - `driver: 'postgres' | 'redis' | …` — future additive unions
 *     once a reference adapter lands.
 *   - Connection pools, WAL pragma toggles, backup schedules — all
 *     real, all belong in an adapter-specific options block (not
 *     here) if they ever need to be surfaced.
 *   - `encryption` / `at-rest` settings — cross-cutting concern;
 *     not an OSS-v1 responsibility.
 *   - Secret expansion (`${VAR}` in paths) — operators can emit
 *     the manifest from templated input today; a schema-level
 *     token is a future additive.
 *
 * ## Strictness
 *
 * Root `storage` is strict — unknown surface keys (`sesions: …`,
 * `vectros: …`, `blueprints: …`) fail parse. Per-surface shapes
 * are discriminated on `driver`; each variant is strict so typos
 * like `{driver: 'sqlite', paht: './x'}` fail immediately.
 */
const StorageMemorySchema = z.strictObject({
  driver: z.literal('memory'),
});

const StorageSqliteSchema = z.strictObject({
  driver: z.literal('sqlite'),
  /** Filesystem path to the SQLite database file. Relative paths
   * resolve from the ggui.json directory at adapter-instantiation
   * time. Empty strings are rejected at parse. */
  path: z.string().min(1, 'storage.<surface>.path must not be empty'),
});

/**
 * Discriminated union over storage drivers. Add new drivers as
 * additive siblings under the same discriminator — never widen an
 * existing variant, since that would silently change what older
 * manifests mean.
 */
const StorageSurfaceSchema = z.discriminatedUnion('driver', [
  StorageMemorySchema,
  StorageSqliteSchema,
]);

const StorageSchema = z.strictObject({
  /** Session persistence (events + stack + identity). Absent =
   * in-memory (sessions reset on restart). */
  sessions: StorageSurfaceSchema.optional(),
  /** Vector index persistence (RAG, blueprint embeddings). Absent =
   * in-memory (index rebuilds on restart). */
  vectors: StorageSurfaceSchema.optional(),
  /** Persistent-chat thread + message persistence. Absent = in-memory
   * (threads vanish on restart — correct for dev, unsafe for any
   * deployment Portal's self-hosted flow talks to). Pair with
   * `driver: 'sqlite'` + a `path` for durable local storage; the
   * `@ggui-ai/mcp-server-core/sqlite#SqliteThreadStore` reference
   * impl consumes the same file-per-surface layout the sessions/
   * vectors drivers already use. */
  threads: StorageSurfaceSchema.optional(),
});

/**
 * Public type alias for one storage surface's config (sessions or
 * vectors). Callers instantiating adapters from a parsed manifest
 * pattern-match on `driver`.
 */
export type StorageSurfaceConfig = z.infer<typeof StorageSurfaceSchema>;

/** Public type alias for the full storage block. */
export type StorageConfig = z.infer<typeof StorageSchema>;

/**
 * Explicit LLM-route selection for UI generation. The operator
 * declares which `(provider, model)` the OSS `ggui serve` runs
 * against — eliminates the surprise where exporting `OPENAI_API_KEY`
 * silently picks the OpenAI default model.
 *
 * `model` accepts EITHER serialization:
 *   - **Canonical** — `provider:model` (e.g. `anthropic:claude-haiku-4-5-20251001`)
 *   - **LiteLLM compat** — `provider/model` (e.g. `anthropic/claude-haiku-4-5`)
 *
 * Parsed at schema-load time via `parseAnyLlmRoute` and surfaced
 * as a typed `LlmRoute` for downstream consumers (zero string
 * threading through the dispatch path).
 */
const GenerationSchema = z.strictObject({
  /**
   * Typed LLM route — `(provider, model)` parsed at the schema
   * boundary into a discriminated `LlmRoute`. See
   * `docs/principles/model-string-convention.md`.
   */
  model: z
    .string()
    .min(1, 'generation.model must not be empty')
    .transform((raw, ctx): LlmRoute => {
      const parsed = parseAnyLlmRoute(raw);
      if (!parsed) {
        ctx.addIssue({
          code: 'custom',
          message:
            `generation.model "${raw}" is not a recognized LlmRoute. ` +
            `Use the canonical form "provider:model" (e.g. ` +
            `"anthropic:claude-haiku-4-5-20251001") or the LiteLLM ` +
            `form "provider/model" (e.g. "anthropic/claude-haiku-4-5"). ` +
            `See docs/principles/model-string-convention.md.`,
        });
        return z.NEVER;
      }
      return parsed;
    }),
});

/**
 * Public type alias for the parsed generation block. `model` is the
 * typed `LlmRoute`, NOT the raw string — schema-side transform fires
 * at parse time so downstream consumers never see the string form.
 */
export type GenerationConfig = z.infer<typeof GenerationSchema>;

/**
 * Public type alias for the resolved theme selection (post-parse).
 *
 * `theme` in `ggui.json` accepts a string shorthand, a preset
 * config object, or a file config object. Consumers reading a
 * parsed `GguiJsonV1` pattern-match on shape (`typeof === 'string'`,
 * `'preset' in value`, `'file' in value`).
 */
export type ThemeConfig = z.infer<typeof ThemeConfigSchema>;

/**
 * The authoritative v1 schema. `z.infer<typeof GguiJsonV1>` yields
 * the static TypeScript type. A valid document round-trips cleanly:
 * parse → `JSON.stringify` → re-parse produces an equivalent value.
 *
 * **Required fields:** `schema`, `protocol`, `app`.
 * **Optional fields with defaults:** `blueprints`, `primitives`,
 * `adapters`. A zero-config `ggui.json` is just the three required
 * fields — the OSS server boots with defaults for everything else.
 * **Optional without default:** `theme` (absent = shipped default
 * tokens), `agent` (absent = `ggui serve` runs MCP-only).
 *
 * **Strict root:** unknown top-level keys are rejected.
 */
export const GguiJsonV1 = z.strictObject({
  /** File-format version — always `"1"` for v1. Distinct from
   * `protocol` (which versions the wire contract the app speaks). */
  schema: z
    .literal('1')
    .describe(
      'File-format version. Always "1" for v1. Distinct from `protocol` (which versions the wire contract the app speaks).',
    ),

  /** ggui wire protocol version the app speaks. */
  protocol: ProtocolVersionSchema.describe(
    'ggui wire protocol version the app speaks. Pinned per file-format version.',
  ),

  /** App identity. */
  app: AppSchema.describe(
    'App identity — slug + display name. Slug is the stable machine identifier; name is human-facing.',
  ),

  /** Operator identity — who's running this server. Optional;
   * surfaced on the public welcome page at `/` when set. Privacy-
   * first: nothing renders when nothing is set, no "anonymous"
   * placeholder. See {@link OperatorConfig}. */
  operator: OperatorSchema.optional().describe(
    'Operator identity surfaced on the public welcome page. All subfields optional; absent = no operator block rendered (privacy-first default).',
  ),

  /** Blueprint discovery. Defaults to no custom UIs declared. */
  blueprints: BlueprintsSchema.default({ include: [] }).describe(
    'Glob patterns the OSS server walks to discover authored UIs. Each match must point to a `ggui.ui.json` colocated with its TSX source. Empty default = no custom blueprints registered.',
  ),

  /** Primitive discovery. Defaults to the shipped
   * `@ggui-ai/design/primitives` package + no local primitives. */
  primitives: PrimitivesSchema.default({
    packages: ['@ggui-ai/design/primitives'],
    local: [],
  }).describe(
    'Where the server discovers UI primitives. `packages[]` lists npm packages shipping a `ggui.primitives.json` manifest; `local[]` lists project-relative manifest paths. Defaults to the shipped `@ggui-ai/design/primitives` package.',
  ),

  /**
   * Theme selection. Three accepted shapes:
   *
   * - **Shorthand string** — `theme: "claudic"`. Picks a preset from
   *   the `@ggui-ai/design` registry. Default mode is `'light'`.
   * - **Preset object** — `theme: { preset: "claudic", mode: "dark",
   *   overrides: { "color.primary.500": "#cc785c" } }`. Picks a
   *   registered preset, optional explicit mode, optional flat
   *   dot-path token overrides applied on top of the preset's
   *   tokens before CSS emission.
   * - **File object** — `theme: { file: "./theme.json", mode: "dark" }`.
   *   Loads tokens from a project-relative DTCG JSON file. The
   *   `mode` is metadata only — the file's tokens are the resolved
   *   theme; mode propagates to consumers that vary based on it
   *   (e.g. `color-scheme: dark` injection).
   *
   * Absent (`theme: undefined`) means use the shipped default tokens
   * from `@ggui-ai/design` (currently `lightTheme`).
   */
  theme: ThemeConfigSchema.optional().describe(
    'Theme selection. Accepts a preset id (string), a `{ preset, mode, overrides }` object, or a `{ file, mode }` object pointing at a DTCG JSON tokens file. Absent = shipped default tokens.',
  ),

  /** Agent-runtime config for `ggui serve`. Absent means the
   * command boots MCP-only (no agent loop attached). */
  agent: AgentSchema.optional().describe(
    'Agent-runtime config for `ggui serve`. Absent = command boots MCP-only (no agent loop attached).',
  ),

  /** Explicit storage adapter declarations. Absent means every
   * persistence surface stays in-memory (the zero-config OSS
   * default). Present means the operator has opted in per surface
   * — no surface silently creates a file on disk. See
   * {@link StorageConfig}. */
  storage: StorageSchema.optional().describe(
    'Per-surface storage adapter declarations. Absent = every persistence surface (sessions, threads, vectors, kv) stays in-memory (zero-config OSS default). Present = opt-in per surface; no surface silently creates a file on disk.',
  ),

  /**
   * Explicit UI-generation LLM route. Absent + a boot-time provider
   * key resolves → `ggui serve` hard-fails with an actionable error
   * pointing here. Absent + no key → graceful boot (the
   * Connect-Claude card flow handles per-user keys at request time).
   * Present → use this route verbatim; the schema-side
   * `parseAnyLlmRoute` transform yields a typed `LlmRoute` so the
   * dispatch path never sees a string.
   *
   * See {@link GenerationConfig}.
   */
  generation: GenerationSchema.optional().describe(
    'Explicit UI-generation LLM route. `model` accepts canonical `provider:model` or LiteLLM `provider/model` form. Absent + a boot key resolves → server hard-fails (operator must pick a model). Absent + no key → graceful per-user fallback flow.',
  ),

  /**
   * Default plugin-registry URL for this app.
   *
   * When the user runs `ggui install <scope/name@version>` or `ggui
   * publish` from this project, the CLI resolves the target registry
   * via a three-layer chain (highest priority wins):
   *
   *   1. Explicit `--registry=<url>` flag passed to the CLI.
   *   2. `GGUI_REGISTRY` environment variable.
   *   3. This `registry` field in `ggui.json`.
   *   4. (none → error) The CLI ships with NO hard-coded default;
   *      operators MUST pick a registry per app.
   *
   * Mirrors the npm `--registry` / `npm_config_registry` / `.npmrc`
   * resolution pattern but anchored on `ggui.json` for the project-
   * local layer (instead of a dotfile) — the same file that holds
   * `app.gadgets` is the natural place to declare which
   * marketplace those libraries come from.
   *
   * Validated as a URL at schema-parse time; the CLI does not
   * second-guess scheme / host beyond URL-shape (HTTPS recommendation
   * is enforced at install-time, not here, so dev fixtures pointing
   * at `http://localhost:<port>` parse cleanly).
   *
   * Absent = no project-local default; the CLI falls through to env
   * var or flag, and errors if neither is set.
   */
  registry: z
    .url({ message: 'registry must be a valid URL' })
    .optional()
    .describe(
      'Default plugin-registry URL for `ggui install` / `ggui publish`. Three-layer resolution: `--registry` flag > `GGUI_REGISTRY` env > this field > error if unset. Absent = no project-local default.',
    ),

  /**
   * Local MCP tool mounts — the operator-facing seam for declaring
   * additional tool surfaces that aggregate onto `/mcp` alongside
   * ggui-native tools (`ggui_render`, etc.). Each entry is a module
   * specifier:
   *
   *   - Relative paths (`./path/to/mount.js`, `../local/mcp.mjs`)
   *     resolve against the directory containing `ggui.json`. Must
   *     include the file extension — we do not guess `.js` vs
   *     `.mjs`. File must exist.
   *   - Bare npm specifiers (`@my-org/mcp-mount`, `some-pkg/entry`)
   *     resolve through Node's module resolver anchored at the
   *     project root.
   *
   * Each resolved module must export a `createGguiMcpMount` function
   * (or a default export) returning `{ name: string; handlers:
   * SharedHandler[] }` — i.e., an `McpServerMount` from
   * `@ggui-ai/mcp-server`. The factory owns its own state (backing
   * store, seed, etc.). Zero-argument today; arguments are a future
   * additive (widen the entry to `string | { module, options? }`).
   *
   * Default: `[]` (no mounts). Collisions between mount tool names
   * and ggui-native tool names (or between two mounts) are rejected
   * at `createGguiServer` composition time, not silently — see
   * `packages/mcp-server/src/mcp-mounts.ts::composeHandlersWithMounts`. */
  mcpMounts: z
    .array(
      z.string().min(1, 'mcpMounts entries must be non-empty module specifiers'),
    )
    .default([])
    .describe(
      'Local MCP tool mounts — each entry is a module specifier (relative path or bare npm specifier) exporting `createGguiMcpMount`. The factory returns `{name, handlers}` aggregated onto `/mcp` alongside ggui-native tools. Tool-name collisions are rejected at composition time.',
    ),
});

/** Static TypeScript type derived from the v1 schema. */
export type GguiJsonV1 = z.infer<typeof GguiJsonV1>;

/**
 * Canonical filename — always at the project root, always this
 * name. Exported so tooling uses the constant instead of
 * hard-coding the string.
 */
export const GGUI_JSON_FILENAME = 'ggui.json';

/**
 * Parse a raw JSON value into a validated {@link GguiJsonV1}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 *
 * Accepts any `unknown` — callers are expected to have already
 * decoded the JSON (`JSON.parse(source)`). Applies defaults for
 * absent optional fields.
 */
export function parseGguiJson(raw: unknown): GguiJsonV1 {
  return GguiJsonV1.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result
 * (`{ success: true, data }` vs `{ success: false, error }`). Prefer
 * this inside CLI tooling where you want to render the issue list
 * without try/catch.
 */
export function safeParseGguiJson(
  raw: unknown,
): ReturnType<typeof GguiJsonV1.safeParse> {
  return GguiJsonV1.safeParse(raw);
}
