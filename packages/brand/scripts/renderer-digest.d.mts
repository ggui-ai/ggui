/** The renderer's inputs, relative to the package root. */
export declare const RENDERER_INPUTS: readonly string[];
/** A sha256 over {@link RENDERER_INPUTS}, read from `packageDir`. */
export declare function computeRendererDigest(packageDir: string): string;
/** The committed module that carries the digest. */
export declare function renderDigestModule(digest: string): string;
