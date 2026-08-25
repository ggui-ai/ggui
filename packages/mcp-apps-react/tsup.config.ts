import { defineConfig } from 'tsup';

export default defineConfig({
  // ggui#610: the build script stages into `dist.staging` and
  // atomically swaps it live (atomic-swap.mjs). The env var — not the
  // CLI `--out-dir` flag — is the override channel because the CLI
  // flag does not reach tsup's dts writer, which silently splits the
  // output across two directories.
  outDir: process.env.TSUP_OUT_DIR ?? 'dist',

  entry: [
    'src/index.ts',
    'src/chat-helpers/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  // Wipe dist on every build. tsup resolves array-form entries via
  // glob and silently SKIPS paths that no longer exist — without
  // clean, a retired entry's stale dist output would keep shipping
  // (the `./shells` zombie-export bug, audit F2).
  clean: true,
  // Bundle @ggui-ai/design/inline into the output so consumers
  // don't need to install it separately. The inline module contains
  // auto-generated string constants (~90KB) for iframe sandboxes.
  noExternal: ['@ggui-ai/design'],
});
