import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Renderer is iframe-resident — every spec exercises browser
    // globals (`WebSocket`, `window.parent.postMessage`, DOM). jsdom
    // is the standard. Specs that DON'T need the DOM still run cleanly
    // here; keeping a single environment avoids per-file banners.
    environment: 'jsdom',
    globals: true,
    // C7b renderer specs render with React 19's concurrent scheduler and
    // use `act(...)` to flush initial render + effects. React 19
    // requires `globalThis.IS_REACT_ACT_ENVIRONMENT = true` to recognize
    // the test environment; vitest's `setupFiles` installs it once.
    setupFiles: ['./src/__tests__/setup.ts'],
    env: {
      // Suppress the module-load-time autostart in `runtime.ts` so
      // tests can import the module (to exercise `bootSequence()`
      // directly) without an untracked async boot firing in the
      // background. The real iframe bundle runs `shouldAutostart()
      // === true`; tests opt out by setting this env var.
      GGUI_RENDERER_AUTOSTART: 'false',
    },
  },
});
