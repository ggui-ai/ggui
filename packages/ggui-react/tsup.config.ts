import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/chat-helpers/index.ts',
    'src/chat-thread/index.ts',
    'src/chat-thread/shells/chat/index.ts',
    'src/chat-thread/shells/agent/index.ts',
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
