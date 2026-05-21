import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/codegen.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  external: ['react', '@ggui-ai/protocol'],
});
