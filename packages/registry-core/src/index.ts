/**
 * `@ggui-ai/registry-core` — pure-TS registry operations + storage
 * interfaces for the ggui marketplace.
 *
 * The hosted ggui registry and the OSS `@ggui-ai/registry-server` both
 * import from here. The transport layer (a managed API gateway, hono)
 * handles the HTTP envelope + auth verification; registry-core handles
 * row-shape + business logic.
 */

// Interfaces
export type { AuthnContext } from './interfaces/authn.js';
export type { BundleStorage } from './interfaces/bundle-storage.js';
export {
  AuthorKeyAlreadyExistsError,
  type PutAuthorKeyOptions,
  type RegistryStorage,
  type ScopeOwnerExpectation,
} from './interfaces/registry-storage.js';

// Types — rows + wire shapes
export {
  ARTIFACTS_METADATA_SK,
  type ArtifactKind,
  type ArtifactScanFilter,
  type ArtifactVersionRow,
  type ArtifactsMetadataRow,
  type AuthorKeyListEntry,
  type AuthorKeyRow,
  type CompiledBlobRow,
  DELETE_AUTHOR_KEY_ERROR_CODES,
  type DeleteAuthorKeyErrorBody,
  type DeleteAuthorKeyErrorCode,
  type DeleteAuthorKeyResponseBody,
  type ErrorBody,
  LIST_AUTHOR_KEYS_ERROR_CODES,
  type ListAuthorKeysErrorBody,
  type ListAuthorKeysErrorCode,
  type ListAuthorKeysResponseBody,
  LIST_VERSIONS_ERROR_CODES,
  type ListVersionsErrorBody,
  type ListVersionsErrorCode,
  type ListVersionsResponse,
  PUBLISH_ERROR_CODES,
  type PublishErrorBody,
  type PublishErrorCode,
  type PublishRequestBody,
  type PublishResponseBody,
  READ_ERROR_CODES,
  type ReadErrorBody,
  type ReadErrorCode,
  type ReadPkgResponse,
  REGISTER_AUTHOR_KEY_ERROR_CODES,
  type RegisterAuthorKeyErrorBody,
  type RegisterAuthorKeyErrorCode,
  type RegisterAuthorKeyRequestBody,
  type RegisterAuthorKeyResponseBody,
  SAN_ALLOWLIST_INVALID,
  type SanAllowlistInvalid,
  SCOPE_VERIFICATIONS,
  type ScopeOwnerRow,
  type ScopeVerification,
  SEARCH_ERROR_CODES,
  SEARCH_SORT_OPTIONS,
  unauthorizedErrorBody,
  type SearchErrorBody,
  type SearchErrorCode,
  type SearchResponse,
  type SearchResultEntry,
  type SearchSort,
  type VersionListEntry,
  type Visibility,
} from './types.js';

// Operations
export {
  compileBlueprint,
  type CompileBlueprintErr,
  type CompileBlueprintOk,
  type CompileBlueprintResult,
} from './ops/compile.js';
export {
  checkConformance,
  MAX_BLUEPRINT_SOURCE_BYTES,
  type BlueprintProbeRunner,
  type ConformanceError,
  type ConformanceErrorCode,
  type ConformanceFailureCode,
  type ConformanceRequestPayload,
  type ConformanceResponseBody,
} from './ops/conformance.js';
export {
  publishArtifact,
  MAX_BUNDLE_BYTES,
  RESERVED_SCOPES,
  type PublishArtifactDeps,
  type PublishArtifactInput,
  type PublishArtifactResult,
  type VerifiedEmailResolver,
} from './ops/publish.js';
export {
  readArtifact,
  type ReadArtifactDeps,
  type ReadArtifactInput,
  type ReadArtifactResult,
} from './ops/read.js';
export {
  artifactScope,
  canReadPrivateArtifact,
  createScopeOwnerResolver,
} from './ops/private-read-authz.js';
export {
  listArtifactVersions,
  type ListArtifactVersionsDeps,
  type ListArtifactVersionsInput,
  type ListArtifactVersionsResult,
} from './ops/list-versions.js';
export {
  searchArtifacts,
  type SearchArtifactsDeps,
  type SearchArtifactsInput,
  type SearchArtifactsResult,
} from './ops/search.js';
export {
  registerAuthorKey,
  type RegisterAuthorKeyDeps,
  type RegisterAuthorKeyInput,
  type RegisterAuthorKeyResult,
} from './ops/register-author-key.js';
export {
  listAuthorKeys,
  type ListAuthorKeysDeps,
  type ListAuthorKeysResult,
} from './ops/list-author-keys.js';
export {
  deleteAuthorKey,
  type DeleteAuthorKeyDeps,
  type DeleteAuthorKeyInput,
  type DeleteAuthorKeyResult,
} from './ops/delete-author-key.js';

// In-memory impls
export { inMemoryRegistryStorage } from './impls/memory-registry-storage.js';
export {
  inMemoryBundleStorage,
  type InMemoryBundleStorageOptions,
} from './impls/memory-bundle-storage.js';

// Utils
export {
  installCommand,
  type InstallCommandOptions,
} from './install-command.js';
export { compareSemver } from './utils/semver.js';
export { base64Encode, safeBase64Decode, sha384Base64 } from './utils/base64.js';

// Re-export the signing types so consumers don't have to import a
// second package for the publish wire's `signature` field —
// `GadgetSignature` is the `Ed25519Signature | SigstoreSignature` union.
export type { Ed25519Signature, GadgetSignature } from '@ggui-ai/gadget-signing';
