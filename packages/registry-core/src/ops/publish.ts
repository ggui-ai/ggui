/**
 * `publishArtifact` — pure op for `POST /publish`.
 *
 * Flow (short-circuits on first failure):
 *
 *   1.  Validate {@link AuthnContext} present (transport enforces auth
 *       before calling; this is defense-in-depth).
 *   2.  Parse + validate the manifest via `parseArtifactManifest`.
 *   2b. Enforce the visibility ↔ signature-algorithm pairing
 *       (`public` ⇒ `sigstore-cosign`, `private` ⇒ `ed25519`) —
 *       cheap field comparison, before any decode or verify work.
 *   2c. Enforce scope ownership: a scope owned by another subject
 *       answers 403 `scope_forbidden`; an UNCLAIMED scope on the
 *       reserved list ({@link RESERVED_SCOPES}, replaceable via
 *       {@link PublishArtifactDeps.reservedScopes}) is never
 *       claimable, while a reserved scope WITH an ownership row
 *       (operator-seeded) follows the normal owner rule; any other
 *       unclaimed scope is claimed for the caller via the atomic
 *       {@link RegistryStorage.claimScope} (first-writer-wins; a lost
 *       race re-reads and re-applies the owner check). NOTE — the
 *       claim is durable when a LATER gate (bundle, conformance,
 *       crypto verify) fails this publish: by then the caller passed
 *       every policy gate, so the claim records legitimate intent, a
 *       failed-publish claim stays re-usable by the same caller, and
 *       an unverified claim remains reclaimable by the registry
 *       operator. Deliberately the simplest correct behavior.
 *   2d. Bind the publisher identity (F4, sigstore-signed publishes
 *       only): the bundle certificate's SAN must be on the scope's
 *       `sanAllowlist` when the ownership row carries one, else must
 *       equal the account's verified email when the deployment wires
 *       {@link PublishArtifactDeps.verifiedEmailResolver}. Neither
 *       configured ⇒ no identity rule (allowlist-only posture).
 *       Violations answer 403 `identity_mismatch`. On the UNCLAIMED
 *       path this gate runs BEFORE the claim — a rejected signer
 *       must not walk away owning the scope.
 *   3.  Decode + size-check the bundle (gadgets only).
 *   4.  Recompute SHA-384 of the bundle bytes; compare to client claim.
 *   5.  Re-run the conformance gate ({@link checkConformance}).
 *   6.  Verify the Ed25519 author signature — look up the
 *       {@link AuthorKeyRow} by `(subject, keyId)`, base64-decode the
 *       stored public key, call `verifyBundleEd25519`.
 *   7.  Insert the {@link ArtifactVersionRow} via
 *       {@link RegistryStorage.putArtifactVersionIfAbsent}. Re-publish
 *       (collision) returns 409 `version_exists`.
 *   8.  Upload the bundle + signature + manifest via
 *       {@link BundleStorage}.
 *   9.  Upsert the {@link ArtifactsMetadataRow} — only rewrites
 *       `latestVersion` when the new version is the highest semver.
 *   10. Return 201 with the wire-locked {@link PublishResponseBody}.
 */
import {
  manifestToRegistryEntry,
  parseArtifactManifest,
  type ArtifactManifest,
} from '@ggui-ai/artifact-manifest';
import {
  canonicalJson,
  extractSigstoreLeafCertPem,
  extractSigstoreSANs,
  isGadgetSignature,
  verifyBundleEd25519,
  verifyBundleSigstore,
  type GadgetSignature,
  type VerifyBundleSigstoreInput,
} from '@ggui-ai/gadget-signing';
import { bundleHostScheme, strictGadgetDescriptorSchema } from '@ggui-ai/protocol';
import { ZodError } from 'zod';
import type {
  ArtifactVersionRow,
  ArtifactsMetadataRow,
  CompiledBlobRow,
  PublishErrorBody,
  PublishErrorCode,
  PublishResponseBody,
  ScopeOwnerRow,
} from '../types.js';
import type {
  BlueprintProbeRunner,
  ConformanceFailureCode,
} from './conformance.js';
import { ARTIFACTS_METADATA_SK, SAN_ALLOWLIST_INVALID } from '../types.js';
import type { AuthnContext } from '../interfaces/authn.js';
import type { BundleStorage } from '../interfaces/bundle-storage.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';
import { safeBase64Decode, sha384Base64 } from '../utils/base64.js';
import { compareSemver } from '../utils/semver.js';
import { compileBlueprint } from './compile.js';
import { checkConformance } from './conformance.js';

