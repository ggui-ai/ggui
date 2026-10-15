import { defineConfig } from 'tsup';

export default defineConfig({
  // The build script stages into `dist.staging-<pid>` and atomically swaps
  // it live (atomic-swap.mjs). The env var, not the CLI `--out-dir` flag,
  // is the override channel: the CLI flag does not reach tsup's dts writer.
  outDir: process.env.TSUP_OUT_DIR ?? 'dist',

  // The package ships compiled JavaScript, never its TypeScript source: a
  // React Native app bundles it with a stock Metro, and Metro does not map
  // the source's `./x.js` import specifiers to `./x.ts` files.
  entry: ['src/index.ts', 'src/chat-helpers/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  // Wipe dist on every build, so a retired entry's output never keeps shipping.
  clean: true,
  // Dependencies and peers (react, react-native, react-native-webview,
  // @ggui-ai/*) stay external: tsup leaves every name in package.json alone.
});
