# @ggui-ai/gadget-signing

> Gadget bundle signing + verification for the ggui gadget marketplace.

Signs and verifies the `bundle.js` files that authors publish to a ggui
gadget registry. The Ed25519 path is pure-TS via `@noble/ed25519` +
`@noble/hashes` — no `node:crypto` dependency, so that path is safe to
import from browser contexts (e.g. client-side signature verification in
the iframe runtime).

## Two signing paths

| Path                          | Audience        | Trust root                                                |
| ----------------------------- | --------------- | --------------------------------------------------------- |
| **Ed25519 author key**        | private gadgets | Author's local private key; public key stored by registry |
| **sigstore (cosign + Rekor)** | public gadgets  | Keyless Fulcio cert via OIDC + Rekor transparency log     |

The sigstore path is a full implementation built on the upstream
`sigstore` package. The publisher acquires an OIDC token out-of-band and
passes it in; signing walks the keyless Fulcio + Rekor flow, and
verification resolves trust material via TUF and enforces an optional
caller-supplied identity policy.

## Wire format

```ts
type GadgetSignature = Ed25519Signature | SigstoreSignature;

interface Ed25519Signature {
  readonly algorithm: "ed25519";
  readonly bundleSha384: string; // base64(sha384(bundleBytes))
  readonly signature: string; // base64(ed25519.sign(digest, privateKey))
  readonly publicKeyId: string; // stable id derived from the public key
  readonly signedAt: string; // ISO 8601
}
```

SHA-384 (not 512) matches the SRI hash the iframe runtime enforces on
`<script>` tags, so the signature attests to the exact digest the browser
recomputes at load time.

## Usage

### Ed25519 author-key path

```ts
import {
  generateEd25519Keypair,
  signBundleEd25519,
  verifyBundleEd25519,
} from "@ggui-ai/gadget-signing";

// Author (keygen)
const { publicKey, privateKey, publicKeyId } = await generateEd25519Keypair();
// publicKey + publicKeyId go to the registry; privateKey stays local.

// Publisher
const signature = await signBundleEd25519({
  bundleBytes,
  privateKey,
  publicKeyId,
});

// Install / runtime
const result = await verifyBundleEd25519({ bundleBytes, signature, publicKey });
if (!result.valid) throw new Error(`signature invalid: ${result.reason}`);
```

### Sigstore keyless path

```ts
import { signBundleSigstore, verifyBundleSigstore } from "@ggui-ai/gadget-signing";

// Publisher — identityToken is a pre-acquired OIDC JWT.
const signature = await signBundleSigstore({ bundleBytes, identityToken });

// Install — optionally pin the expected signer identity.
const result = await verifyBundleSigstore({
  bundleBytes,
  signature,
  expectedIdentity: { subject: /^https:\/\/github\.com\/my-org\// },
});
```

The sigstore code path uses `node:crypto` transitively and is therefore
Node-only. The Ed25519 path stays browser-safe.
