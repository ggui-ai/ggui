/**
 * Canonical user-id namespace for an externally-issued identity:
 * `'<providerId>:<providerSubject>'`. One definition shared by the
 * OAuth-login routes and the OIDC verify adapter so every consumer
 * computes the same id. Collision-safe vs raw provider subjects that
 * carry no `:` prefix.
 */
export function composeOAuthUserId(input: {
  readonly providerId: string;
  readonly providerSubject: string;
}): string {
  return `${input.providerId}:${input.providerSubject}`;
}