/**
 * Hard cap on the base64-DECODED bundle byte length. 5 MiB matches the
 * apigwv2 Lambda integration payload ceiling (6 MB) minus headroom for
 * the manifest + signature + JSON envelope. OSS server enforces the
 * same ceiling for parity (a cloud-published bundle MUST be installable
 * against an OSS-mirrored registry without re-bundling).
 */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/**
 * Scopes no publish may CLAIM — well-known names whose squatting would
 * mislead installers about who authored an artifact. The default
 * covers first-party names plus obvious squat-bait; a deployment
 * REPLACES the whole list via
 * {@link PublishArtifactDeps.reservedScopes} (spread this constant to
 * extend it instead).
 *
 * Reserved scopes block first-publish CLAIMS only — not owned
 * publishes. A registry operator who wants artifacts under a reserved
 * name seeds its ownership row out-of-band via
 * {@link RegistryStorage.updateScopeOwner}; once the row exists, the
 * normal owner rule applies (the seeded owner publishes, everyone else
 * gets `scope_forbidden`) with no change to this list.
 */
export const RESERVED_SCOPES: readonly string[] = [
  '@ggui-ai',
  '@ggui',
  '@guuey',
  '@anthropic',
  '@claude',
  '@openai',
  '@google',
  '@gemini',
  '@meta',
  '@microsoft',
  '@aws',
  '@amazon',
  '@apple',
];

export interface PublishArtifactInput {
  /** Unvalidated request body — the op parses + validates. */
  readonly manifest: unknown;
  /** Base64-encoded gadget bundle bytes. Required if `kind === 'gadget'`. */
  readonly bundle?: string;
  /** Base64 SHA-384 digest of the decoded bundle bytes. Client-supplied; the op re-verifies. */
  readonly bundleSha384?: string;
  /**
   * Author signature. Discriminated union over `algorithm`:
   *   - `'ed25519'`         → private-gadget path, AuthorKeys-rooted
   *     trust chain.
   *   - `'sigstore-cosign'` → public-gadget path, Fulcio cert +
   *     Rekor inclusion trust chain.
   *
   * The op dispatches on `algorithm` after the signature-shape guard.
   */
  readonly signature: GadgetSignature;
}

export interface PublishArtifactDeps {
  readonly storage: RegistryStorage;
  readonly bundleStorage: BundleStorage;
  readonly authn: AuthnContext;
  readonly clock: () => Date;
  /**
   * Hostname the install CLI talks to — embedded into the success
   * response's `installCommand`. Cloud: API Gateway custom domain (e.g.
   * `dev.registry.sandbox.ggui.ai`). OSS: `localhost:9001` etc.
   *
   * No protocol prefix — the op composes `https://` for cloud and
   * `http://` for `localhost`/`127.0.0.1`.
   */
  readonly registryHostname: string;
  /**
   * Scopes no publish may claim — REPLACES {@link RESERVED_SCOPES}
   * when set (spread the constant to extend instead:
   * `[...RESERVED_SCOPES, '@my-brand']`). Exact-match against
   * `manifest.scope`, leading `@` included.
   */
  readonly reservedScopes?: readonly string[];
  /**
   * Optional runtime probe for blueprint manifests. Static gates
   * always run; the probe additionally compiles + renders the
   * blueprint default export with the manifest's fixtureProps in a
   * sandboxed Node `vm` + React server-renderer.
   *
   * Wire from `@ggui-ai/blueprint-probe` in OSS and cloud Lambda
   * environments where the runtime probe is desired. Leaving it
   * unset skips the probe — useful for the standalone conformance
   * HTTP endpoint that should not pay for react-dom.
   */
  readonly blueprintProbe?: BlueprintProbeRunner;
  /**
   * Optional TUF trust-root tuning forwarded verbatim to
   * sigstore-cosign signature verification (see
   * {@link VerifyBundleSigstoreInput}). `tufCachePath` points the
   * verifier's trust-root cache at a writable directory — serverless
   * runtimes typically only allow writes under `/tmp`.
   * `tufForceCache` reuses valid cached TUF metadata without a remote
   * refresh. `tufMirrorURL` + `tufRootPath` select an alternative TUF
   * repository (private sigstore deployments; hermetic tests) — the
   * trust root is THE knob that decides which signing infrastructure
   * this registry's verifier trusts. Ed25519 verification never
   * consults any of these.
   */
  readonly sigstoreTuf?: Pick<
    VerifyBundleSigstoreInput,
    'tufCachePath' | 'tufForceCache' | 'tufMirrorURL' | 'tufRootPath'
  >;
  /**
   * F4 identity binding — resolve the VERIFIED email address of the
   * publishing account identified by `subject` (the same value as
   * {@link AuthnContext.subject}). Return `undefined` when the account
   * has no verified email; the resolver MUST NOT return an address the
   * deployment's identity layer has not verified, because the publish
   * gate authorizes signer identities against it.
   *
   * Consumed only on sigstore-signed publishes into a scope whose
   * ownership row carries NO `sanAllowlist`: the bundle's certificate
   * SAN must then equal the resolved email (compared
   * case-insensitively). Scopes WITH an allowlist never consult the
   * resolver — the allowlist is the stricter, operator-managed rule.
   *
   * OPTIONAL, and honestly so: a deployment that does not wire a
   * resolver enforces publisher identity ONLY through per-scope
   * allowlists ({@link ScopeOwnerRow.sanAllowlist}); scopes without
   * one accept any identity a valid sigstore bundle proves. Wire a
   * resolver backed by your identity provider to bind default
   * publishes to account emails.
   */
  readonly verifiedEmailResolver?: VerifiedEmailResolver;
}

