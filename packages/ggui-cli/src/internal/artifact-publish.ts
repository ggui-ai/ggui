/**
 * Shared publish core for `ggui gadget publish` and `ggui blueprint publish`.
 *
 * An internal helper that both kind-discriminated router files
 * (`gadget-command.ts` + `blueprint-command.ts`) delegate to. The CLI
 * verb's `kind` parameter is enforced against the on-disk manifest's
 * `kind` discriminator — a `ggui gadget publish` in a directory with
 * `ggui.blueprint.json` (or vice versa) prints a friendly redirect
 * pointing at the correct verb instead of trying to publish.
 *
 * Walks the operator-facing flow end-to-end:
 *
 *   1. Resolve registry URL — `--registry` flag, then `GGUI_REGISTRY`
 *      env, then the nearest `ggui.json#registry`. No fallback to a
 *      hardcoded default — operators MUST opt into a registry
 *      explicitly so a typo doesn't accidentally publish to prod.
 *   2. Load + validate `ggui.gadget.json` / `ggui.blueprint.json` in CWD;
 *      enforce that the manifest kind matches the verb the operator typed.
 *   3. (Gadgets only) bundle the entry via esbuild (ESM / es2022 /
 *      platform=neutral) with manifest.peerDeps + react family
 *      hoisted to externals.
 *   4. Authenticate — either `--auth=bearer` (explicit token for self-
 *      hosted / local registries) OR the default: reuse the session
 *      `ggui login` already stored at `~/.ggui/auth.json`, refreshing
 *      the access token via `POST /v1/auth/refresh` when it has
 *      expired (see `./auth-strategy.ts` for the routing and
 *      `../auth-store.ts` for the on-disk document).
 *   5. Conformance preflight — POST `/conformance/check` with the
 *      manifest + bundle text. Fail-fast so a malformed bundle
 *      doesn't hit S3.
 *   6. Sign the bundle (gadget) or canonical manifest (blueprint)
 *      with the operator's Ed25519 private key. Generate the
 *      keypair on first publish + print the public-key id for
 *      registry-side registration.
 *   7. POST `/publish` with `{manifest, bundle?, bundleSha384?, signature}`.
 *   8. Print the install command operators paste into their
 *      `ggui.json` consumers.
 *
 * `--dry-run` runs steps 1-5 and prints what would be uploaded; no
 * POST happens.
 *
 * **HTTP contract (locked).**
 *
 *   POST <registry>/publish
 *     Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
 *     Body   : { manifest, bundle?, bundleSha384?, signature }
 *     201    : { artifactId, version, manifestUrl, bundleUrl?, signatureUrl?, installCommand }
 *     400    : { code: 'version_exists' | 'unknown_key' | 'conformance_failed' | … , message }
 *     401    : auth bad
 *     501    : endpoint stubbed
 *
 *   POST <registry>/conformance/check
 *     Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
 *     Body   : { manifest, bundle? }
 *     200    : { ok: true }
 *     200    : { ok: false, issues: [{code, message, path?}] }
 *     5xx    : transient — caller retries or surfaces
 */
import { build as esbuild } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { URL } from 'node:url';
import {
  GGUI_BLUEPRINT_JSON_FILENAME,
  GGUI_GADGET_JSON_FILENAME,
  parseBlueprintManifest,
  parseGadgetManifest,
  type BlueprintManifest,
  type GadgetManifest,
} from '@ggui-ai/artifact-manifest';
import {
  canonicalJson,
  derivePublicKeyId,
  generateEd25519Keypair,
  publicKeyFromPrivate,
  signBundleEd25519,
  signBundleSigstore,
  type GadgetSignature,
} from '@ggui-ai/gadget-signing';
import {
  resolveOidcToken,
  OidcResolutionError,
} from './oidc-token.js';
import { sha384 } from '@noble/hashes/sha512.js';
import {
  saveAuthSession,
  tryLoadAuthSession,
} from '../auth-store.js';
import { ApiError, postAuthRefresh, type TokenResponse } from '../api-client.js';
import {
  getPrivateKeyPath,
  hasKeypair,
  readPrivateKey,
  scopeOf,
  writePrivateKey,
} from './key-store.js';
import {
  acquireAuthToken,
  parseAuthFlags,
  AUTH_HELP_FRAGMENT,
  type AuthFlags,
} from './auth-strategy.js';

/** Artifact-kind discriminator. Mirrors the manifest schema's
 * `kind` field — passing a CLI verb's `kind` to the publish core lets
 * it bail with a friendly redirect when the on-disk manifest doesn't
 * match. */
export type ArtifactKind = 'gadget' | 'blueprint';

/**
 * Shape of the resolved options the publish core consumes. Built from
 * argv by {@link parseArtifactPublishFlags} so the core function is
 * dependency-injectable for tests.
 */
