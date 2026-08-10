/**
 * The single ownership rule for private-row reads.
 *
 * A `visibility: 'private'` row is readable when the verified caller
 * is the row's publisher (`authn.subject === row.publishedBy`) OR the
 * owner of the artifact's scope (`authn.subject === ScopeOwnerRow.
 * ownerSubject`). Everyone else — including anonymous callers — MUST
 * receive a response indistinguishable from "no such artifact" so a
 * probe can never confirm a private artifact exists.
 *
 * Every read-path consumer (the read op, the list-versions op, any
 * transport route that serves private artifact content — bundle and
 * signature byte routes included) MUST authorize through this one
 * predicate. A second hand-rolled comparison is how the rule forks;
 * import this instead. Note the byte-route obligation explicitly:
 * metadata gating alone is insufficient while bundle URLs serve
 * private bytes anonymously — a deployment MUST place its private
 * bundle storage behind a route that applies this same predicate
 * (the hosted deployment's public/private storage-prefix split does
 * exactly that).
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:** read-path ops and transport routes are the callers;
 * the deployment's {@link RegistryStorage.getScopeOwner} backs the
 * lazy scope-owner lookup.
 *
 * **Obligations:** callers MUST pass the verified caller context (or
 * `undefined` for anonymous) — never a caller-supplied subject. The
 * `getScopeOwner` thunk MUST resolve the ownership row for the
 * artifact's scope (see {@link artifactScope}); it is invoked at most
 * once, and ONLY when the caller is authenticated and not the
 * publisher — the hot public path and the publisher fast path incur
 * zero extra storage reads. Callers SHOULD build the thunk via
 * {@link createScopeOwnerResolver}, which adds memoization and the
 * fail-closed error posture.
 *
 * **Failure mode:** {@link createScopeOwnerResolver} resolves a
 * storage failure to `null` (unclaimed) — the owner arm DENIES, the
 * caller answers with its ordinary miss shape, and the fault is
 * logged server-side. Failing open would serve the private row;
 * failing loud (a 5xx only private rows can trigger) would leak
 * existence. A hand-built thunk that rejects propagates to the
 * caller instead — prefer the resolver.
 *
 * **Observable violation:** a private row served to a subject that is
 * neither its `publishedBy` nor its scope's `ownerSubject` — pinned
 * by the op suites (`read.test.ts`, `list-versions.test.ts`) and the
 * server parity suite.
 */
import type { AuthnContext } from '../interfaces/authn.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';
import type { ArtifactVersionRow, ScopeOwnerRow } from '../types.js';

/**
 * Decide whether `authn` may read a private row.
 *
 * @param authn verified caller context; `undefined` for anonymous.
 * @param row the private row under decision (only `publishedBy` is
 *   consulted — pass the full row or a narrowed projection).
 * @param getScopeOwner lazy scope-owner lookup for the artifact's
 *   scope. Called at most once, only when the publisher fast path
 *   misses. Build it with {@link createScopeOwnerResolver} for
 *   memoization + fail-closed semantics.
 */
export async function canReadPrivateArtifact(
  authn: AuthnContext | undefined,
  row: Pick<ArtifactVersionRow, 'publishedBy'>,
  getScopeOwner: () => Promise<ScopeOwnerRow | null>,
): Promise<boolean> {
  if (authn === undefined) return false;
  if (authn.subject === row.publishedBy) return true;
  const owner = await getScopeOwner();
  return owner !== null && owner.ownerSubject === authn.subject;
}

/**
 * Build the memoized, fail-closed `getScopeOwner` thunk for
 * {@link canReadPrivateArtifact}.
 *
 *   - **Lazy** — no storage read happens until the owner arm is
 *     actually needed (public rows, anonymous callers, and publisher
 *     matches never trigger one).
 *   - **Memoized** — a caller checking many rows of one artifact
 *     (the list op) pays for at most one lookup.
 *   - **Fail-closed** — a storage failure resolves to `null`
 *     (unclaimed ⇒ deny) and is logged server-side with structure;
 *     the raw error never reaches a wire body. See the failure-mode
 *     section above for why neither fail-open nor fail-loud is
 *     acceptable here.
 */
export function createScopeOwnerResolver(
  storage: Pick<RegistryStorage, 'getScopeOwner'>,
  artifactId: string,
): () => Promise<ScopeOwnerRow | null> {
  let lookup: Promise<ScopeOwnerRow | null> | undefined;
  return () => {
    lookup ??= storage.getScopeOwner(artifactScope(artifactId)).catch((err) => {
      // eslint-disable-next-line no-console -- server-side operator signal; the wire stays opaque
      console.error(
        'registry: scope-owner lookup failed; treating scope as unclaimed (fail closed)',
        {
          artifactId,
          scope: artifactScope(artifactId),
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return null;
    });
    return lookup;
  };
}

/**
 * Extract the scope segment (leading `@` included) from a canonical
 * `<@scope>/<name>` artifactId — the key for
 * {@link RegistryStorage.getScopeOwner}.
 */
export function artifactScope(artifactId: string): string {
  const slash = artifactId.indexOf('/');
  return slash === -1 ? artifactId : artifactId.slice(0, slash);
}
