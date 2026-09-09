/**
 * PlaywrightModule adapter (#973): `chromium.launch` with the image's binary
 * (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) and no Chromium sandbox (containers
 * without user namespaces). Fails loudly when playwright-core or the binary
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