export interface ArtifactPublishOptions {
  /** CLI verb the operator typed — enforced against the manifest kind. */
  readonly kind: ArtifactKind;
  /** Override the registry URL — highest precedence. */
  readonly registry?: string;
  /** Skip the actual POST; run everything else. */
  readonly dryRun: boolean;
  /** Override the private-key path. */
  readonly key?: string;
  /**
   * OIDC identity token for sigstore signing (public gadgets only).
   * Mirrors cosign's `--identity-token` flag. If absent the CLI falls
   * back through `GGUI_OIDC_TOKEN` → GH-Actions ambient → interactive.
   * Ignored for private-gadget publishes (which sign with Ed25519).
   */
  readonly identityToken?: string;
  /** Auth strategy + bearer token. `auth === undefined` → the stored
   * `ggui login` session. */
  readonly auth?: AuthFlags;
  /** Starting directory; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Test seam: inject `fetch`. Production passes `globalThis.fetch`.
   * Typed deliberately as the `fetch` global so tests use a real
   * `Response` object without leaking through `any`. Also used for the
   * login-session refresh call (`POST /v1/auth/refresh`).
   */
  readonly fetch?: typeof fetch;
  /** Test seam: write status lines. Production = process.stdout.write. */
  readonly stdout?: (line: string) => void;
  /** Test seam: write error lines. Production = process.stderr.write. */
  readonly stderr?: (line: string) => void;
  /**
   * Test seam: clock. Returns unix epoch SECONDS. Production = Date.now()/1000.
   */
  readonly now?: () => number;
}

/** Discriminated result mirroring the patterns used by `runServe` /
 * `runDev`. Tests + the CLI router branch on the discriminant. */
export type PublishResult =
  | { readonly ok: true; readonly exitCode: 0; readonly success: PublishSuccess }
  | { readonly ok: false; readonly exitCode: number; readonly error: PublishError };

export interface PublishSuccess {
  readonly artifactId: string;
  readonly version: string;
  readonly manifestUrl: string;
  readonly bundleUrl?: string;
  readonly signatureUrl?: string;
  readonly installCommand: string;
  readonly registryUrl: string;
  readonly dryRun: boolean;
}

export type PublishError =
  | { readonly code: 'no_registry_resolved'; readonly message: string }
  | { readonly code: 'manifest_missing'; readonly message: string }
  | { readonly code: 'manifest_invalid'; readonly message: string; readonly details?: string }
  | { readonly code: 'manifest_kind_mismatch'; readonly message: string }
  | { readonly code: 'bundle_failed'; readonly message: string }
  | { readonly code: 'auth_failed'; readonly message: string }
  | { readonly code: 'auth_config_missing'; readonly message: string }
  | { readonly code: 'key_missing'; readonly message: string }
  | {
      readonly code: 'oidc_resolution_failed';
      readonly message: string;
      /** Sub-code from the OIDC resolver — `no_token_available` / `github_actions_fetch_failed` / `interactive_failed`. */
      readonly oidcCode?: string;
    }
  | { readonly code: 'conformance_failed'; readonly message: string; readonly issues?: ReadonlyArray<ConformanceIssue> }
  | { readonly code: 'publish_failed'; readonly message: string; readonly httpStatus?: number; readonly serverCode?: string }
  | { readonly code: 'publish_stubbed'; readonly message: string };

export interface ConformanceIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/**
 * Parsed argv flags for the `ggui {gadget,blueprint} publish` subcommand.
 * Returned by {@link parseArtifactPublishFlags}.
 */
export interface ParsedPublishFlags {
  readonly registry?: string;
  readonly dryRun: boolean;
  readonly key?: string;
  /** Parsed `--identity-token <jwt>` flag (sigstore / public gadgets). */
  readonly identityToken?: string;
  readonly auth?: AuthFlags;
  readonly help: boolean;
  readonly error?: string;
}

/**
 * Build verb-specific help text. Takes the `kind` so the rendered
 * lines say `ggui gadget publish` / `ggui blueprint publish` rather
 * than a generic placeholder.
 */
export function buildPublishHelp(kind: ArtifactKind): string {
  const verb = `ggui ${kind} publish`;
  return `${verb} — push a ${kind} to the marketplace registry

Usage:
  ${verb} [--registry <url>] [--dry-run] [--key <path>] [--identity-token <jwt>] [--auth=bearer [--token <token>]]

Options:
  --registry <url>   Registry to publish to. Precedence:
                       1. --registry flag
                       2. GGUI_REGISTRY env
                       3. ggui.json#registry (nearest, walking up from CWD)
                     No hardcoded default — operators must opt in.

  --dry-run          Run validation, bundling, auth, and conformance
                     preflight; skip the POST. Prints what would be
                     uploaded.

  --key <path>       Path to a 32-byte Ed25519 private key. Used to sign
                     **private** ${kind}s. Default:
                       ~/.ggui/keys/<scope>/private.key

  --identity-token <jwt>
                     OIDC identity token used to sign **public** ${kind}s
                     via sigstore (cosign keyless). If absent, the CLI
                     resolves a token from (in order):
                       1. GGUI_OIDC_TOKEN env
                       2. GitHub Actions ambient OIDC
                       3. interactive browser flow (TTY only)

${AUTH_HELP_FRAGMENT}
`;
}

/**
 * Parse argv tail (excluding `ggui {gadget,blueprint} publish`) into
 * flags. Pure — no IO. Returned `error` is a single-line
 * operator-facing string. The `--auth` + `--token` flags are peeled
 * out via {@link parseAuthFlags} so the publish flag loop stays
 * focused on its own surface.
 */
