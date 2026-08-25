import { defineConfig } from 'tsup';

export default defineConfig({
  // ggui#610: the build script stages into `dist.staging` and
  // atomically swaps it live (atomic-swap.mjs). The env var — not the
  // CLI `--out-dir` flag — is the override channel because the CLI
  // flag does not reach tsup's dts writer, which silently splits the
  // output across two directories.
  outDir: process.env.TSUP_OUT_DIR ?? 'dist',

  entry: ['src/index.ts', 'src/codegen.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  external: ['react', '@ggui-ai/protocol'],
});
