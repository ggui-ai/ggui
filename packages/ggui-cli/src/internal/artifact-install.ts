/**
 * `ggui gadget install <scope/name>@<version>` — fetch a published
 * gadget/blueprint from the marketplace registry, verify its signature
 * + SRI, and append it to the consuming project's `ggui.json`.
 *
 * Consumer-side counterpart to `gadget publish`. The end-to-end model
 * is:
 *
 *   1. Author writes a gadget, runs `ggui gadget publish` → uploads
 *      `{manifest, bundle, signature}` to the registry (`POST /publish`).
 *   2. Consumer runs `ggui gadget install @scope/name@1.0.0` → this
 *      module fetches `GET /pkg/<scope>/<name>/<version>`, downloads
 *      `bundleUrl` + `signatureUrl`, recomputes SRI + Ed25519 signature,
 *      and writes a {@link GadgetDescriptor}-shaped row into the
 *      app's `ggui.json#app.gadgets`.
 *
 * **HTTP contract (mirrors the registry read handler).**
 *
 *   GET <registry>/pkg/<scope>/<name>/<version>
 *     200: { manifest, bundleUrl?, bundleSri?, signatureUrl?, compiledBytes?, publishedAt, publishedBy }
 *     403: { error: 'forbidden', message }   — private artifact (install
 *          sends no credentials, so private rows are uninstallable from
 *          the CLI today; the error copy says exactly that)
 *     404: { error: 'not_found', message }   — artifactId/version unknown
 *     410: { manifest, …, publishedAt, publishedBy } — yanked (body shape = ReadPkgResponse)
 *     other 4xx/5xx: { error, message }
 *
 *   GET <bundleUrl>  → raw esbuild output (presigned S3)
 *   GET <signatureUrl> → JSON-encoded {@link Ed25519Signature}
 *
 * **Verification chain.** Two independent integrity checks MUST both
 * pass before any disk write:
 *
 *   - **SRI** — the iframe-runtime enforces `<script integrity=…>` on
 *     load, so we must agree with it. Recompute `sha384(bundleBytes)`
 *     and compare against the manifest's published `bundleSri`. SRI
 *     hash must match `sha384-<base64>` form verbatim.
 *
 *   - **Ed25519** — recompute the bundle hash, confirm it matches the
 *     signature's `bundleSha384`, then run the signature against the
 *     author's public key. When the registry read handler does not
 *     return the author's `publicKey`, signature verification cannot
 *     run: a warning is printed and the check is skipped unless
 *     `--strict` is set, in which case install exits 1.
 *
 * **Blueprint branch.** Blueprints carry their TSX in `manifest.source`
 * (the registry stores the canonical compiled JS in a separate
 * two-layer blob keyed by `compiledDigest`; the CLI install writes the
 * raw TSX for local-dev editability — the cloud install path consumes
 * the compiled bytes). No `bundleUrl`. The signature is over the
 * canonical-JSON form of the manifest (sorted keys), matching the
 * publish-side `canonicalJson()` helper. Installed blueprints are
 * materialized to `.ggui/installed-blueprints/<id>/` and registered as
 * a filesystem glob in `ggui.json#blueprints.include`. A blueprint
 * with no `contract` field is verified but not materialized, since
 * `UiManifest.contract` is required.
 *
 * Kept side-effect-free at module load. All IO threads through the
 * injectable seams on {@link RunArtifactInstallDeps} so tests stub
 * `fetch` + `cwd` + writers without touching globals.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha384 } from '@noble/hashes/sha512.js';
import {
  manifestToRegistryEntry,
  parseArtifactManifest,
  type ArtifactManifest,
} from '@ggui-ai/artifact-manifest';
import {
  canonicalJson,
  derivePublicKeyId,
  isGadgetSignature,
  type GadgetSignature,
  type VerifyResult,
  verifyBundleEd25519,
  verifyBundleSigstore,
} from '@ggui-ai/gadget-signing';
import {
  FATAL_CATALOG_LINT_CODES,
  lintGadgetCatalog,
  resolveAppGadgets,
  strictGadgetDescriptorSchema,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
import { z } from 'zod';
import { READ_ERROR_CODES, type ArtifactKind, type ReadErrorBody } from '@ggui-ai/registry-core';
import {
  FIND_MAX_DEPTH,
  findGguiJson,
  readGadgetsFromGguiJson,
  readGguiJson,
  writeGguiJson,
  type GguiJsonObject,
} from './ggui-json.js';
import { DEFAULT_REGISTRY_URL, resolveRegistryUrl } from './registry-url.js';

/** Artifact-kind discriminator (canonical type owned by
 * `@ggui-ai/registry-core`) — the verb the operator typed
 * (`gadget` vs `blueprint`). Enforced against the registry-served
 * manifest's `kind` discriminator. */
export type { ArtifactKind };

/* -------------------------------------------------------------------------- */
/* Flag parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolved flags accepted by {@link runArtifactInstall}. Built by
 * {@link parseArtifactInstallFlags} from argv or constructed directly
 * from object literals in tests.
 */
export interface InstallFlags {
  /** CLI verb the operator typed — enforced against the manifest kind. */
  readonly kind: ArtifactKind;
  /** `@scope/name` form, e.g. `@my-org/weather-card`. */
  readonly artifactId: string;
  /** SemVer string the user typed after `@`. Required. */
  readonly version: string;
  /** Override the registry URL — highest precedence. */
  readonly registry?: string;
  /** Skip interactive `publicEnv` prompts; missing required keys → warning + exit 0. */
  readonly noPrompt: boolean;
  /** Fail-hard on skipped signature verification (vs. warn + continue). */
  readonly strict: boolean;
  /**
   * Optional OIDC-identity assertion for sigstore-signed gadgets.
   * When set, install demands the bundle's Fulcio leaf-cert subject
   * matches the supplied pattern. Pass as a literal subject string
   * (e.g. `alice@example.com`); the signature-verify implementation
   * decides literal-vs-regex semantics. No effect on Ed25519-signed
   * gadgets — those root in the registry-pinned `authorPublicKey`.
   */
  readonly verifyIdentity?: string;
}