export function parseArtifactPublishFlags(args: readonly string[]): ParsedPublishFlags {
  // First, peel off the auth-related flags.
  const authParsed = parseAuthFlags(args);
  if ('error' in authParsed) {
    return { dryRun: false, help: false, error: authParsed.error };
  }
  const authFlags = authParsed.flags;
  const rest = authParsed.rest;

  let registry: string | undefined;
  let dryRun = false;
  let key: string | undefined;
  let identityToken: string | undefined;
  let help = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--registry') {
      const value = rest[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { dryRun, help, error: '--registry requires a value' };
      }
      registry = value;
      i += 1;
      continue;
    }
    if (arg === '--key') {
      const value = rest[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { dryRun, help, error: '--key requires a value' };
      }
      key = value;
      i += 1;
      continue;
    }
    if (arg === '--identity-token' || (typeof arg === 'string' && arg.startsWith('--identity-token='))) {
      // Accept both `--identity-token <jwt>` and `--identity-token=<jwt>`.
      const eq = typeof arg === 'string' ? arg.indexOf('=') : -1;
      let value: string | undefined;
      if (eq !== -1 && typeof arg === 'string') {
        value = arg.slice(eq + 1);
      } else {
        value = rest[i + 1];
        i += 1;
      }
      if (typeof value !== 'string' || value.length === 0) {
        return { dryRun, help, error: '--identity-token requires a value' };
      }
      identityToken = value;
      continue;
    }
    return { dryRun, help, error: `unknown flag: ${arg}` };
  }
  return {
    ...(registry !== undefined ? { registry } : {}),
    dryRun,
    ...(key !== undefined ? { key } : {}),
    ...(identityToken !== undefined ? { identityToken } : {}),
    ...(authFlags.auth !== undefined || authFlags.token !== undefined
      ? { auth: authFlags }
      : {}),
    help,
  };
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/**
 * Run the publish flow. Pure entry point — all IO + network is
 * threaded through injectable seams in `opts` so tests are
 * deterministic.
 *
 * `opts.kind` is the verb the operator typed; manifest-kind mismatch
 * (e.g. `ggui gadget publish` in a directory with `ggui.blueprint.json`)
 * surfaces a friendly redirect at step 2 + exits non-zero.
 */
