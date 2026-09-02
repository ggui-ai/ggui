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
  // Bundle @ggui-ai/design into the host-helper output so consumers
  // install ONE package for the chat surface — the design system is an
  // implementation detail of these components, not a peer contract.
  // (Formerly justified by the retired `./inline` subpath; see #717.)
  noExternal: ['@ggui-ai/design'],
});
