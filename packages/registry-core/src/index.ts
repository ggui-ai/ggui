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
} from './interfaces/registry-storage.js';

// Types — rows + wire shapes
export {
  ARTIFACTS_METADATA_SK,
  type ArtifactKind,
  type ArtifactScanFilter,
  type ArtifactVersionRow,
  type ArtifactsMetadataRow,
  type AuthorKeyRow,
  type CompiledBlobRow,
  type ErrorBody,
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
  SEARCH_ERROR_CODES,
  SEARCH_SORT_OPTIONS,
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
  BLUEPRINT_EXTERNAL_MODULES,
  compileBlueprint,
  compiledDigestHex,
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
  type PublishArtifactDeps,
  type PublishArtifactInput,
  type PublishArtifactResult,
} from './ops/publish.js';
export {
  readArtifact,
  type ReadArtifactDeps,
  type ReadArtifactInput,
  type ReadArtifactResult,
} from './ops/read.js';
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

// In-memory impls
export { inMemoryRegistryStorage } from './impls/memory-registry-storage.js';
export {
  inMemoryBundleStorage,
  type InMemoryBundleStorageOptions,
} from './impls/memory-bundle-storage.js';

// Utils
export { compareSemver } from './utils/semver.js';
export { base64Encode, safeBase64Decode, sha384Base64 } from './utils/base64.js';

// Re-export the signing types so consumers don't have to import a
// second package for the publish wire's `signature` field —
// `GadgetSignature` is the `Ed25519Signature | SigstoreSignature` union.
export type { Ed25519Signature, GadgetSignature } from '@ggui-ai/gadget-signing';
