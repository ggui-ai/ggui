/**
 * Ambient module shim for the optional peer dependency
 * `@huggingface/transformers`. Declares only the structural surface
 * this package actually consumes — enough for `tsc --noEmit` to
 * resolve the dynamic import in `provider.ts` without forcing the
 * ~60MB ort-node runtime into the dev install matrix.
 *
 * The real types (when the peer dep IS installed) are broader; this
 * shim intentionally under-describes so consumers of
 * `@ggui-ai/embedding-local` that build with the real dep installed
 * still see the full upstream type surface if they import directly.
 */
declare module '@huggingface/transformers' {
  export interface Env {
    cacheDir?: string;
    localModelPath?: string;
    allowRemoteModels?: boolean;
  }

  export const env: Env;

  export interface PipelineOutput {
    readonly data: Float32Array | number[];
  }

  export type FeatureExtractionPipeline = (
    text: string | readonly string[],
    options?: {
      readonly pooling?: 'mean' | 'cls' | 'none';
      readonly normalize?: boolean;
    },
  ) => Promise<PipelineOutput>;

  export function pipeline(
    task: string,
    model?: string,
    opts?: Record<string, unknown>,
  ): Promise<FeatureExtractionPipeline>;
}