export async function runArtifactPublish(
  opts: ArtifactPublishOptions,
): Promise<PublishResult> {
  const verb = `ggui ${opts.kind} publish`;
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => void process.stderr.write(s));
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);

  // ---- step 1: resolve registry URL ----
  const registryRes = resolveRegistryUrl({ flag: opts.registry, env: process.env, cwd });
  if (!registryRes.ok) {
    stderr(`${verb}: ${registryRes.message}\n`);
    return { ok: false, exitCode: 1, error: { code: 'no_registry_resolved', message: registryRes.message } };
  }
  const registryUrl = registryRes.url;
  stdout(`registry: ${registryUrl} (${registryRes.source})\n`);

  // ---- step 2: load manifest ----
  const manifestRes = loadManifest(cwd);
  if (!manifestRes.ok) {
    stderr(`${verb}: ${manifestRes.error.message}\n`);
    if (manifestRes.error.code === 'manifest_invalid' && manifestRes.error.details) {
      stderr(`  ${manifestRes.error.details}\n`);
    }
    return { ok: false, exitCode: 1, error: manifestRes.error };
  }
  const { manifest, manifestPath } = manifestRes;

  // ---- step 2a: enforce verb / manifest kind alignment ----
  if (manifest.kind !== opts.kind) {
    const foundFile =
      manifest.kind === 'blueprint'
        ? GGUI_BLUEPRINT_JSON_FILENAME
        : GGUI_GADGET_JSON_FILENAME;
    const correctVerb = `ggui ${manifest.kind} publish`;
    const message =
      `this is a ${manifest.kind} repo (found ${foundFile}).\n` +
      `Run \`${correctVerb}\` instead.`;
    stderr(`${verb}: ${message}\n`);
    return {
      ok: false,
      exitCode: 1,
      error: { code: 'manifest_kind_mismatch', message },
    };
  }
  stdout(`manifest: ${manifest.kind} ${`${manifest.scope}/${manifest.name}`}@${manifest.version}\n`);

  // ---- step 3: bundle (gadgets only) ----
  let bundleBytes: Uint8Array | undefined;
  let bundleSha384: string | undefined;
  if (manifest.kind === 'gadget') {
    const bundleRes = await bundleGadget(manifest, dirname(manifestPath));
    if (!bundleRes.ok) {
      stderr(`${verb}: bundle failed — ${bundleRes.error}\n`);
      return { ok: false, exitCode: 1, error: { code: 'bundle_failed', message: bundleRes.error } };
    }
    bundleBytes = bundleRes.bytes;
    // Base64-encoded sha384 — wire format the publish handler verifies
    // against its own server-side hash.
    bundleSha384 = Buffer.from(sha384(bundleBytes)).toString('base64');
    stdout(`bundle: ${bundleBytes.length} bytes · sha384=${bundleSha384.slice(0, 12)}…\n`);
  }

  // ---- step 4: authenticate ----
  // Two paths:
  //   --auth=bearer → token from flag or GGUI_REGISTRY_TOKEN
  //   default       → the `ggui login` session stored at ~/.ggui/auth.json
  let token: string;
  const authFlags: AuthFlags = opts.auth ?? {};
  const authKind: RegistryAuthKind = authFlags.auth === 'bearer' ? 'bearer' : 'session';
  try {
    token = await acquireAuthToken({
      flags: authFlags,
      env: process.env,
      acquireSessionToken: async () => {
        const session = await acquireLoginSessionToken({ now, fetchImpl });
        if (!session.ok) {
          throw new SessionAuthError(session.error);
        }
        stdout(`auth: ggui login session${session.refreshed ? ' (refreshed)' : ''}\n`);
        return session.accessToken;
      },
    });
  } catch (err) {
    if (err instanceof SessionAuthError) {
      stderr(`${verb}: ${err.payload.message}\n`);
      return { ok: false, exitCode: 1, error: err.payload };
    }
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${verb}: ${msg}\n`);
    return { ok: false, exitCode: 1, error: { code: 'auth_failed', message: msg } };
  }
  if (authKind === 'bearer') {
    stdout(`auth: bearer token (length=${token.length})\n`);
  }

  // ---- step 5: conformance preflight ----
  const preflightRes = await runConformancePreflight({
    registryUrl,
    token,
    authKind,
    manifest,
    bundleBytes,
    fetchImpl,
  });
  if (!preflightRes.ok) {
    if (preflightRes.error.code === 'auth_failed') {
      // 401 from the registry — an auth problem, not a conformance one.
      stderr(`${verb}: ${preflightRes.error.message}\n`);
      return { ok: false, exitCode: 1, error: preflightRes.error };
    }
    stderr(`${verb}: conformance preflight failed\n`);
    if (preflightRes.error.code === 'conformance_failed' && preflightRes.error.issues) {
      for (const issue of preflightRes.error.issues) {
        stderr(`  - ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}\n`);
      }
    } else {
      stderr(`  ${preflightRes.error.message}\n`);
    }
    return { ok: false, exitCode: 1, error: preflightRes.error };
  }
  stdout(`conformance: ok\n`);

  // ---- step 6 + 7: sign — branched on manifest.visibility ----
  //
  // `private` → Ed25519 keypair signing (existing path: load/generate
  // a 32-byte private key at ~/.ggui/keys/<scope>/private.key, sign
  // the bundle hash, ship the publicKeyId for the registry's
  // AuthorKeys lookup).
  //
  // `public`  → sigstore keyless signing (Fulcio cert + Rekor inclusion
  // proof). Needs a short-lived OIDC token resolved from one of four
  // sources (flag → env → GH-Actions → interactive browser).
  const signaturePayload =
    manifest.kind === 'gadget'
      ? bundleBytes!
      : new TextEncoder().encode(canonicalJson(manifest));

  let signature: GadgetSignature;
  if (manifest.visibility === 'private') {
    const keyRes = await loadOrGenerateKey({
      artifactId: `${manifest.scope}/${manifest.name}`,
      keyFlag: opts.key,
      stdout,
    });
    if (!keyRes.ok) {
      stderr(`${verb}: ${keyRes.error.message}\n`);
      return { ok: false, exitCode: 1, error: keyRes.error };
    }
    signature = await signBundleEd25519({
      bundleBytes: signaturePayload,
      privateKey: keyRes.privateKey,
      publicKeyId: keyRes.publicKeyId,
    });
    stdout(`signature: ${signature.algorithm} · ${keyRes.publicKeyId}\n`);
  } else {
    // public → sigstore keyless. Resolve OIDC first.
    let oidc;
    try {
      oidc = await resolveOidcToken({
        ...(opts.identityToken !== undefined
          ? { identityTokenFlag: opts.identityToken }
          : {}),
        env: process.env,
        isTty: process.stdout.isTTY === true,
        stdout,
      });
    } catch (err) {
      const message =
        err instanceof OidcResolutionError ? err.message : err instanceof Error ? err.message : String(err);
      const oidcCode =
        err instanceof OidcResolutionError ? err.code : undefined;
      stderr(`${verb}: ${message}\n`);
      return {
        ok: false,
        exitCode: 1,
        error: {
          code: 'oidc_resolution_failed',
          message,
          ...(oidcCode !== undefined ? { oidcCode } : {}),
        },
      };
    }
    stdout(`signature: sigstore (OIDC source=${oidc.source})\n`);
    signature = await signBundleSigstore({
      bundleBytes: signaturePayload,
      identityToken: oidc.token,
    });
    stdout(`signature: ${signature.algorithm} ok\n`);
  }

  // ---- step 8: POST (or skip for dry-run) ----
  if (opts.dryRun) {
    stdout(`dry-run: would POST to ${registryUrl}/publish\n`);
    stdout(`dry-run: ${`${manifest.scope}/${manifest.name}`}@${manifest.version}\n`);
    return {
      ok: true,
      exitCode: 0,
      success: {
        artifactId: `${manifest.scope}/${manifest.name}`,
        version: manifest.version,
        manifestUrl: '(dry-run — no manifestUrl)',
        installCommand: `ggui ${opts.kind} install ${`${manifest.scope}/${manifest.name}`}@${manifest.version} --registry=${registryUrl}`,
        registryUrl,
        dryRun: true,
      },
    };
  }

  const publishRes = await postPublish({
    registryUrl,
    token,
    authKind,
    manifest,
    bundleBytes,
    bundleSha384,
    signature,
    fetchImpl,
  });
  if (!publishRes.ok) {
    stderr(`${verb}: ${publishRes.error.message}\n`);
    return { ok: false, exitCode: 1, error: publishRes.error };
  }

  // ---- step 9: success ----
  stdout(`\npublished: ${publishRes.body.artifactId}@${publishRes.body.version}\n`);
  stdout(`manifest:  ${publishRes.body.manifestUrl}\n`);
  if (publishRes.body.bundleUrl) stdout(`bundle:    ${publishRes.body.bundleUrl}\n`);
  if (publishRes.body.signatureUrl) stdout(`signature: ${publishRes.body.signatureUrl}\n`);
  stdout(`\nInstall:\n  ${publishRes.body.installCommand}\n`);

  return {
    ok: true,
    exitCode: 0,
    success: {
      artifactId: publishRes.body.artifactId,
      version: publishRes.body.version,
      manifestUrl: publishRes.body.manifestUrl,
      ...(publishRes.body.bundleUrl !== undefined ? { bundleUrl: publishRes.body.bundleUrl } : {}),
      ...(publishRes.body.signatureUrl !== undefined ? { signatureUrl: publishRes.body.signatureUrl } : {}),
      installCommand: publishRes.body.installCommand,
      registryUrl,
      dryRun: false,
    },
  };
}

// ---------------------------------------------------------------------------
// step 1 — resolve registry URL
// ---------------------------------------------------------------------------

interface RegistryResolution {
  readonly ok: true;
  readonly url: string;
  readonly source: 'flag' | 'env' | 'ggui.json';
}

interface RegistryUnresolved {
  readonly ok: false;
  readonly message: string;
}

export function resolveRegistryUrl(opts: {
  readonly flag?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): RegistryResolution | RegistryUnresolved {
  if (opts.flag && opts.flag.length > 0) {
    if (!isValidUrl(opts.flag)) {
      return {
        ok: false,
        message: `--registry value is not a valid URL: ${opts.flag}`,
      };
    }
    return { ok: true, url: stripTrailingSlash(opts.flag), source: 'flag' };
  }
  const envValue = opts.env['GGUI_REGISTRY'];
  if (envValue && envValue.length > 0) {
    if (!isValidUrl(envValue)) {
      return {
        ok: false,
        message: `GGUI_REGISTRY is not a valid URL: ${envValue}`,
      };
    }
    return { ok: true, url: stripTrailingSlash(envValue), source: 'env' };
  }
  const ggui = findAndReadGguiJsonRegistry(opts.cwd);
  if (ggui.found) {
    if (!isValidUrl(ggui.registry)) {
      return {
        ok: false,
        message: `ggui.json#registry at ${ggui.path} is not a valid URL: ${ggui.registry}`,
      };
    }
    return { ok: true, url: stripTrailingSlash(ggui.registry), source: 'ggui.json' };
  }
  return {
    ok: false,
    message:
      'no registry resolved. Set one of:\n' +
      '  --registry <url>\n' +
      '  GGUI_REGISTRY env var\n' +
      '  "registry": "<url>" in the nearest ggui.json',
  };
}