/**
 * `{ error: '__help__' }` carries the help-requested case so the CLI
 * driver can write {@link GADGET_INSTALL_HELP} to stdout without
 * misclassifying it as a usage error. All other `error` strings are
 * stderr-bound diagnostics.
 */
export type ParsedInstallFlags = InstallFlags | { error: string };

/**
 * Build verb-specific help text. Takes the `kind` so the rendered
 * lines say `ggui gadget install` / `ggui blueprint install` rather
 * than a generic placeholder.
 */
export function buildInstallHelp(kind: ArtifactKind): string {
  const verb = `ggui ${kind} install`;
  const extra =
    kind === 'gadget'
      ? '  Gadgets are appended to ggui.json#app.gadgets[].\n'
      : '  Blueprints are materialized to .ggui/installed-blueprints/<id>/.\n';
  return `${verb} — fetch + verify + register a ${kind} from the marketplace

Usage:
  ${verb} <scope/name>@<version> [options]

Arguments:
  <scope/name>@<version>    Full install identifier. Scope MUST start
                            with \`@\`. Version MUST follow the publish-
                            side SemVer rule (no \`latest\`, no ranges).

Options:
  --registry <url>          Override the registry URL. Resolution:
                            flag > GGUI_REGISTRY env >
                            ggui.json#registry > default
                            (\`${DEFAULT_REGISTRY_URL}\`).
  --no-prompt               Skip interactive prompts for any
                            \`publicEnv\` keys the gadget's manifest
                            declares as required. Missing keys surface
                            as warnings + exit 0; the operator wires
                            them in by hand afterwards.
  --strict                  Fail (exit 1) if signature verification is
                            skipped for any reason. Default behavior
                            warns + continues — the registry's
                            \`GET /pkg\` response doesn't yet expose
                            the author's public key, so signatures
                            verify only when an out-of-band key is
                            wired in.
  --verify-identity <patt>  Sigstore-signed gadgets only. Demand the
                            bundle's Fulcio leaf-cert OIDC subject
                            matches \`<patt>\`. Pattern is a literal
                            subject string today; a future verify
                            impl may extend to regex. No effect on
                            Ed25519-signed (private) gadgets.
  --help, -h                Show this help.

Effect on disk:
${extra}
Examples:
  ${verb} @my-org/weather-card@0.1.0
  ${verb} @my-org/leaflet@2.3.1 --registry=https://r.example.com
  ${verb} @my-org/leaflet@2.3.1 --no-prompt --strict
`;
}

/**
 * Parse `args` (the argv tail after `ggui {gadget,blueprint} install`)
 * into {@link InstallFlags}. The `kind` parameter is the verb the
 * operator typed — it's stamped onto the returned flags so the
 * downstream {@link runArtifactInstall} can enforce manifest-kind
 * alignment without re-parsing argv.
 *
 * Returns an `{ error }` object on usage failure so the CLI driver
 * branches without try/catch. `'__help__'` is the sentinel for
 * `--help`; every other `error` is stderr-bound copy.
 */
