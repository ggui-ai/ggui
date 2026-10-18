/**
 * PlaywrightModule adapter (#973): `chromium.launch` with no Chromium sandbox
 * (containers without user namespaces). The runner image installs the headless
 * shell playwright-core's own version names, under PLAYWRIGHT_BROWSERS_PATH, so
 * no executablePath is needed there (#1853); PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
 * when set, still overrides it for a local run. Fails loudly when playwright-core or the binary
 * is missing — a silent fallback would turn every contractBehavior into
 * SKIP without anyone noticing. Shared by bench.mjs and eval-cell.mjs.
 */
export async function loadPlaywright() {
  const pw = await import('playwright-core');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  return {
    chromium: {
      launch: (options) =>
        pw.chromium.launch({
          ...options,
          ...(executablePath ? { executablePath } : {}),
          chromiumSandbox: false,
        }),
    },
  };
}