/**
 * Deployment-provided lookup from an authenticated caller subject to
 * that account's VERIFIED email address. See
 * {@link PublishArtifactDeps.verifiedEmailResolver} for the contract
 * (parties, obligations, and the fail-closed posture the publish gate
 * layers on top).
 */
export type VerifiedEmailResolver = (
  subject: string,
) => Promise<string | undefined>;

export type PublishArtifactResult =
  | { readonly ok: true; readonly status: 201; readonly body: PublishResponseBody }
  | {
      readonly ok: false;
      readonly status: 400 | 401 | 403 | 409 | 413 | 500;
      readonly body: PublishErrorBody;
    };

export async function publishArtifact(
  input: PublishArtifactInput,
  deps: PublishArtifactDeps,
): Promise<PublishArtifactResult> {
  // 1. Authn — transport enforces before calling, but defensive read.
  if (typeof deps.authn.subject !== 'string' || deps.authn.subject.length === 0) {
    return error(401, 'unauthorized', 'request is missing a verified caller subject');
  }

  // 1b. Signature shape — transport pre-decoded the JSON envelope; we
  // still validate the structured object before the cryptographic
  // path. The discriminated guard accepts both Ed25519 (private) and
  // sigstore-cosign (public) shapes; the verify-time dispatch on
  // `signature.algorithm` selects the correct trust chain.
  if (!isGadgetSignature(input.signature)) {
    return error(
      400,
      'signature_invalid',
      'request body is missing or malformed `signature` (expected Ed25519Signature or SigstoreSignature shape)',
    );
  }

  // 2. Manifest schema
  let manifest: ArtifactManifest;
  try {
    manifest = parseArtifactManifest(input.manifest);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const path = (first?.path ?? []).map((seg) =>
        typeof seg === 'symbol' ? String(seg) : seg,
      );
      return error(
        400,
        'manifest_invalid',
        first?.message ?? 'manifest failed schema validation',
        { path, issues: err.issues },
      );
    }
    return error(
      400,
      'manifest_invalid',
      `manifest failed validation: ${errorMessage(err)}`,
    );
  }

  const artifactId = `${manifest.scope}/${manifest.name}`;
  const version = manifest.version;

  // 2b. Visibility ↔ signature-algorithm pairing. The two algorithms
  // carry different trust models: sigstore keyless signing records
  // every publish in a public transparency log — the third-party
  // auditability that makes an artifact safe to list publicly — while
  // an Ed25519 author key leaves no public record, which is the point
  // for private artifacts. Clients pair them at signing time, but the
  // server cannot trust a hand-rolled request: an unenforced
  // public+Ed25519 publish would become publicly listable with no
  // transparency-log entry. Cheap field comparison — runs before any
  // bundle decode, conformance, or cryptographic verify work.
  if (manifest.visibility === 'public' && input.signature.algorithm === 'ed25519') {
    return error(
      400,
      'visibility_algorithm_mismatch',
      "`visibility: 'public'` requires a sigstore keyless signature (`algorithm: 'sigstore-cosign'`) so the publish is recorded in a public transparency log. Ed25519 author-key signatures pair with `visibility: 'private'` — re-sign with sigstore, or publish as private.",
    );
  }
  if (manifest.visibility === 'private' && input.signature.algorithm === 'sigstore-cosign') {
    return error(
      400,
      'visibility_algorithm_mismatch',
      "`visibility: 'private'` requires an Ed25519 author-key signature. Sigstore keyless signing (`algorithm: 'sigstore-cosign'`) records the publish in a public transparency log and pairs with `visibility: 'public'` — re-sign with your Ed25519 author key, or publish as public.",
    );
  }

  // 2c. Scope ownership. Runs after the pairing check (2b) and before
  // any bundle decode — ownership is a cheap read and a forbidden
  // publish must not pay for (or leak errors from) bundle work.
  //
  // Order within the gate: owner lookup first, then — only when the
  // scope is UNCLAIMED — the reserved denylist, then the first-publish
  // claim. Reserved scopes block CLAIMS, not owned publishes: a scope
  // whose ownership row exists (seeded by the registry operator, or
  // grandfathered) follows the normal owner rule, so the operator can
  // publish first-party artifacts under a reserved name without
  // touching the reserved list. A lost claim race re-reads and
  // re-applies the owner check — the conditional create in
  // `claimScope` is the only race-safe primitive, so `conflict` means
  // somebody else's row is now durable and the re-read decides whose
  // scope this is.
  //
  // The claim is DURABLE when a LATER gate (bundle, conformance,
  // crypto verify) fails this publish (documented judgment call — see
  // the flow docstring): by then the caller has already passed every
  // policy gate, so the claim records legitimate intent. The identity
  // gate (2d) is different — it runs BEFORE the claim on the unclaimed
  // path, because a signer the scope's identity rule rejects must not
  // walk away owning the scope. That ordering costs nothing: a fresh
  // claim can never carry a `sanAllowlist`, so only the deployment's
  // default email rule can apply pre-claim. The claim still lands
  // before cryptographic signature verification: moving it after would
  // not stop a motivated squatter (any authenticated caller can
  // produce a validly-signed private publish), so the real defenses
  // against mass squatting are the operator reclaim flow, the audit
  // trail, and (future) rate limiting.
  const scopeForbiddenByOwner = (): PublishArtifactResult =>
    error(
      403,
      'scope_forbidden',
      `scope \`${manifest.scope}\` is owned by another publisher. Choose a scope you own — your first publish into an unclaimed scope claims it. If you hold the rights to this name (for example the matching domain or brand), the registry operator can verify that ownership and reclaim an unverified scope.`,
    );

  // 2d. Publisher-identity binding (F4) — sigstore-signed publishes
  // only (returns `undefined` = pass for Ed25519). Binds the bundle's
  // certificate identity (the Fulcio cert's SAN) to the ggui account
  // that owns (or is claiming) the scope, so a valid-but-unrelated
  // OIDC identity can no longer sign publishes into it. Two rules,
  // strictly ordered:
  //
  //   1. ALLOWLIST — the ownership row carries a non-empty
  //      `sanAllowlist`: the SAN must be one of its literal entries
  //      (operator-managed; org/CI flexibility).
  //   2. VERIFIED EMAIL (default) — no allowlist, and the deployment
  //      wires {@link PublishArtifactDeps.verifiedEmailResolver}: the
  //      SAN must equal the account's verified email
  //      (case-insensitive). An account without a verified email
  //      fails closed.
  //
  // No allowlist AND no resolver ⇒ no identity rule — the deployment
  // enforces identity only through allowlists (see the resolver
  // docstring for why that posture is documented rather than papered
  // over).
  //
  // Invocation points (all before bundle decode or cryptographic
  // verify — the SAN is a cheap local projection, so a forbidden
  // identity never pays for, or leaks errors from, bundle work):
  //   - claimed scope: with the stored ownership row;
  //   - unclaimed scope: with `null` BEFORE the claim (fresh claims
  //     never carry an allowlist — email rule only);
  //   - lost claim race won by the same subject: re-run with the
  //     winner row, which MAY be operator-seeded with an allowlist.
  // The projection is trustworthy in the reject direction
  // unconditionally; in the accept direction it is paired with the
  // REAL `verifyBundleSigstore` at step 6, which proves the same
  // SAN-bearing cert is genuinely CA-issued and bound to the signed
  // bytes (same parser both places — the projection cannot drift from
  // what verification enforces).
  //
  // Error hygiene: messages name the rule that failed and MAY echo the
  // caller's OWN certificate identity (they supplied it), but NEVER
  // other identities — not allowlist entries, not the account email.
  const checkPublisherIdentity = async (
    ownerRow: ScopeOwnerRow | null,
  ): Promise<PublishArtifactResult | undefined> => {
    if (input.signature.algorithm !== 'sigstore-cosign') return undefined;
    // Fail closed on corrupt policy data: a storage adapter projects a
    // malformed allowlist column as SAN_ALLOWLIST_INVALID (see the
    // ScopeOwnerRow docstring). Falling through to the email rule (or
    // no rule) would let corruption silently WIDEN who may publish.
    const rawAllowlist = ownerRow?.sanAllowlist;
    if (rawAllowlist === SAN_ALLOWLIST_INVALID) {
      return error(
        500,
        'internal',
        `scope \`${manifest.scope}\` has a malformed publisher-identity allowlist in storage — refusing to fall back to a weaker identity rule. A registry operator must rewrite the scope's allowlist (set or clear it) before sigstore publishes into this scope can proceed.`,
      );
    }
    // An empty allowlist behaves like an absent one — the allowlist
    // rule applies only when at least one entry names a signer.
    const sanAllowlist = rawAllowlist ?? [];
    const resolver = deps.verifiedEmailResolver;
    if (sanAllowlist.length === 0 && resolver === undefined) return undefined;
    // EVERY SAN on the certificate (a Fulcio cert can carry both a
    // URI and an email SAN) — the rules below accept on ANY hit, so a
    // both-SAN cert matches whichever identity the policy names.
    const sans = extractSigstoreSANs(input.signature).map((san) =>
      san.toLowerCase(),
    );
    if (sans.length === 0) {
      return error(
        403,
        'identity_mismatch',
        `scope \`${manifest.scope}\` requires a bound publisher identity, but the sigstore bundle's certificate carries no subject identity (SAN) to check`,
      );
    }
    const echoedSans = sans.map((san) => `\`${san}\``).join(', ');
    if (sanAllowlist.length > 0) {
      // ONE case rule for every identity comparison (mirrors the email
      // rule below): operator tooling lowercase-normalizes entries at
      // write, and the comparison is case-insensitive regardless so
      // rows seeded by other paths behave identically.
      const allowlistLower = sanAllowlist.map((entry) => entry.toLowerCase());
      if (!sans.some((san) => allowlistLower.includes(san))) {
        return error(
          403,
          'identity_mismatch',
          `no certificate identity (${echoedSans}) is on the publisher-identity allowlist for scope \`${manifest.scope}\`. Sign with an allowlisted identity, or ask the registry operator to update the scope's allowlist.`,
        );
      }
      return undefined;
    }
    if (resolver !== undefined) {
      const verifiedEmail = await resolver(deps.authn.subject);
      if (verifiedEmail === undefined) {
        return error(
          403,
          'identity_mismatch',
          `scope \`${manifest.scope}\` binds publishes to the account's verified email, but the publishing account has none. Verify your account email, or ask the registry operator to set a publisher-identity allowlist for the scope. If you verified your email just now, it can take a minute to propagate — retry shortly.`,
        );
      }
      if (!sans.includes(verifiedEmail.toLowerCase())) {
        return error(
          403,
          'identity_mismatch',
          `no certificate identity (${echoedSans}) matches the publishing account's verified email. Sign with the OIDC identity of your account email, or ask the registry operator to add this identity to the scope's publisher allowlist.`,
        );
      }
    }
    return undefined;
  };

  const existingOwner = await deps.storage.getScopeOwner(manifest.scope);
  if (existingOwner !== null && existingOwner.ownerSubject !== deps.authn.subject) {
    return scopeForbiddenByOwner();
  }
  if (existingOwner !== null) {
    const identityFailure = await checkPublisherIdentity(existingOwner);
    if (identityFailure !== undefined) return identityFailure;
  } else {
    const reservedScopes = deps.reservedScopes ?? RESERVED_SCOPES;
    if (reservedScopes.includes(manifest.scope)) {
      return error(
        403,
        'scope_forbidden',
        `scope \`${manifest.scope}\` is reserved on this registry and cannot be claimed by publishing. Choose a scope you own — your first publish into an unclaimed scope claims it.`,
      );
    }
    // Identity BEFORE the claim (review r1 finding 2): a rejected
    // signer must not walk away owning the scope. Fresh claims carry
    // no allowlist, so this pre-claim run applies the email rule only.
    const identityFailure = await checkPublisherIdentity(null);
    if (identityFailure !== undefined) return identityFailure;
    const claim = await deps.storage.claimScope({
      scope: manifest.scope,
      ownerSubject: deps.authn.subject,
      claimedAt: deps.clock().toISOString(),
      verification: 'unverified',
    });
    if ('conflict' in claim) {
      // Lost the race — re-read and re-apply the owner check.
      const winner = await deps.storage.getScopeOwner(manifest.scope);
      if (winner === null) {
        // claimScope reported an existing row but the re-read found
        // none — storage-layer inconsistency, not a policy outcome.
        return error(
          500,
          'internal',
          `scope claim for \`${manifest.scope}\` conflicted but no ownership row exists — storage inconsistency`,
        );
      }
      if (winner.ownerSubject !== deps.authn.subject) {
        return scopeForbiddenByOwner();
      }
      // The winner row may be operator-seeded WITH an allowlist the
      // pre-claim run (against `null`) never saw — re-apply the gate
      // against the durable row.
      const raceIdentityFailure = await checkPublisherIdentity(winner);
      if (raceIdentityFailure !== undefined) return raceIdentityFailure;
    }
  }

  // 3. Bundle decode + size (gadgets only)
  let bundleBytes: Uint8Array | undefined;
  if (manifest.kind === 'gadget') {
    if (input.bundle === undefined || input.bundle.length === 0) {
      return error(
        400,
        'bundle_required',
        'gadget publish requires a base64-encoded `bundle` field — blueprint manifests carry source inline, but gadgets ship compiled bytes',
      );
    }
    const decoded = safeBase64Decode(input.bundle);
    if (decoded === undefined) {
      return error(400, 'manifest_invalid', '`bundle` field is not valid base64');
    }
    if (decoded.byteLength > MAX_BUNDLE_BYTES) {
      return error(
        413,
        'bundle_too_large',
        `bundle is ${decoded.byteLength} bytes; maximum is ${MAX_BUNDLE_BYTES} bytes (${MAX_BUNDLE_BYTES / (1024 * 1024)} MiB)`,
      );
    }
    bundleBytes = decoded;

    // 4. Hash check
    if (input.bundleSha384 === undefined || input.bundleSha384.length === 0) {
      return error(
        400,
        'bundle_hash_mismatch',
        'gadget publish requires `bundleSha384` (base64 SHA-384 digest of the decoded bundle bytes)',
      );
    }
    const recomputed = sha384Base64(bundleBytes);
    if (recomputed !== input.bundleSha384) {
      return error(
        400,
        'bundle_hash_mismatch',
        'server-computed SHA-384 of the bundle does not match the client-supplied `bundleSha384`',
        { expected: recomputed, received: input.bundleSha384 },
      );
    }

    // 4b. Projection viability — the install path projects this
    // manifest into a catalog row (`manifestToRegistryEntry` →
    // `strictGadgetDescriptorSchema`). The two schemas are separate
    // validators (e.g. manifest `connect[]` entries are free-form
    // strings while catalog `connect[]` entries must be full URLs),
    // and a published version is immutable — a manifest that projects
    // to an invalid row would be PERMANENTLY uninstallable. Reject it
    // now, naming the offending field, while the author can still fix
    // and republish.
    const projected = manifestToRegistryEntry(manifest, {
      version: manifest.version,
      // Representative install-time computed fields: the bundle URL is
      // stamped by storage later, so a syntactically valid placeholder
      // stands in; the SRI is the real digest verified above.
      bundleUrl: 'https://registry.invalid/bundle.js',
      bundleSri: `sha384-${recomputed}`,
    });
    const projectionCheck = strictGadgetDescriptorSchema.safeParse(projected);
    if (!projectionCheck.success) {
      const first = projectionCheck.error.issues[0];
      const path = (first?.path ?? [])
        .map((seg) => String(seg))
        .join('.');
      return error(
        400,
        'manifest_invalid',
        `manifest projects to an invalid gadget catalog row at \`${path}\`: ${
          first?.message ?? 'schema violation'
        } — installs would reject this artifact, and published versions are immutable. Fix the field and republish.`,
        { path, issues: projectionCheck.error.issues },
      );
    }
  }

  // 5. Conformance gate
  const conformanceBundleText =
    bundleBytes === undefined
      ? undefined
      : Buffer.from(bundleBytes.buffer, bundleBytes.byteOffset, bundleBytes.byteLength).toString(
          'utf8',
        );
  const conformanceResult = checkConformance({
    manifest,
    bundle: conformanceBundleText,
  });
  if (!conformanceResult.ok) {
    return conformanceFailureResponse(conformanceResult.errors);
  }

  // 5b. Blueprint runtime probe — opt-in via deps.blueprintProbe.
  // Static gates already accepted the manifest above; the probe runs
  // only for blueprints and only when the caller wired a runner.
  // Probe failures surface through the same `conformance_failed`
  // envelope so wire consumers don't branch on a separate error code.
  if (manifest.kind === 'blueprint' && deps.blueprintProbe !== undefined) {
    const probeResult = await deps.blueprintProbe.probe(manifest);
    if (!probeResult.ok) {
      return conformanceFailureResponse(probeResult.errors);
    }
  }

  // 6. Signature verification — dispatch on the locked discriminator.
  //
  // `authorPublicKey` is the publisher identity persisted on the
  // version row (`ArtifactVersionRow.authorPublicKey`). For Ed25519
  // it's the base64 32-byte public key; for sigstore-cosign it's
  // the leaf-cert PEM extracted from the bundle.
  const bytesForSignature =
    bundleBytes ?? new TextEncoder().encode(canonicalJson(manifest));
  let authorPublicKey: string;

  if (input.signature.algorithm === 'ed25519') {
    // Private gadgets — AuthorKeys-rooted trust chain.
    const authorKeyRow = await deps.storage.getAuthorKey(
      deps.authn.subject,
      input.signature.publicKeyId,
    );
    if (authorKeyRow === null) {
      return error(
        403,
        'unknown_key',
        `no registered AuthorKeys row for publisher \`${deps.authn.subject}\` + keyId \`${input.signature.publicKeyId}\` — run \`ggui keygen\` and register the public key before publishing`,
      );
    }

    const publicKeyBytes = safeBase64Decode(authorKeyRow.publicKeyBase64);
    if (publicKeyBytes === undefined) {
      return error(500, 'internal', 'author key row is malformed');
    }

    const verifyResult = await verifyBundleEd25519({
      bundleBytes: bytesForSignature,
      signature: input.signature,
      publicKey: publicKeyBytes,
    });
    if (!verifyResult.valid) {
      return error(400, 'signature_invalid', verifyResult.reason);
    }
    authorPublicKey = authorKeyRow.publicKeyBase64;
  } else {
    // Public gadgets — sigstore (Fulcio + Rekor) trust chain.
    // Identity claim: gate 2d already bound the certificate's SAN to
    // the scope's allowlist / the account's verified email (where
    // configured — see the gate for the honest no-rule posture). This
    // verify is the cryptographic half of that pairing: it proves the
    // SAN-bearing cert is genuinely CA-issued, transparency-logged,
    // and bound to the signed bytes. Install-time consumers can layer
    // their own policy via `--verify-identity <pattern>` (CLI install
    // flag) — a separate trust decision controlled by the install
    // operator, not the publisher.
    const verifyResult = await verifyBundleSigstore({
      bundleBytes: bytesForSignature,
      signature: input.signature,
      ...(deps.sigstoreTuf ?? {}),
    });
    if (!verifyResult.valid) {
      return error(400, 'signature_invalid', verifyResult.reason);
    }
    // Persist the leaf cert PEM on the version row so install
    // consumers can render the signer identity. The cosign-bundle
    // parsing lives in `@ggui-ai/gadget-signing` next to the verify
    // impl (single source of truth for the bundle shape).
    const leafCertPem = extractSigstoreLeafCertPem(input.signature);
    if (leafCertPem === undefined) {
      return error(
        400,
        'signature_invalid',
        'sigstore verify succeeded but bundle carries no leaf certificate — expected `verificationMaterial.certificate.rawBytes` (bundle v0.3) or `verificationMaterial.x509CertificateChain.certificates[0].rawBytes` (v0.1/v0.2) — cannot pin author identity on the version row',
      );
    }
    authorPublicKey = leafCertPem;
  }

  // 6b. Blueprint compile boundary (TSX → JS).
  // Blueprints compile at publish time; the canonical compiled JS bytes
  // are stored content-addressed in {@link CompiledBlobRow} and the
  // version row only carries the digest pointer. Two-layer storage
  // gives dedup (byte-identical compiled output reuses one blob row)
  // and federation-ready content-addressable identity.
  //
  // Compile failure surfaces through the same `conformance_failed`
  // wire envelope as the static gates — same shape, same code
  // (`blueprint_compile_error`). The static gate already runs a
  // best-effort `transformSync` to catch the same class of errors;
  // this is the load-bearing run (its output is what's persisted).
  let compiledDigest: string | undefined;
  let compiledBlobToWrite: CompiledBlobRow | undefined;
  if (manifest.kind === 'blueprint') {
    const compileResult = compileBlueprint(manifest.source);
    if (!compileResult.ok) {
      return conformanceFailureResponse(
        compileResult.errors.map((e) => ({
          code: 'blueprint_compile_error' as const,
          message: e.message,
          ...(e.location !== undefined ? { detail: { location: e.location } } : {}),
        })),
      );
    }
    compiledDigest = compileResult.compiledDigest;
    compiledBlobToWrite = {
      compiledDigest: compileResult.compiledDigest,
      compiledBytes: compileResult.compiledBytes,
      compiledSize: compileResult.compiledSize,
      refCount: 1,
      // Persist the publisher's signature envelope inline on the blob
      // row so a hosted install path can re-verify without a second
      // fetch. Stored as a JSON-encoded `GadgetSignature` discriminated
      // union; the install path runs `JSON.parse` + `isGadgetSignature`
      // before dispatching to verifyBundleEd25519 / verifyBundleSigstore.
      manifestSig: JSON.stringify(input.signature),
      // compiledSig still reserved — a registry-rooted sigstore
      // signature over the compiled bytes is a future enhancement.
      createdAt: deps.clock().toISOString(),
    };
  }

  // 7. Atomic commit.
  //
  // For blueprints — version row + compiled-blob row land under one
  // logical transaction via `commitVersionAndBlob`. The DDB impl uses
  // `TransactWriteItems` so the all-or-nothing guarantee holds at the
  // service level; memory + filesystem impls get atomicity from the
  // single-threaded JS event loop.
  //
  // For gadgets — no compiled-blob row, so we still use the simple
  // conditional version-row insert. (Adding a synthetic blob row for
  // gadgets just to share the code path would widen the schema; the
  // discriminator on `kind` is cleaner.)
  //
  // Either way: the version-row conditional `attribute_not_exists` is
  // the load-bearing concurrency primitive. On conflict, return 409
  // `version_exists` immediately — the publisher's idempotent retry path.
  const nowIso = deps.clock().toISOString();
  const sriHash = bundleBytes === undefined ? undefined : `sha384-${sha384Base64(bundleBytes)}`;
  const bundleUrl =
    bundleBytes === undefined
      ? undefined
      : deps.bundleStorage.bundleUrl(manifest.scope, manifest.name, version);
  const signatureUrl =
    bundleBytes === undefined
      ? undefined
      : deps.bundleStorage.signatureUrl(manifest.scope, manifest.name, version);

  const versionRow: ArtifactVersionRow = {
    artifactId,
    version,
    manifest,
    kind: manifest.kind,
    visibility: manifest.visibility,
    bundleUrl,
    bundleSri: sriHash,
    signatureUrl,
    ...(compiledDigest !== undefined ? { compiledDigest } : {}),
    authorPublicKey,
    publishedAt: nowIso,
    publishedBy: deps.authn.subject,
  };

  if (compiledBlobToWrite !== undefined) {
    // Blueprint path — atomic two-row commit.
    let commitResult: Awaited<ReturnType<typeof deps.storage.commitVersionAndBlob>>;
    try {
      commitResult = await deps.storage.commitVersionAndBlob(versionRow, compiledBlobToWrite);
    } catch (err) {
      return error(
        500,
        'internal',
        `failed to commit version + compiled-blob rows for ${artifactId}@${version}: ${errorMessage(err)}`,
      );
    }
    if (!commitResult.ok) {
      return error(
        409,
        'version_exists',
        `${artifactId}@${version} is already published — versions are immutable. Publish a new version instead.`,
      );
    }
  } else {
    // Gadget path — single conditional version-row insert.
    const insertResult = await deps.storage.putArtifactVersionIfAbsent(versionRow);
    if (!insertResult.ok) {
      return error(
        409,
        'version_exists',
        `${artifactId}@${version} is already published — versions are immutable. Publish a new version instead.`,
      );
    }
  }

  // 8. Upload bundle + signature + manifest
  let manifestUrl: string;
  try {
    if (bundleBytes !== undefined) {
      await deps.bundleStorage.putBundle(manifest.scope, manifest.name, version, bundleBytes);
      await deps.bundleStorage.putSignature(
        manifest.scope,
        manifest.name,
        version,
        input.signature,
      );
    }
    manifestUrl = await deps.bundleStorage.putManifest(
      manifest.scope,
      manifest.name,
      version,
      manifest,
    );
  } catch (err) {
    return error(500, 'internal', `failed to upload artifact: ${errorMessage(err)}`);
  }

  // 9. Upsert Plugins metadata row.
  // Only rewrite `latestVersion` when the new version is the highest
  // semver. Race-condition note: between the get and the put, another
  // concurrent publisher could update the row. We accept rare
  // last-writer-wins on `latestVersion` — per-version row INSERT
  // remains strongly conditional, which is the load-bearing invariant.
  const existing = await deps.storage.getArtifactMetadata(artifactId);
  const shouldUpdateLatest =
    existing === null || compareSemver(version, existing.latestVersion) > 0;

  if (shouldUpdateLatest) {
    // Denormalized search field — a gadget package's primary (first)
    // export name. The package may export several hooks/components;
    // the manifest's `exports[]` is the source of truth.
    const primaryExport =
      manifest.kind === 'gadget' ? manifest.exports[0] : undefined;
    const metadataRow: ArtifactsMetadataRow = {
      artifactId,
      sk: ARTIFACTS_METADATA_SK,
      kind: manifest.kind,
      latestVersion: version,
      description: manifest.description,
      tags: manifest.tags,
      visibility: manifest.visibility,
      hook:
        primaryExport === undefined
          ? undefined
          : 'hook' in primaryExport
            ? primaryExport.hook
            : primaryExport.component,
      authorName: manifest.author?.name,
      publishedAt: nowIso,
      publishedBy: deps.authn.subject,
    };
    try {
      await deps.storage.putArtifactMetadata(metadataRow);
    } catch (err) {
      return error(500, 'internal', `failed to write Plugins metadata row: ${errorMessage(err)}`);
    }
  }

  // 10. Success
  return {
    ok: true,
    status: 201,
    body: {
      artifactId,
      version,
      manifestUrl,
      bundleUrl,
      signatureUrl,
      installCommand: buildInstallCommand(artifactId, version, deps.registryHostname, manifest.kind),
    },
  };
}