export function parseArtifactInstallFlags(
  kind: ArtifactKind,
  args: readonly string[],
): ParsedInstallFlags {
  let positional: string | undefined;
  let registry: string | undefined;
  let noPrompt = false;
  let strict = false;
  let verifyIdentity: string | undefined;

  /** `--name value` and `--name=value` both supported. */
  function readValue(
    arg: string,
    nextIdx: number,
  ): { value: string; advance: number } | null {
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      const v = arg.slice(eq + 1);
      if (v.length === 0) return null;
      return { value: v, advance: 0 };
    }
    const next = args[nextIdx];
    if (typeof next !== 'string' || next.length === 0) return null;
    return { value: next, advance: 1 };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      return { error: '__help__' };
    }
    if (arg === '--no-prompt') {
      noPrompt = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--registry' || arg.startsWith('--registry=')) {
      const read = readValue(arg, i + 1);
      if (read === null) {
        return { error: '--registry requires a value' };
      }
      registry = read.value;
      i += read.advance;
      continue;
    }
    if (arg === '--verify-identity' || arg.startsWith('--verify-identity=')) {
      const read = readValue(arg, i + 1);
      if (read === null) {
        return { error: '--verify-identity requires a value' };
      }
      verifyIdentity = read.value;
      i += read.advance;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `unknown flag: ${arg}` };
    }
    if (positional === undefined) {
      positional = arg;
      continue;
    }
    return { error: `unexpected positional argument: ${arg}` };
  }

  if (positional === undefined) {
    return {
      error:
        'missing positional argument: <scope/name>@<version> (e.g. @my-org/leaflet@1.0.0)',
    };
  }

  // Split `<scope/name>@<version>` on the LAST `@` — the scope's
  // leading `@` matches a literal at position 0 and must not be
  // mistaken for the version separator.
  const lastAt = positional.lastIndexOf('@');
  if (lastAt <= 0) {
    return {
      error: `invalid install identifier: ${positional} — expected <scope/name>@<version>`,
    };
  }
  const artifactId = positional.slice(0, lastAt);
  const version = positional.slice(lastAt + 1);
  if (!artifactId.startsWith('@') || artifactId.indexOf('/') === -1) {
    return {
      error: `invalid artifactId: ${artifactId} — expected \`@scope/name\``,
    };
  }
  if (version.length === 0) {
    return {
      error: `invalid version: empty (expected SemVer after \`@\`)`,
    };
  }

  return {
    kind,
    artifactId,
    version,
    ...(registry !== undefined ? { registry } : {}),
    noPrompt,
    strict,
    ...(verifyIdentity !== undefined ? { verifyIdentity } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Wire shape (mirrored from the registry's HTTP response types)              */
/* -------------------------------------------------------------------------- */

/**
 * `GET /pkg/{scope}/{name}/{version}` body.
 *
 * This mirrors the registry's HTTP response type rather than importing
 * it, so `@ggui-ai/cli` stays self-contained. Adding a field is a minor
 * change; renaming or removing one is breaking.
 *
 * The `authorPublicKey` field (32-byte base64) closes the
 * signature-verification loop end-to-end — pinned at publish time so a
 * future key rotation doesn't invalidate historical versions. Optional
 * here because older registry rows may predate it; absence triggers
 * the warn-or-`--strict`-fail path in {@link runArtifactInstall}.
 */
interface ReadPkgResponse {
  readonly manifest: unknown;
  readonly bundleUrl?: string;
  readonly bundleSri?: string;
  readonly signatureUrl?: string;
  /**
   * Base64-encoded canonical compiled JS from the registry's two-layer
   * blob. Present for blueprint rows; the CLI install path writes raw
   * TSX from `manifest.source` to disk for dev-mode editing and uses
   * this field only for observability + drift detection.
   */
  readonly compiledBytes?: string;
  readonly authorPublicKey?: string;
  readonly publishedAt: string;
  readonly publishedBy: string;
}

function isReadErrorBody(v: unknown): v is ReadErrorBody {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { error?: unknown; message?: unknown };
  if (typeof o.error !== 'string' || typeof o.message !== 'string') return false;
  return (READ_ERROR_CODES as readonly string[]).includes(o.error);
}

function isReadPkgResponse(v: unknown): v is ReadPkgResponse {
  if (v === null || typeof v !== 'object') return false;
  const o = v as {
    manifest?: unknown;
    publishedAt?: unknown;
    publishedBy?: unknown;
  };
  if (o.manifest === null || typeof o.manifest !== 'object') return false;
  if (typeof o.publishedAt !== 'string') return false;
  if (typeof o.publishedBy !== 'string') return false;
  return true;
}


/* -------------------------------------------------------------------------- */
/* Output shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Dependency seams for {@link runArtifactInstall}. All IO threads through
 * here so tests stub `fetch`, `cwd`, env access, and stdout/stderr
 * writers without touching globals.
 */
export interface RunArtifactInstallDeps {
  /** Resolved working directory. */
  readonly cwd?: string;
  /** Environment view — defaults to `process.env`. */
  readonly env?: Readonly<Partial<Record<string, string | undefined>>>;
  /** HTTP fetch implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** stdout sink. Defaults to `process.stdout.write`. */
  readonly stdout?: (line: string) => void;
  /** stderr sink. Defaults to `process.stderr.write`. */
  readonly stderr?: (line: string) => void;
  /**
   * Public-env prompter. Returns the value the operator typed for the
   * given key, or `null` if they declined. Defaults to a stdin TTY
   * reader in production. Tests stub the function.
   *
   * Skipped entirely when {@link InstallFlags.noPrompt} is true —
   * missing required keys surface as warnings instead.
   */
  readonly promptForEnv?: (key: string) => Promise<string | null>;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Encode bytes → base64 without a `node:buffer` dependency (matches
 * the gadget-signing helper's posture so the package stays
 * browser-portable). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Decode base64 → bytes, returning `undefined` on malformed input
 * (instead of throwing) so callers can surface a typed error message.
 * Matches the publish handler's `safeBase64Decode` posture. */
function decodeBase64(s: string): Uint8Array | undefined {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}


/**
 * Decompose `@scope/name` into its `scope` + `name` parts so the
 * read-handler URL `/pkg/{scope}/{name}/{version}` can be composed.
 *
 * The handler accepts the scope without the leading `@` (API GW path
 * param semantics — see read handler's `parsePathParams`). We strip
 * the `@` before composing the URL; the registry's normalizer
 * re-prepends it server-side.
 */
function splitPluginId(artifactId: string): { scope: string; name: string } {
  const slash = artifactId.indexOf('/');
  // parseGadgetInstallFlags already validated this — keep an assert.
  const scope = artifactId.slice(1, slash); // drop leading `@`
  const name = artifactId.slice(slash + 1);
  return { scope, name };
}

/**
 * Translate the `--verify-identity <pattern>` CLI argument into the
 * `expectedIdentity` shape `verifyBundleSigstore` accepts.
 *
 * Pattern form:
 *   - `/regex/[flags]` (slash-delimited) → RegExp source
 *   - everything else                    → literal subject string
 *
 * Returns `undefined` when the flag is unset (verify accepts ANY valid
 * OIDC identity).
 */
function parseVerifyIdentity(
  raw: string | undefined,
): { readonly subject: string | RegExp } | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  // Slash-delimited regex form: `/pattern/` or `/pattern/flags`.
  if (raw.length >= 2 && raw.startsWith('/')) {
    const lastSlash = raw.lastIndexOf('/');
    if (lastSlash > 0) {
      const pattern = raw.slice(1, lastSlash);
      const flags = raw.slice(lastSlash + 1);
      try {
        return { subject: new RegExp(pattern, flags) };
      } catch {
        // Invalid regex source — fall through to literal.
      }
    }
  }
  return { subject: raw };
}

/**
 * Fetch raw bytes from a presigned-S3-style URL. Used for the bundle
 * download. Distinct from the JSON-parsing flows because the bundle
 * is an opaque blob (esbuild ESM output) the verifier hashes verbatim.
 */
async function fetchBytes(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ bytes: Uint8Array } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET' });
  } catch (err) {
    return {
      error: `network error fetching ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!res.ok) {
    return { error: `GET ${url} returned ${res.status}` };
  }
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf) };
}

/**
 * Verify the `bundleSri` field (form: `sha384-<base64>`) against the
 * downloaded bundle bytes. Independent of the Ed25519 signature
 * pathway — SRI is what the iframe-runtime enforces on `<script>`
 * loading, so it MUST agree with the published value. A mismatch
 * here is bundle tampering (or a registry that re-served the wrong
 * object).
 */
function verifyBundleSri(
  bundleBytes: Uint8Array,
  expectedSri: string,
): { ok: true } | { ok: false; reason: string } {
  // The publish-side computes `bundleSri = sha384-<base64(sha384(bytes))>`;
  // gating on the prefix catches accidental sha256/sha512 SRI strings.
  if (!expectedSri.startsWith('sha384-')) {
    return {
      ok: false,
      reason: `unsupported SRI algorithm: ${expectedSri} (expected sha384-…)`,
    };
  }
  const recomputed = `sha384-${bytesToBase64(sha384(bundleBytes))}`;
  if (recomputed !== expectedSri) {
    return {
      ok: false,
      reason: `SRI mismatch: published=${expectedSri}, recomputed=${recomputed}`,
    };
  }
  return { ok: true };
}

// The manifest → registry-entry translation lives in
// `@ggui-ai/artifact-manifest#manifestToRegistryEntry`, next to the
// manifest schema. Call sites import that canonical helper directly.

/* -------------------------------------------------------------------------- */
/* runArtifactInstall                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run the install flow end-to-end. Returns a numeric exit code so the
 * router writes it directly to `process.exit`.
 *
 * Exit codes:
 *   - 0 — success (gadget installed, ggui.json updated) OR blueprint
 *         fetched + verified (no write target yet, see step 10).
 *   - 1 — operational failure (registry 404 / 410, manifest invalid,
 *         signature mismatch, SRI mismatch, etc.).
 *   - 2 — usage error (bad flags, no ggui.json found).
 */
export async function runArtifactInstall(
  flags: InstallFlags,
  deps: RunArtifactInstallDeps = {},
): Promise<number> {
  const verb = `ggui ${flags.kind} install`;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));

  // ---- step 2: find ggui.json ----
  const gguiPath = findGguiJson(cwd);
  if (gguiPath === null) {
    stderr(
      `${verb}: no ggui.json found in ${cwd} or any ancestor (up to ${FIND_MAX_DEPTH} levels).\n`,
    );
    return 2;
  }
  const loaded = readGguiJson(gguiPath);
  if ('error' in loaded) {
    stderr(`${verb}: ${loaded.error}\n`);
    return 2;
  }
  const gguiJson = loaded.value;

  // ---- step 3: resolve registry URL ----
  // Shared resolver (`./registry-url.ts`), READ-verb posture: flag →
  // GGUI_REGISTRY env → nearest ggui.json#registry → public default.
  const registryRes = resolveRegistryUrl({
    ...(flags.registry !== undefined ? { flag: flags.registry } : {}),
    cwd,
    env: { GGUI_REGISTRY: env['GGUI_REGISTRY'] },
    defaultUrl: DEFAULT_REGISTRY_URL,
  });
  if (!registryRes.ok) {
    stderr(`${verb}: ${registryRes.message}\n`);
    return 1;
  }
  const registryUrl = registryRes.url;

  // ---- step 4: GET /pkg/{scope}/{name}/{version} ----
  const { scope, name } = splitPluginId(flags.artifactId);
  const pkgUrl = `${registryUrl}/pkg/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/${encodeURIComponent(flags.version)}`;
  stdout(`fetching: ${pkgUrl}\n`);

  let pkgRes: Response;
  try {
    pkgRes = await fetchImpl(pkgUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    stderr(
      `${verb}: network error fetching registry: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  // Status checks BEFORE any body parse — a WAF/proxy in front of the
  // registry may answer 403/404/410 with an HTML or empty body, and the
  // status-specific diagnostics must still fire. Only the paths that
  // actually consume the body parse it.
  if (pkgRes.status === 404) {
    stderr(
      `${verb}: package ${flags.artifactId}@${flags.version} not found\n`,
    );
    return 1;
  }
  if (pkgRes.status === 410) {
    stderr(
      `${verb}: ${flags.artifactId}@${flags.version} was yanked; choose a different version\n`,
    );
    return 1;
  }
  if (pkgRes.status === 403) {
    stderr(
      `${verb}: ${flags.artifactId}@${flags.version} is private (HTTP 403). ` +
        `Installing private artifacts is not supported yet — the CLI sends install requests without credentials, so logging in does not help. ` +
        `Only artifacts published with public visibility are installable.\n`,
    );
    return 1;
  }
  if (!pkgRes.ok) {
    // Structured registry error bodies carry `(code: message)` detail;
    // a non-JSON body (proxy error page) degrades to the bare status.
    let detail = '';
    try {
      const errBody: unknown = await pkgRes.json();
      if (isReadErrorBody(errBody)) {
        detail = ` (${errBody.error}: ${errBody.message})`;
      }
    } catch {
      // Non-JSON error body — the status line is all we can report.
    }
    stderr(
      `${verb}: registry returned ${pkgRes.status}${detail}\n`,
    );
    return 1;
  }

  let pkgBody: unknown;
  try {
    pkgBody = await pkgRes.json();
  } catch (err) {
    stderr(
      `${verb}: registry returned ${pkgRes.status} with non-JSON body: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }
  if (!isReadPkgResponse(pkgBody)) {
    stderr(
      `${verb}: registry response did not match ReadPkgResponse shape\n`,
    );
    return 1;
  }
  const readPkg = pkgBody;

  // ---- step 5: parse manifest ----
  let manifest: ArtifactManifest;
  try {
    manifest = parseArtifactManifest(readPkg.manifest);
  } catch (err) {
    stderr(
      `${verb}: manifest from registry failed schema validation: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  // ---- step 5a: enforce verb / manifest kind alignment ----
  if (manifest.kind !== flags.kind) {
    const correctVerb = `ggui ${manifest.kind} install`;
    stderr(
      `${verb}: ${flags.artifactId}@${flags.version} is a ${manifest.kind} on the registry.\n` +
        `Run \`${correctVerb} ${flags.artifactId}@${flags.version}\` instead.\n`,
    );
    return 1;
  }

  stdout(
    `manifest: ${manifest.kind} ${manifest.scope}/${manifest.name}@${manifest.version}\n`,
  );

  // ---- step 6+7: download bundle (gadgets) or use manifest.source (blueprints),
  //               then fetch signature ----
  let signaturePayload: Uint8Array;
  let signature: GadgetSignature | undefined;

  if (manifest.kind === 'gadget') {
    if (readPkg.bundleUrl === undefined) {
      stderr(
        `${verb}: registry response is missing \`bundleUrl\` for a gadget — refusing to install\n`,
      );
      return 1;
    }
    const bundleRes = await fetchBytes(fetchImpl, readPkg.bundleUrl);
    if ('error' in bundleRes) {
      stderr(`${verb}: ${bundleRes.error}\n`);
      return 1;
    }
    signaturePayload = bundleRes.bytes;
    stdout(`bundle: ${bundleRes.bytes.length} bytes\n`);

    // SRI gate — independent of Ed25519. Mismatch = bundle tampering.
    if (readPkg.bundleSri !== undefined) {
      const sriRes = verifyBundleSri(bundleRes.bytes, readPkg.bundleSri);
      if (!sriRes.ok) {
        stderr(`${verb}: ${sriRes.reason}\n`);
        return 1;
      }
      stdout(`SRI: ok (${readPkg.bundleSri.slice(0, 20)}…)\n`);
    } else {
      stderr(
        `${verb}: registry response is missing \`bundleSri\` — SRI check skipped\n`,
      );
    }
  } else {
    // Blueprint — signature is over canonical-JSON of the manifest. The
    // raw TSX lives on `manifest.source` (guaranteed non-empty by the
    // BlueprintManifest schema, which we've already parsed). The
    // registry's `compiledBytes` field is observability-only at this
    // layer; the CLI writes the raw TSX for local-dev editability.
    signaturePayload = new TextEncoder().encode(canonicalJson(readPkg.manifest));
    if (manifest.kind === 'blueprint') {
      stdout(`blueprint source: ${manifest.source.length} chars\n`);
      if (typeof readPkg.compiledBytes === 'string' && readPkg.compiledBytes.length > 0) {
        stdout(`compiled bytes: ${readPkg.compiledBytes.length} base64 chars\n`);
      }
    }
  }

  // ---- step 7: fetch signature ----
  if (readPkg.signatureUrl !== undefined) {
    let sigRes: Response;
    try {
      sigRes = await fetchImpl(readPkg.signatureUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      stderr(
        `${verb}: network error fetching signature: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return 1;
    }
    if (!sigRes.ok) {
      stderr(
        `${verb}: GET ${readPkg.signatureUrl} returned ${sigRes.status}\n`,
      );
      return 1;
    }
    let sigBody: unknown;
    try {
      sigBody = await sigRes.json();
    } catch (err) {
      stderr(
        `${verb}: signature body is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return 1;
    }
    if (!isGadgetSignature(sigBody)) {
      stderr(
        `${verb}: signature body did not match Ed25519Signature or SigstoreSignature shape\n`,
      );
      return 1;
    }
    signature = sigBody;
  }

  // ---- verify signature ----
  // Two-leg verification: (1) recompute `sha384(payload)` and match
  // against `signature.bundleSha384` for fast tamper detection, then
  // (2) verify the Ed25519 signature against the publish-pinned
  // `authorPublicKey`. Both legs are required for a green install;
  // the pubkey leg is bypassable with a warning ONLY when the
  // registry didn't pin a public key (older historical rows).
  if (signature !== undefined) {
    const recomputedSha384 = bytesToBase64(sha384(signaturePayload));
    if (recomputedSha384 !== signature.bundleSha384) {
      stderr(
        `${verb}: bundleSha384 mismatch — signature.bundleSha384=${signature.bundleSha384.slice(0, 16)}…, recomputed=${recomputedSha384.slice(0, 16)}…\n`,
      );
      return 1;
    }
    stdout(`signature: bundleSha384 ok\n`);

    if (signature.algorithm === 'ed25519') {
      if (readPkg.authorPublicKey !== undefined) {
        const publicKeyBytes = decodeBase64(readPkg.authorPublicKey);
        if (publicKeyBytes === undefined) {
          stderr(
            `${verb}: registry-returned \`authorPublicKey\` is not valid base64\n`,
          );
          return 1;
        }
        // Bind: the signature's `publicKeyId` MUST derive from the
        // returned public key. Mismatch = the registry served a row
        // pinned to a different key than the one that produced the
        // signature — either a server-side bug or an attempted swap.
        const derivedKeyId = await derivePublicKeyId(publicKeyBytes);
        if (derivedKeyId !== signature.publicKeyId) {
          stderr(
            `${verb}: publicKeyId mismatch — signature.publicKeyId=${signature.publicKeyId}, derived=${derivedKeyId}\n`,
          );
          return 1;
        }
        const verifyRes: VerifyResult = await verifyBundleEd25519({
          bundleBytes: signaturePayload,
          signature,
          publicKey: publicKeyBytes,
        });
        if (!verifyRes.valid) {
          stderr(`${verb}: Ed25519 verify failed: ${verifyRes.reason}\n`);
          return 1;
        }
        stdout(`signature: Ed25519 ok (keyId=${signature.publicKeyId})\n`);
      } else {
        const skipReason =
          'registry response is missing `authorPublicKey` — full Ed25519 verification was skipped (legacy row)';
        if (flags.strict) {
          stderr(`${verb}: ${skipReason} (--strict)\n`);
          return 1;
        }
        stderr(`${verb}: warning — ${skipReason}\n`);
      }
    } else {
      // Sigstore (Fulcio + Rekor) verify.
      // Identity-claim assertion: `--verify-identity <pattern>` tightens
      // verify to demand a subject match against the bundle's Fulcio
      // leaf cert. When unset, verify accepts ANY valid OIDC identity
      // (the trust decision is then "the bundle was signed by a
      // Sigstore-recognized identity" — install operators wanting
      // tighter policy must pass `--verify-identity`).
      //
      // Pattern form: `/regex/` (slash-delimited) → RegExp; anything
      // else → literal subject. Matches the upstream verify shape
      // (`expectedIdentity.subject: string | RegExp`).
      const expectedIdentity = parseVerifyIdentity(flags.verifyIdentity);
      const verifyRes: VerifyResult = await verifyBundleSigstore({
        bundleBytes: signaturePayload,
        signature,
        ...(expectedIdentity !== undefined ? { expectedIdentity } : {}),
      });
      if (!verifyRes.valid) {
        stderr(`${verb}: sigstore verify failed: ${verifyRes.reason}\n`);
        return 1;
      }
      stdout(`signature: sigstore ok\n`);
    }
  } else {
    stderr(
      `${verb}: warning — no signatureUrl in registry response; integrity check limited to SRI\n`,
    );
  }

  // ---- step 10: write to ggui.json ----
  if (manifest.kind === 'gadget') {
    const entry = manifestToRegistryEntry(manifest, {
      version: manifest.version,
      ...(readPkg.bundleUrl !== undefined ? { bundleUrl: readPkg.bundleUrl } : {}),
      ...(readPkg.bundleSri !== undefined ? { bundleSri: readPkg.bundleSri } : {}),
    });

    // Write-boundary validation (gadget catalog foundations,
    // 2026-08-09): the composed row is checked BEFORE it touches the
    // in-memory catalog. The manifest schema and the descriptor schema
    // are separate validators (e.g. manifest `connect[]` entries are
    // free-form strings while descriptor `connect[]` entries must be
    // full URLs), so a manifest that parsed clean can still compose to
    // a row the catalog schema rejects.
    const composedCheck = strictGadgetDescriptorSchema.safeParse(entry);
    if (!composedCheck.success) {
      stderr(
        `${verb}: composed descriptor failed validation: ${formatZodIssues(composedCheck.error)}\n`,
      );
      return 1;
    }

    const writeRes = appendGadget(gguiJson, entry);
    if ('error' in writeRes) {
      stderr(`${verb}: ${writeRes.error}\n`);
      return 1;
    }

    // Post-append catalog lint — any fatal `lintGadgetCatalog` code
    // aborts the install BEFORE `writeGguiJson`, so a failing install
    // leaves ggui.json untouched. Two sequential checks, each
    // reporting paths in its OWN array: first the declared array
    // (duplicate package, immutable-bundle mutation), then the
    // RESOLVED union with the first-party stdlib floor (a gadget
    // re-exporting a stdlib export name is only a collision
    // post-union — installing it would break every later generation).
    const postAppendRead = readGadgetsFromGguiJson(gguiJson);
    if (!postAppendRead.ok) {
      // The freshly composed row was already validated above, so the
      // offending row predates this install.
      stderr(
        `${verb}: ${postAppendRead.error} (This entry was already present before this install — nothing was written.)\n`,
      );
      return 1;
    }
    const postAppend = postAppendRead.gadgets;
    const declaredFatal = lintGadgetCatalog(postAppend).filter((w) =>
      FATAL_CATALOG_LINT_CODES.has(w.code),
    );
    if (declaredFatal.length > 0) {
      stderr(
        `${verb}: install would corrupt the gadget catalog:\n${declaredFatal
          .map((w) => `  ${w.code} ${w.path}: ${w.message}`)
          .join('\n')}\n`,
      );
      return 1;
    }
    const resolvedFatal = lintGadgetCatalog(
      resolveAppGadgets(postAppend),
    ).filter((w) => FATAL_CATALOG_LINT_CODES.has(w.code));
    if (resolvedFatal.length > 0) {
      stderr(
        `${verb}: install would corrupt the RESOLVED gadget catalog (declared extensions + the first-party stdlib floor):\n${resolvedFatal
          .map((w) => `  ${w.code} ${w.path}: ${w.message}`)
          .join('\n')}\n`,
      );
      return 1;
    }

    // Version-replace notice — rows are keyed by package, so
    // installing any version replaces the existing row. When the
    // versions differ (upgrade OR downgrade), say what was replaced;
    // a silent downgrade is data loss the operator should see.
    if (
      writeRes.replacedVersion !== undefined &&
      writeRes.replacedVersion !== entry.version
    ) {
      stdout(
        `replaced: ${entry.package} ${writeRes.replacedVersion} → ${entry.version}\n`,
      );
    }

    // Required public-env keys. Gadget's `requires[]` lists the
    // `GGUI_PUBLIC_APP_*` keys the wrapper reads via getPublicEnv().
    // Prompt for each (or skip silently under --no-prompt).
    const required = (
      manifest as ArtifactManifest & { kind: 'gadget'; requires?: readonly string[] }
    ).requires;
    if (required && required.length > 0) {
      await maybePromptPublicEnv({
        keys: required,
        gguiJson,
        flags,
        deps: { stdout, stderr, ...(deps.promptForEnv ? { promptForEnv: deps.promptForEnv } : {}) },
      });
    }

    writeGguiJson(gguiPath, gguiJson);
    stdout(
      `installed: ${manifest.scope}/${manifest.name}@${manifest.version} → ${gguiPath}\n`,
    );
    // Touch dirname() so the helper is in scope for future expansion
    // (e.g. style sheet caching adjacent to ggui.json).
    void dirname;
    return 0;
  }

  // Blueprint branch — materialize the manifest's TSX source +
  // generated `ggui.ui.json` into `.ggui/installed-blueprints/` and
  // append the glob to `ggui.json#blueprints.include` so the existing
  // OSS-server discovery picks them up at boot. The discovery loader
  // (`packages/project-config/src/discovery.ts`) is the integration
  // boundary — no new boot-time loader needed.
  if (manifest.kind === 'blueprint') {
    const projectRoot = dirname(gguiPath);
    const materializeRes = materializeBlueprint({ projectRoot, manifest });
    if ('error' in materializeRes) {
      stderr(`${verb}: ${materializeRes.error}\n`);
      return 1;
    }
    if (materializeRes.skipped) {
      stderr(
        `${verb}: warning — blueprint ${manifest.scope}/${manifest.name}@${manifest.version} has no \`contract\` field; verified + skipped materialization (UiManifest.contract is required). The author should re-publish with a contract before this blueprint becomes installable.\n`,
      );
      return 0;
    }
    const globAdded = ensureBlueprintGlobIncluded(gguiJson);
    writeGguiJson(gguiPath, gguiJson);
    stdout(
      `installed blueprint: ${manifest.scope}/${manifest.name}@${manifest.version}\n` +
        `  - source: ${materializeRes.files.source}\n` +
        `  - manifest: ${materializeRes.files.uiManifest}\n` +
        (globAdded
          ? `  - added glob to ggui.json#blueprints.include\n`
          : ''),
    );
    return 0;
  }

  // Unreachable — manifest.kind is exhaustively narrowed above. The
  // explicit branch keeps the discriminated-union check honest if a
  // third kind ever lands on `ArtifactManifest`.
  const _exhaustive: never = manifest;
  void _exhaustive;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* ggui.json mutation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Append a {@link GadgetDescriptor} to `app.gadgets`,
 * creating the `app` block + array if either is missing.
 *
 * `app.gadgets` carries the app's EXTENSION set only. The first-party
 * stdlib package is unioned in as the structural floor at resolve time
 * via `resolveAppGadgets` in `@ggui-ai/protocol` — so declaring an
 * extension never drops stdlib hooks from the generated UI.
 *
 * Idempotent per PACKAGE — the catalog holds at most one descriptor
 * per package (`LINT_GADGET_DUPLICATE_PACKAGE` is fatal); re-installing
 * ANY version of an already-declared package replaces the package's
 * row. A version upgrade is a replace, never a second row.
 */
function appendGadget(
  gguiJson: GguiJsonObject,
  entry: GadgetDescriptor,
): { ok: true; replacedVersion?: string } | { error: string } {
  const app = gguiJson['app'];
  if (app === undefined) {
    // No app block — bail; the schema requires one and we don't want
    // to synthesize identity (`slug` + `name`) on the operator's
    // behalf. Operator should run `ggui init` (or scaffolding their
    // server set up) first.
    return {
      error:
        'ggui.json#app is missing — run your project scaffolder first (every project needs `app.slug` + `app.name`)',
    };
  }
  if (typeof app !== 'object' || app === null || Array.isArray(app)) {
    return { error: 'ggui.json#app must be an object' };
  }
  const appObj = app as GguiJsonObject;
  let libs = appObj['gadgets'];
  if (libs === undefined) {
    libs = [];
    appObj['gadgets'] = libs;
  }
  if (!Array.isArray(libs)) {
    return { error: 'ggui.json#app.gadgets must be an array' };
  }

  // Idempotent replace by `package` ALONE — an app's catalog holds at
  // most ONE descriptor per package (the wire references a package by
  // name and the server resolves exactly one descriptor; two rows for
  // one package trip the fatal `LINT_GADGET_DUPLICATE_PACKAGE` lint).
  // Re-installing any version of an already-declared package replaces
  // its row, so a version upgrade never accumulates the older row.
  const existingIdx = libs.findIndex((e: unknown) => {
    if (e === null || typeof e !== 'object') return false;
    const cand = e as { package?: unknown };
    return cand.package === entry.package;
  });
  if (existingIdx >= 0) {
    const prior = libs[existingIdx] as { version?: unknown };
    const replacedVersion =
      typeof prior.version === 'string' ? prior.version : undefined;
    libs[existingIdx] = entry;
    return {
      ok: true,
      ...(replacedVersion !== undefined ? { replacedVersion } : {}),
    };
  }
  libs.push(entry);
  return { ok: true };
}

/**
 * Format a zod error's issues as a one-line `path: message` list for
 * stderr diagnostics.
 */
function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

// The post-append catalog read routes through the package's ONE
// gadget-catalog reader — `readGadgetsFromGguiJson` in
// `./ggui-json.ts`, shared with the `ggui deploy` config push.

/* -------------------------------------------------------------------------- */
/* publicEnv prompts                                                          */
/* -------------------------------------------------------------------------- */

/**
 * For each `GGUI_PUBLIC_APP_*` key the gadget requires, prompt the
 * operator (unless `--no-prompt`). Already-present keys are left
 * untouched. Missing keys under `--no-prompt` surface as a warning
 * + the install still succeeds (operator wires them in later).
 */
async function maybePromptPublicEnv(args: {
  keys: readonly string[];
  gguiJson: GguiJsonObject;
  flags: InstallFlags;
  deps: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    promptForEnv?: (key: string) => Promise<string | null>;
  };
}): Promise<void> {
  const verb = `ggui ${args.flags.kind} install`;
  const app = args.gguiJson['app'];
  if (typeof app !== 'object' || app === null || Array.isArray(app)) return;
  const appObj = app as GguiJsonObject;
  let publicEnv = appObj['publicEnv'];
  if (publicEnv === undefined) {
    publicEnv = {};
    appObj['publicEnv'] = publicEnv;
  }
  if (typeof publicEnv !== 'object' || publicEnv === null || Array.isArray(publicEnv)) {
    args.deps.stderr(
      `${verb}: warning — ggui.json#app.publicEnv is not an object; skipping prompt\n`,
    );
    return;
  }
  const envObj = publicEnv as GguiJsonObject;

  for (const key of args.keys) {
    if (envObj[key] !== undefined) continue; // already wired
    if (args.flags.noPrompt) {
      args.deps.stderr(
        `${verb}: warning — required public-env key ${key} is not set; add it to ggui.json#app.publicEnv before booting\n`,
      );
      continue;
    }
    if (args.deps.promptForEnv === undefined) {
      args.deps.stderr(
        `${verb}: warning — no prompt sink configured; required key ${key} skipped (re-run with --no-prompt to silence)\n`,
      );
      continue;
    }
    const value = await args.deps.promptForEnv(key);
    if (value === null || value.length === 0) {
      args.deps.stderr(
        `${verb}: warning — declined value for ${key}; you can wire it in later\n`,
      );
      continue;
    }
    envObj[key] = value;
    args.deps.stdout(`set: ggui.json#app.publicEnv.${key}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Blueprint materialization                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Destination subdirectory under the project root for marketplace-
 * installed blueprints. Chosen so the existing `blueprints.include`
 * glob loader picks them up without any code change — `discoverLocalUis`
 * walks every glob, parses every matched `ggui.ui.json`, and emits
 * `DiscoveredUi` entries. The "registry-installed" subtree is just
 * one more glob root.
 */
export const INSTALLED_BLUEPRINTS_SUBDIR = '.ggui/installed-blueprints';

/**
 * Glob pattern auto-appended to `ggui.json#blueprints.include` so the
 * OSS server discovers materialized blueprints alongside hand-authored
 * ones. Idempotent — install only adds the entry once.
 */
export const INSTALLED_BLUEPRINTS_GLOB =
  `${INSTALLED_BLUEPRINTS_SUBDIR}/**/ggui.ui.json` as const;

/**
 * Predicate: "is this discovered-UI manifest path inside
 * `.ggui/installed-blueprints/`?".
 *
 * Cross-platform — matches both Unix (`/.ggui/installed-blueprints/`)
 * and Windows (`\.ggui\installed-blueprints\`) separators. A
 * Unix-only `includes('/.ggui/installed-blueprints/')` check would
 * silently match zero entries on Windows, where `tinyglobby` returns
 * `\`-separated absolute paths.
 *
 * Defined once here, next to the constant it is derived from. Both
 * `cli.ts` (filter discovered UIs) and `mcp-backend.ts` (project to
 * bridge entries) consume it, so the two filter sites cannot drift.
 */
export function isInstalledBlueprintPath(manifestPath: string): boolean {
  // Build separator-specific needles from the constant rather than
  // hand-coding both forms (defensive against future renames).
  const segments = INSTALLED_BLUEPRINTS_SUBDIR.split('/');
  const unixNeedle = `/${segments.join('/')}/`;
  const winNeedle = `\\${segments.join('\\')}\\`;
  return manifestPath.includes(unixNeedle) || manifestPath.includes(winNeedle);
}

/**
 * Compute the directory leaf for a given blueprint manifest. Safe for
 * filesystem paths — `<scope-without-@>__<name>__<version>`, no slashes
 * or colons (the version's `.` is fine on every supported FS). The
 * `__` separator avoids confusion with scope names that contain `-`.
 */
export function blueprintInstallSubdir(args: {
  scope: string;
  name: string;
  version: string;
}): string {
  const scopeBare = args.scope.startsWith('@') ? args.scope.slice(1) : args.scope;
  return `${scopeBare}__${args.name}__${args.version}`;
}

/**
 * UI manifest `id` for a marketplace-installed blueprint. Must satisfy
 * `UiManifestV1#id` (`^[A-Za-z0-9][A-Za-z0-9._:-]*$`). We use
 * `<scope-bare>:<name>:<version>` — colons + dots + hyphens + alphanum
 * are all admitted.
 */
export function blueprintUiManifestId(args: {
  scope: string;
  name: string;
  version: string;
}): string {
  const scopeBare = args.scope.startsWith('@') ? args.scope.slice(1) : args.scope;
  return `${scopeBare}:${args.name}:${args.version}`;
}

/**
 * Materialize a verified blueprint manifest onto disk:
 *   - `<projectRoot>/.ggui/installed-blueprints/<id-dir>/index.tsx`
 *   - `<projectRoot>/.ggui/installed-blueprints/<id-dir>/ggui.ui.json`
 *
 * Returns a discriminated result. `skipped: true` is the explicit
 * "blueprint has no contract" path — the verification succeeded but
 * `UiManifest.contract` is required, so we don't write a half-formed
 * row to disk. Caller surfaces the warning.
 *
 * Refuses to overwrite an existing directory — the same `(scope, name,
 * version)` triple is immutable under the registry's append-only
 * posture, so a re-install on the same version is operator error
 * (uninstall the blueprint first if you really mean to refresh it).
 */
function materializeBlueprint(args: {
  projectRoot: string;
  manifest: ArtifactManifest & { kind: 'blueprint' };
}):
  | { ok: true; skipped?: false; files: { source: string; uiManifest: string } }
  | { ok: true; skipped: true }
  | { error: string } {
  const { projectRoot, manifest } = args;
  if (manifest.contract === undefined) {
    return { ok: true, skipped: true };
  }
  const subdir = blueprintInstallSubdir(manifest);
  const targetDir = join(projectRoot, INSTALLED_BLUEPRINTS_SUBDIR, subdir);
  if (existsSync(targetDir)) {
    return {
      error: `${manifest.scope}/${manifest.name}@${manifest.version} is already installed at ${targetDir} — registry versions are immutable; uninstall first if you really mean to refresh`,
    };
  }
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return {
      error: `failed to create install dir ${targetDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const sourcePath = join(targetDir, 'index.tsx');
  const manifestPath = join(targetDir, 'ggui.ui.json');

  // Deliberately omit `entryPoint`. The install-bridge compile
  // callback (and dev-stack's `compileUiOnDemand`) resolves
  // `manifest.entryPoint` relative to `projectRoot` — an
  // `entryPoint: 'index.tsx'` here would resolve to
  // `<projectRoot>/index.tsx`, NOT the install dir. When `entryPoint`
  // is omitted, `resolveEntryFile` falls back to `ENTRY_CANDIDATES`
  // (ggui.ui.tsx / index.tsx / component.tsx) resolved relative to the
  // manifest dir — exactly what installed blueprints need.
  const uiManifest = {
    id: blueprintUiManifestId(manifest),
    name: `${manifest.scope}/${manifest.name}`,
    ...(manifest.description !== undefined
      ? { description: manifest.description }
      : {}),
    contract: manifest.contract,
  };

  try {
    writeFileSync(sourcePath, manifest.source, 'utf-8');
    writeFileSync(manifestPath, `${JSON.stringify(uiManifest, null, 2)}\n`, 'utf-8');
  } catch (err) {
    return {
      error: `failed to write blueprint files under ${targetDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return {
    ok: true,
    files: { source: sourcePath, uiManifest: manifestPath },
  };
}

/**
 * Ensure `ggui.json#blueprints.include` contains the installed-
 * blueprints glob. Returns `true` if a write was needed; `false` if
 * the glob was already present (idempotent). Creates the `blueprints`
 * block if missing.
 */
function ensureBlueprintGlobIncluded(gguiJson: GguiJsonObject): boolean {
  let blueprints = gguiJson['blueprints'];
  if (blueprints === undefined) {
    blueprints = { include: [INSTALLED_BLUEPRINTS_GLOB] };
    gguiJson['blueprints'] = blueprints;
    return true;
  }
  if (typeof blueprints !== 'object' || blueprints === null || Array.isArray(blueprints)) {
    // Schema-side parse would reject this anyway; treat as "no change"
    // since we don't want to clobber an operator's already-broken field.
    return false;
  }
  const blueprintsObj = blueprints as GguiJsonObject;
  const include = blueprintsObj['include'];
  if (include === undefined) {
    blueprintsObj['include'] = [INSTALLED_BLUEPRINTS_GLOB];
    return true;
  }
  if (!Array.isArray(include)) return false;
  if (include.includes(INSTALLED_BLUEPRINTS_GLOB)) return false;
  include.push(INSTALLED_BLUEPRINTS_GLOB);
  return true;
}