interface GguiJsonRegistryFound {
  readonly found: true;
  readonly registry: string;
  readonly path: string;
}
interface GguiJsonRegistryMissing {
  readonly found: false;
}

/**
 * Walk up from `startDir` looking for the nearest `ggui.json` with a
 * top-level `registry` string field. Returns the first match.
 *
 * This is intentionally hand-rolled (not via `@ggui-ai/project-config`)
 * because the schema there has not grown a typed `registry` field yet;
 * until it does, the field is read opportunistically without forcing a
 * parallel schema migration.
 */
function findAndReadGguiJsonRegistry(
  startDir: string,
): GguiJsonRegistryFound | GguiJsonRegistryMissing {
  let dir = resolve(startDir);
  for (let i = 0; i <= 16; i++) {
    const candidate = join(dir, 'ggui.json');
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Malformed — fall through; the operator's `ggui serve` will
        // raise a friendlier error than we can synthesize here.
        return { found: false };
      }
      const registry = extractRegistryField(parsed);
      if (typeof registry === 'string' && registry.length > 0) {
        return { found: true, registry, path: candidate };
      }
      return { found: false };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { found: false };
}

function extractRegistryField(x: unknown): unknown {
  if (typeof x !== 'object' || x === null) return undefined;
  return (x as { registry?: unknown }).registry;
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// ---------------------------------------------------------------------------
// step 2 — manifest load
// ---------------------------------------------------------------------------

interface ManifestLoaded {
  readonly ok: true;
  readonly manifest: GadgetManifest | BlueprintManifest;
  readonly manifestPath: string;
}
interface ManifestFailed {
  readonly ok: false;
  readonly error: Extract<
    PublishError,
    { code: 'manifest_missing' | 'manifest_invalid' }
  >;
}

function loadManifest(cwd: string): ManifestLoaded | ManifestFailed {
  const gadgetPath = join(cwd, GGUI_GADGET_JSON_FILENAME);
  const blueprintPath = join(cwd, GGUI_BLUEPRINT_JSON_FILENAME);
  const hasGadget = existsSync(gadgetPath);
  const hasBlueprint = existsSync(blueprintPath);
  if (hasGadget && hasBlueprint) {
    return {
      ok: false,
      error: {
        code: 'manifest_invalid',
        message: `both ${GGUI_GADGET_JSON_FILENAME} and ${GGUI_BLUEPRINT_JSON_FILENAME} present in CWD — only one allowed per repo`,
      },
    };
  }
  if (!hasGadget && !hasBlueprint) {
    return {
      ok: false,
      error: {
        code: 'manifest_missing',
        message: `no ${GGUI_GADGET_JSON_FILENAME} or ${GGUI_BLUEPRINT_JSON_FILENAME} in ${cwd}`,
      },
    };
  }
  const path = hasGadget ? gadgetPath : blueprintPath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'manifest_invalid',
        message: `${path} is not valid JSON`,
        details: err instanceof Error ? err.message : String(err),
      },
    };
  }
  try {
    const manifest = hasGadget ? parseGadgetManifest(parsed) : parseBlueprintManifest(parsed);
    return { ok: true, manifest, manifestPath: path };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'manifest_invalid',
        message: `${path} failed schema validation`,
        details: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// step 3 — esbuild
// ---------------------------------------------------------------------------

interface BundleOk {
  readonly ok: true;
  readonly bytes: Uint8Array;
}
interface BundleErr {
  readonly ok: false;
  readonly error: string;
}

async function bundleGadget(
  manifest: GadgetManifest,
  manifestDir: string,
): Promise<BundleOk | BundleErr> {
  const entry = isAbsolute(manifest.bundle)
    ? manifest.bundle
    : join(manifestDir, manifest.bundle);
  if (!existsSync(entry)) {
    return { ok: false, error: `entry not found: ${entry}` };
  }
  // React + jsx-runtime are always external — gadget consumers
  // bring their own React. peerDeps keys add to that base set.
  const externals = new Set<string>([
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    ...(manifest.peerDeps ? Object.keys(manifest.peerDeps) : []),
  ]);
  try {
    const result = await esbuild({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'neutral',
      minify: false,
      write: false,
      external: [...externals],
      logLevel: 'silent',
    });
    if (result.outputFiles.length !== 1) {
      return {
        ok: false,
        error: `esbuild produced ${result.outputFiles.length} files; expected 1`,
      };
    }
    return { ok: true, bytes: new Uint8Array(result.outputFiles[0].contents) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// step 4 — login-session token acquisition
//
// The default (non-`--auth=bearer`) path reuses the credential the
// RFC 8628 device flow in `ggui login` already persisted to
// `~/.ggui/auth.json`. No identity provider is contacted from here —
// the only network call is the session-refresh endpoint
// (`POST <session.endpoint>/v1/auth/refresh`) when the access token
// has expired.
// ---------------------------------------------------------------------------

/** Which credential the publish flow is sending to the registry.
 * Drives the 401 diagnostics — a rejected `ggui login` session points
 * the operator at the session/bearer split; a rejected bearer token
 * points at the registry's configured publish token. */
export type RegistryAuthKind = 'bearer' | 'session';

export interface AuthSuccess {
  readonly ok: true;
  /** The `ggui login` access token, sent as `Authorization: Bearer <token>`. */
  readonly accessToken: string;
  /** True when the stored access token had expired and was refreshed. */
  readonly refreshed: boolean;
}
export interface AuthFailed {
  readonly ok: false;
  readonly error: Extract<PublishError, { code: 'auth_failed' | 'auth_config_missing' }>;
}

/**
 * Sentinel error that lets the bearer/session strategy router surface
 * a structured `PublishError` without leaking through `throw any`.
 */
class SessionAuthError extends Error {
  readonly payload: Extract<PublishError, { code: 'auth_failed' | 'auth_config_missing' }>;
  constructor(payload: Extract<PublishError, { code: 'auth_failed' | 'auth_config_missing' }>) {
    super(payload.message);
    this.payload = payload;
  }
}

/** Safety margin (seconds) before access-token expiry at which the CLI
 * proactively refreshes instead of racing a boundary rejection. */
const ACCESS_TOKEN_FRESHNESS_MARGIN_SECONDS = 60;

/**
 * Resolve the `ggui login` session token for registry calls.
 *
 * 1. Load `~/.ggui/auth.json` (written by `ggui login`). Missing /
 *    malformed → `auth_config_missing` telling the operator to either
 *    `ggui login` or use `--auth=bearer`.
 * 2. Fresh access token → return it as-is.
 * 3. Expired access token + live refresh token → `POST
 *    <session.endpoint>/v1/auth/refresh`, persist the rotated session,
 *    return the new access token.
 * 4. Expired refresh token (or refresh rejected) → `auth_failed`
 *    telling the operator to `ggui login` again.
 */
export async function acquireLoginSessionToken(opts: {
  readonly now: () => number;
  readonly fetchImpl: typeof fetch;
}): Promise<AuthSuccess | AuthFailed> {
  const session = tryLoadAuthSession();
  if (!session) {
    return {
      ok: false,
      error: {
        code: 'auth_config_missing',
        message:
          'no registry credentials found. Either:\n' +
          '  - run `ggui login` to sign in, or\n' +
          '  - pass --auth=bearer --token <token> (or set GGUI_REGISTRY_TOKEN) for self-hosted / local registries.',
      },
    };
  }

  const nowSeconds = opts.now();
  if (session.accessExpiresAt - nowSeconds > ACCESS_TOKEN_FRESHNESS_MARGIN_SECONDS) {
    return { ok: true, accessToken: session.accessToken, refreshed: false };
  }

  if (session.refreshExpiresAt <= nowSeconds) {
    return {
      ok: false,
      error: {
        code: 'auth_failed',
        message: 'login session expired. Run `ggui login` again.',
      },
    };
  }

  let tokens: TokenResponse;
  try {
    tokens = await postAuthRefresh(session.endpoint, session.refreshToken, opts.fetchImpl);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 400 || err.status === 401)) {
      return {
        ok: false,
        error: {
          code: 'auth_failed',
          message: 'login session expired or was revoked. Run `ggui login` again.',
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'auth_failed',
        message: `token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const refreshedSession = {
    ...session,
    accessToken: tokens.access_token,
    accessExpiresAt: nowSeconds + tokens.expires_in,
    refreshToken: tokens.refresh_token,
    writtenAt: new Date().toISOString(),
  };
  saveAuthSession(refreshedSession);
  return { ok: true, accessToken: refreshedSession.accessToken, refreshed: true };
}

/**
 * Operator-facing diagnosis for an HTTP 401 from the registry,
 * specialized on which credential was sent. Used by both the
 * conformance preflight and the publish POST.
 */
function describeRegistryAuthRejection(authKind: RegistryAuthKind, path: string): string {
  if (authKind === 'bearer') {
    return (
      `registry rejected the bearer token (HTTP 401 from ${path}). ` +
      'Check that --token / GGUI_REGISTRY_TOKEN matches the publish token the registry is configured with.'
    );
  }
  return (
    'registry rejected the `ggui login` session token (HTTP 401 from ' +
    `${path}). This registry does not accept CLI login sessions for ` +
    'publishing yet — pass --auth=bearer --token <token> (or set ' +
    'GGUI_REGISTRY_TOKEN), or re-run `ggui login` if your session may ' +
    'have been revoked.'
  );
}

// ---------------------------------------------------------------------------
// step 5 — conformance preflight
// ---------------------------------------------------------------------------

interface ConformancePreflightOk {
  readonly ok: true;
}
interface ConformancePreflightErr {
  readonly ok: false;
  readonly error: Extract<
    PublishError,
    { code: 'conformance_failed' | 'publish_failed' | 'auth_failed' }
  >;
}

async function runConformancePreflight(opts: {
  readonly registryUrl: string;
  readonly token: string;
  readonly authKind: RegistryAuthKind;
  readonly manifest: GadgetManifest | BlueprintManifest;
  readonly bundleBytes?: Uint8Array;
  readonly fetchImpl: typeof fetch;
}): Promise<ConformancePreflightOk | ConformancePreflightErr> {
  const url = `${opts.registryUrl}/conformance/check`;
  const body = JSON.stringify({
    manifest: opts.manifest,
    ...(opts.bundleBytes !== undefined
      ? { bundle: Buffer.from(opts.bundleBytes).toString('base64') }
      : {}),
  });
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
      },
      body,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'conformance_failed',
        message: `network error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (res.status === 401) {
    return {
      ok: false,
      error: {
        code: 'auth_failed',
        message: describeRegistryAuthRejection(opts.authKind, '/conformance/check'),
      },
    };
  }
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: {
        code: 'conformance_failed',
        message: `HTTP ${res.status} from /conformance/check${text ? `: ${text.slice(0, 200)}` : ''}`,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'conformance_failed',
        message: `response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const parsedShape = parseConformanceResponse(parsed);
  if (!parsedShape) {
    return {
      ok: false,
      error: {
        code: 'conformance_failed',
        message: 'unrecognized conformance response shape',
      },
    };
  }
  if (parsedShape.ok === true) {
    return { ok: true };
  }
  return {
    ok: false,
    error: {
      code: 'conformance_failed',
      message: 'manifest/bundle failed conformance checks',
      issues: parsedShape.issues,
    },
  };
}

type ConformanceResponse =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: ReadonlyArray<ConformanceIssue> };

function parseConformanceResponse(x: unknown): ConformanceResponse | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as { ok?: unknown; issues?: unknown };
  if (r.ok === true) return { ok: true };
  if (r.ok === false) {
    if (!Array.isArray(r.issues)) return { ok: false, issues: [] };
    const issues: ConformanceIssue[] = [];
    for (const entry of r.issues) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as { code?: unknown; message?: unknown; path?: unknown };
      if (typeof e.code !== 'string' || typeof e.message !== 'string') continue;
      issues.push({
        code: e.code,
        message: e.message,
        ...(typeof e.path === 'string' ? { path: e.path } : {}),
      });
    }
    return { ok: false, issues };
  }
  return null;
}

// ---------------------------------------------------------------------------
// step 6 — key load / generate
// ---------------------------------------------------------------------------

interface KeyOk {
  readonly ok: true;
  readonly privateKey: Uint8Array;
  readonly publicKeyId: string;
}
interface KeyErr {
  readonly ok: false;
  readonly error: Extract<PublishError, { code: 'key_missing' }>;
}

async function loadOrGenerateKey(opts: {
  readonly artifactId: string;
  readonly keyFlag?: string;
  readonly stdout: (s: string) => void;
}): Promise<KeyOk | KeyErr> {
  const scope = scopeOf(opts.artifactId);
  if (opts.keyFlag) {
    if (!existsSync(opts.keyFlag)) {
      return {
        ok: false,
        error: {
          code: 'key_missing',
          message: `--key path not found: ${opts.keyFlag}`,
        },
      };
    }
    const privateKey = readPrivateKey(opts.keyFlag);
    if (!privateKey) {
      return {
        ok: false,
        error: {
          code: 'key_missing',
          message: `--key path could not be read: ${opts.keyFlag}`,
        },
      };
    }
    return {
      ok: true,
      privateKey,
      publicKeyId: derivePublicKeyId(await publicKeyFromPrivate(privateKey)),
    };
  }
  const defaultPath = getPrivateKeyPath(scope);
  if (!hasKeypair(scope)) {
    // First-publish path — generate + persist + print public-key id
    // so the operator can register it with the registry's
    // author-keys endpoint.
    const fresh = await generateEd25519Keypair();
    writePrivateKey(scope, fresh.privateKey, fresh.publicKey);
    opts.stdout(
      `key: generated new keypair at ${defaultPath}\n` +
        `key: publicKeyId=${fresh.publicKeyId}\n` +
        `key: first-publish — register this public key with the registry by running \`ggui keys register --scope ${scope}\` if the registry returns \`unknown_key\`.\n`,
    );
    return {
      ok: true,
      privateKey: fresh.privateKey,
      publicKeyId: fresh.publicKeyId,
    };
  }
  const privateKey = readPrivateKey(defaultPath);
  if (!privateKey) {
    return {
      ok: false,
      error: {
        code: 'key_missing',
        message: `${defaultPath} exists but could not be read`,
      },
    };
  }
  return {
    ok: true,
    privateKey,
    publicKeyId: derivePublicKeyId(await publicKeyFromPrivate(privateKey)),
  };
}

// ---------------------------------------------------------------------------
// step 8 — POST /publish
// ---------------------------------------------------------------------------

interface PublishOk {
  readonly ok: true;
  readonly body: PublishResponseBody;
}
interface PublishErr {
  readonly ok: false;
  readonly error: Extract<
    PublishError,
    { code: 'publish_failed' | 'publish_stubbed' | 'auth_failed' }
  >;
}

interface PublishResponseBody {
  readonly artifactId: string;
  readonly version: string;
  readonly manifestUrl: string;
  readonly bundleUrl?: string;
  readonly signatureUrl?: string;
  readonly installCommand: string;
}

async function postPublish(opts: {
  readonly registryUrl: string;
  readonly token: string;
  readonly authKind: RegistryAuthKind;
  readonly manifest: GadgetManifest | BlueprintManifest;
  readonly bundleBytes?: Uint8Array;
  readonly bundleSha384?: string;
  readonly signature: GadgetSignature;
  readonly fetchImpl: typeof fetch;
}): Promise<PublishOk | PublishErr> {
  const url = `${opts.registryUrl}/publish`;
  const body = JSON.stringify({
    manifest: opts.manifest,
    ...(opts.bundleBytes !== undefined
      ? {
          bundle: Buffer.from(opts.bundleBytes).toString('base64'),
          bundleSha384: opts.bundleSha384,
        }
      : {}),
    signature: opts.signature,
  });
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
      },
      body,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'publish_failed',
        message: `network error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (res.status === 401) {
    return {
      ok: false,
      error: {
        code: 'auth_failed',
        message: describeRegistryAuthRejection(opts.authKind, '/publish'),
      },
    };
  }
  if (res.status === 501) {
    return {
      ok: false,
      error: {
        code: 'publish_stubbed',
        message: `publish endpoint not yet live for ${opts.registryUrl} (HTTP 501).`,
      },
    };
  }
  if (res.status === 201) {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'publish_failed',
          message: `201 but response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
          httpStatus: 201,
        },
      };
    }
    const body = parsePublishResponse(parsed);
    if (!body) {
      return {
        ok: false,
        error: {
          code: 'publish_failed',
          message: '201 but response body shape was not recognized',
          httpStatus: 201,
        },
      };
    }
    return { ok: true, body };
  }
  // Surface structured error codes when present.
  let serverCode: string | undefined;
  let message = `HTTP ${res.status}`;
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === 'object' && parsed !== null) {
      const r = parsed as { code?: unknown; message?: unknown };
      if (typeof r.code === 'string') serverCode = r.code;
      if (typeof r.message === 'string') message = `${message}: ${r.message}`;
    }
  } catch {
    // ignore — fall back to status text
  }
  return {
    ok: false,
    error: {
      code: 'publish_failed',
      message,
      httpStatus: res.status,
      ...(serverCode !== undefined ? { serverCode } : {}),
    },
  };
}

function parsePublishResponse(x: unknown): PublishResponseBody | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as {
    artifactId?: unknown;
    version?: unknown;
    manifestUrl?: unknown;
    bundleUrl?: unknown;
    signatureUrl?: unknown;
    installCommand?: unknown;
  };
  if (
    typeof r.artifactId !== 'string' ||
    typeof r.version !== 'string' ||
    typeof r.manifestUrl !== 'string' ||
    typeof r.installCommand !== 'string'
  ) {
    return null;
  }
  return {
    artifactId: r.artifactId,
    version: r.version,
    manifestUrl: r.manifestUrl,
    installCommand: r.installCommand,
    ...(typeof r.bundleUrl === 'string' ? { bundleUrl: r.bundleUrl } : {}),
    ...(typeof r.signatureUrl === 'string' ? { signatureUrl: r.signatureUrl } : {}),
  };
}