/** Compose the install command. Loopback hosts use http://; everything else https://. */
function buildInstallCommand(
  artifactId: string,
  version: string,
  registryHostname: string,
  kind: 'gadget' | 'blueprint',
): string {
  // Loopback hosts get `http://`. Symmetric with the push-time
  // `resolveGadgetUrls` resolver in `@ggui-ai/mcp-server-handlers` —
  // install + render MUST agree on scheme for local-dev / sandbox
  // workflows, otherwise the iframe blocks mixed content.
  return `ggui ${kind} install ${artifactId}@${version} --registry=${bundleHostScheme(registryHostname)}://${registryHostname}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function error(
  status: 400 | 401 | 403 | 409 | 413 | 500,
  code: PublishErrorCode,
  message: string,
  detail?: unknown,
): PublishArtifactResult {
  return {
    ok: false,
    status,
    body: detail === undefined ? { error: code, message } : { error: code, message, detail },
  };
}

/**
 * Translate a {@link ConformanceResponseBody} error list into a 400
 * `PublishArtifactResult`. Used by both the static-gate failure path
 * and the runtime-probe failure path so the wire shape is identical
 * regardless of which gate caught the issue.
 *
 * The first failure's sub-discriminator is hoisted to the wire body's
 * TOP level (alongside `error: 'conformance_failed'`) so callers can
 * branch without parsing nested JSON. The full error list stays in
 * `detail.errors` for verbose rendering.
 */
function conformanceFailureResponse(
  errors: ReadonlyArray<{ readonly code: ConformanceFailureCode; readonly message: string; readonly detail?: unknown }>,
): PublishArtifactResult {
  const conformanceFailureCode: ConformanceFailureCode | undefined = errors[0]?.code;
  const body: PublishErrorBody =
    conformanceFailureCode === undefined
      ? {
          error: 'conformance_failed',
          message: 'submission failed the registry conformance gate',
          detail: { errors },
        }
      : {
          error: 'conformance_failed',
          message: 'submission failed the registry conformance gate',
          conformanceFailureCode,
          detail: { errors },
        };
  return { ok: false, status: 400, body };
}
