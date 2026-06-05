/**
 * Vitest globalSetup — boots the two long-lived services every
 * scenario needs and tears them down at the end of the run.
 *
 *   - `@ggui-samples/ggui-default`  on :6781  — ggui MCP + renderer
 *   - `@ggui-samples/mcp-todo`      on :6782  — todo CRUD MCP
 *
 * The sample agent (`@ggui-samples/agent-claude-sdk`) is NOT booted
 * here — scenario 06 (sample-agent integration) starts it on demand
 * inside the test so the suite skips cleanly when ANTHROPIC_API_KEY
 * is missing without leaving a dangling process.
 *
 * If a service is already listening on its port (developer running
 * `pnpm dev` in another terminal), this helper REUSES it rather than
 * starting a duplicate — same pattern as Playwright's
 * `reuseExistingServer`. CI sets `CI=1` to force a clean boot.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

/**
 * Load `.env.local` into process.env BEFORE any services boot.
 * Vitest's built-in dotenv loader is opt-in via `test.env`/
 * `test.envPrefix` and doesn't pick up `.env.local` for arbitrary keys
 * (`ANTHROPIC_API_KEY` isn't `VITE_`-prefixed). Hand-rolling the parse
 * is one file + zero deps.
 *
 * `.env.local` lives at the OSS-subtree root — `oss/` in the monorepo,
 * the repo root in the OSS-standalone checkout — gitignored so each dev
 * keeps their own. `fixtures/` sits exactly three levels below that
 * root in both layouts. Kept in lockstep with the twin loader in
 * `../vitest.config.ts`.
 */
function loadDotenvLocal(): void {
  const path = resolve(import.meta.dirname, '..', '..', '..', '.env.local');
  const result = loadEnv({ path });
  if (!result.error) {
    // eslint-disable-next-line no-console
    console.log(`[e2e/scenarios] loaded ${path}`);
  }
}

interface ServiceSpec {
  readonly name: string;
  readonly pkg: string;
  readonly port: number;
  readonly healthPath: string;
  /**
   * Env overrides for the spawned child. Keys with `undefined` values
   * are DELETED from the inherited env. Used by the per-provider
   * ggui-default instances to clear other providers' API keys so the
   * ggui CLI's boot-time provider scan (anthropic → openai → google
   * → openrouter, first key wins) locks to the intended provider.
   */
  readonly envOverride?: Record<string, string | undefined>;
  /**
   * Skip this service entirely when the predicate returns true —
   * typically because its required env is missing. Used so the
   * openai/google ggui-default instances drop out cleanly when their
   * API key isn't set, without failing the suite.
   */
  readonly skipIf?: () => boolean;
}

/**
 * Build an env-override map that PINS the ggui CLI's boot-time provider
 * scan to exactly one provider — by passing that provider's key through
 * and explicitly clearing every other recognized provider key. The CLI's
 * `PROVIDER_PROBE_ORDER` is `anthropic → openai → google → openrouter`
 * and "first key wins", so clearing the higher-priority ones is the
 * only way to force a lower-priority pick.
 */
function providerOnlyEnv(
  keep:
    | 'ANTHROPIC_API_KEY'
    | 'OPENAI_API_KEY'
    | 'GEMINI_API_KEY'
    | 'OPENROUTER_API_KEY',
): Record<string, string | undefined> {
  const ALL = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY', // ADK fallback alias for GEMINI_API_KEY
    'OPENROUTER_API_KEY',
  ] as const;
  const out: Record<string, string | undefined> = {};
  for (const key of ALL) out[key] = undefined;
  out[keep] = process.env[keep];
  // GEMINI_API_KEY pinning also passes GOOGLE_API_KEY through so the
  // ADK's env-discovery (which accepts either) sees the same value.
  if (keep === 'GEMINI_API_KEY') {
    out.GOOGLE_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  }
  return out;
}

const SERVICES: readonly ServiceSpec[] = [
  {
    name: 'ggui-default',
    pkg: '@ggui-samples/ggui-default',
    port: Number.parseInt(process.env.GGUI_PORT ?? '6781', 10),
    healthPath: '/healthz',
  },
  {
    name: 'mcp-todo',
    pkg: '@ggui-samples/mcp-todo',
    port: Number.parseInt(process.env.TODO_PORT ?? '6782', 10),
    healthPath: '/admin/state',
  },
  // Slice 2.6 — `ggui-mapbox-demo` is the Slice 2 public-env channel
  // demonstrator. `ggui.json#app.publicEnv` carries the operator-
  // stamped Mapbox token (placeholder `<set-me-before-running>` value
  // for the committed sample; the render gate only checks key presence,
  // not value validity). Scenario 20 exercises the publicEnv render gate
  // + bootstrap projection against this server.
  {
    name: 'ggui-mapbox-demo',
    pkg: '@ggui-samples/ggui-mapbox-demo',
    port: Number.parseInt(process.env.GGUI_MAPBOX_PORT ?? '6784', 10),
    healthPath: '/healthz',
  },
  // Slice 2.6 — negative-path fixture. Mirrors `ggui-mapbox-demo`'s
  // `app.gadgets` (registers `useMapbox` with `requires:
  // ['GGUI_PUBLIC_APP_MAPBOX_TOKEN']`) but DELIBERATELY omits
  // `app.publicEnv` so the render gate's `assertPublicEnvSatisfied`
  // rejects with `gadget_public_env_missing`. Single
  // load-bearing assertion for scenario 20's negative path.
  {
    name: 'ggui-mapbox-missing-env-demo',
    pkg: '@ggui-samples/ggui-mapbox-missing-env-demo',
    port: Number.parseInt(
      process.env.GGUI_MAPBOX_MISSING_ENV_PORT ?? '6785',
      10,
    ),
    healthPath: '/healthz',
  },
  // GG.8 — `ggui-leaflet-demo` registers the `@ggui-samples/gadget-leaflet`
  // package on `app.gadgets` — a single COMPONENT export (`<LeafletMap>`,
  // the GG.8.7 hook→component migration). Scenario 25 exercises the
  // registry gate against a COMPONENT-gadget reference end-to-end.
  {
    name: 'ggui-leaflet-demo',
    pkg: '@ggui-samples/ggui-leaflet-demo',
    port: Number.parseInt(process.env.GGUI_LEAFLET_PORT ?? '6783', 10),
    healthPath: '/healthz',
  },
  // Fullscreen-mode sample — `ggui.json#app.defaultDisplayMode:
  // 'fullscreen'`. Every render stamps `_meta.ui.displayMode:
  // 'fullscreen'` so MCP-Apps-spec-compliant hosts arrange the
  // resulting iframes as a primary panel rather than stacking in
  // the chat log; the wire mechanism is identical to inline mode.
  {
    name: 'ggui-canvas-demo',
    pkg: '@ggui-samples/ggui-canvas-demo',
    port: Number.parseInt(process.env.GGUI_CANVAS_PORT ?? '6786', 10),
    healthPath: '/healthz',
  },
  // Provider-matrix ggui instances. Same `ggui-default` package as the
  // anthropic-keyed :6781 service above; each instance booted with a
  // single-provider env so the CLI's boot scan locks it to a specific
  // upstream LLM. Scenarios 03/09/11/12/15 fan out across these via the
  // provider matrix; scenario 6 natural-pairs each agent SDK with the
  // matching ggui port. Both instances skip cleanly when their key is
  // missing — no need to set every provider's key to run the suite.
  {
    name: 'ggui-default-openai',
    pkg: '@ggui-samples/ggui-default',
    port: Number.parseInt(process.env.GGUI_OPENAI_PORT ?? '6787', 10),
    healthPath: '/healthz',
    envOverride: providerOnlyEnv('OPENAI_API_KEY'),
    skipIf: () => !process.env.OPENAI_API_KEY,
  },
  {
    name: 'ggui-default-google',
    pkg: '@ggui-samples/ggui-default',
    port: Number.parseInt(process.env.GGUI_GOOGLE_PORT ?? '6788', 10),
    healthPath: '/healthz',
    envOverride: providerOnlyEnv('GEMINI_API_KEY'),
    skipIf: () => !process.env.GEMINI_API_KEY,
  },
];

const children: ChildProcess[] = [];

/**
 * Fixed cache directory pointed at via `GGUI_CODE_CACHE_DIR`. Set
 * before spawning ggui-default so the `FileSystemCodeStore` writes
 * here instead of the developer's `~/.ggui/code-cache`.
 *
 * Lifecycle — explicit wipe at BOTH boundaries:
 *
 *   - `beforeAll` (setup):  `rm -rf` defensively, then point env at
 *     the path. Defensive because a previous run that SIGKILLed or
 *     crashed could have left stale entries behind.
 *   - `afterAll` (teardown): `rm -rf` to leave the FS clean.
 *
 * Kept STABLE across runs (not mkdtempSync) so an operator
 * inspecting `/tmp` can always find the same path. The wipe-at-
 * beforeAll guarantees a fresh start every time.
 *
 * Cache persists for the LIFETIME OF ONE RUN — within-run cache
 * hits still work (e.g. scenario 08 renders twice; second hits
 * cache).
 */
const CACHE_DIR = join(tmpdir(), 'ggui-e2e-cache');
const PERSISTENT_DIR = join(tmpdir(), 'ggui-e2e-persistent');

/**
 * Per-service embedding-model cache root. Every ggui server lazily
 * warms the `bge-small-en-v1.5` embedding model via
 * `@huggingface/transformers` on boot. Pointed at ONE shared dir, the
 * N servers booted below issue N concurrent cold downloads of the same
 * `model_quantized.onnx`; the interleaved writes corrupt the file
 * ("Protobuf parsing failed"), which silently disables
 * `safelyRegisterBlueprint` and breaks every cache / warm-path
 * scenario.
 *
 * Fix: give each server its OWN subdirectory (`<MODELS_DIR>/<svc.name>`)
 * via `GGUI_EMBEDDING_CACHE_DIR` — separate files, zero download
 * contention. Stable path, NOT wiped between runs — model weights are
 * a static asset, not per-run test state (unlike CACHE_DIR /
 * PERSISTENT_DIR), so a local dev's second run reuses the download.
 */
const MODELS_DIR = join(tmpdir(), 'ggui-e2e-models');

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

/**
 * Port-listening + healthcheck. A bare port probe sometimes catches
 * the prior run's dying `pnpm start` wrapper before its child has
 * fully released the listen socket — `isPortListening` returns true
 * and `setup` skips boot, then all tests fail with ECONNREFUSED a few
 * seconds later. Healthcheck weeds out half-dead reuses.
 */
async function isReusable(port: number, healthPath: string): Promise<boolean> {
  if (!(await isPortListening(port))) return false;
  try {
    const resp = await fetch(`http://localhost:${port}${healthPath}`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export async function setup(): Promise<void> {
  loadDotenvLocal();

  // beforeAll cache clean — wipe defensively in case a previous
  // run crashed without afterAll firing, then point env at the
  // fixed path so the FileSystemCodeStore in ggui-default writes
  // here (operator-stable; same path every run).
  try {
    rmSync(CACHE_DIR, { recursive: true, force: true });
  } catch {
    // best-effort: missing dir is fine
  }
  process.env.GGUI_CODE_CACHE_DIR = CACHE_DIR;
  // eslint-disable-next-line no-console
  console.log(`[e2e/scenarios] code cache (clean): ${CACHE_DIR}`);

  // Per-run-clean persistent dir (SQLite GguiSessionStore + VectorStore).
  // Set BEFORE spawning ggui-default so the CLI's persistent-storage
  // defaults land here instead of `<sample>/.ggui/persistent` —
  // wiping that path between runs gives scenario 17's cold-handshake
  // assertion a clean cache to assert against.
  try {
    rmSync(PERSISTENT_DIR, { recursive: true, force: true });
  } catch {
    // best-effort: missing dir is fine
  }
  process.env.GGUI_PERSISTENT_DIR = PERSISTENT_DIR;
  // eslint-disable-next-line no-console
  console.log(`[e2e/scenarios] persistent dir (clean): ${PERSISTENT_DIR}`);

  for (const svc of SERVICES) {
    // Per-service skip gate — used by the per-provider ggui-default
    // instances so missing OPENAI_API_KEY / GEMINI_API_KEY simply
    // drops the corresponding instance out of the run.
    if (svc.skipIf?.()) {
      // eslint-disable-next-line no-console
      console.log(`[e2e/scenarios] skipping ${svc.name} (skipIf gate)`);
      continue;
    }
    const healthy = await isReusable(svc.port, svc.healthPath);
    if (healthy && !process.env.CI) {
      // Reuse the developer's running instance.
      // eslint-disable-next-line no-console
      console.log(`[e2e/scenarios] reusing ${svc.name} on :${svc.port}`);
      continue;
    }
    if (healthy && process.env.CI) {
      throw new Error(
        `[e2e/scenarios] CI=1 but port ${svc.port} (${svc.name}) is already in use`,
      );
    }
    // If a stale listener is in port (prior run's pnpm wrapper not
    // fully released, etc.), give it a moment to actually die before
    // spawning a fresh one — otherwise the new spawn will get EADDRINUSE.
    if (await isPortListening(svc.port)) {
      for (let i = 0; i < 20 && (await isPortListening(svc.port)); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[e2e/scenarios] starting ${svc.name} on :${svc.port}`);
    // Build the child env: start from process.env, layer the per-port
    // additions, then apply envOverride if present (keys with `undefined`
    // are DELETED — the provider-pinning primitive). The override layer
    // is what makes the openai/google ggui-default instances actually
    // boot under their target provider regardless of which other keys
    // the operator has exported.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(svc.port),
      // Own embedding-model cache dir per service — see MODELS_DIR.
      GGUI_EMBEDDING_CACHE_DIR: join(MODELS_DIR, svc.name),
    };
    if (svc.envOverride) {
      for (const [k, v] of Object.entries(svc.envOverride)) {
        if (v === undefined) delete childEnv[k];
        else childEnv[k] = v;
      }
    }
    const child = spawn('pnpm', ['--filter', svc.pkg, 'start'], {
      env: childEnv,
      stdio: 'pipe',
      // Own process group so teardown can SIGKILL the whole tree
      // (pnpm wrapper + ggui CLI + node).
      detached: true,
    });
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      // Pipe real errors so test failures are actionable.
      process.stderr.write(`[${svc.name}] ${chunk.toString()}`);
    });
    children.push(child);

    await waitForHealth(
      `http://localhost:${svc.port}${svc.healthPath}`,
      30_000,
    );
  }
}

export async function teardown(): Promise<void> {
  // Signal the whole process group (negative pid). The `pnpm start`
  // wrapper alone often eats SIGTERM without propagating to the
  // spawned `ggui serve` child; without group-kill, the prior run's
  // server lingers and the next run's reuse check finds a half-dead
  // listener (root cause of the 2026-05-13 alternating-pass flake).
  for (const child of children) {
    if (typeof child.pid === 'number' && !child.killed) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  // Force-kill any survivors.
  for (const child of children) {
    if (typeof child.pid === 'number' && !child.killed) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }
  // afterAll cache clean — leave the FS in the same state we
  // expected at beforeAll. Pairs with the defensive wipe in
  // setup() so the contract "cache is empty at both boundaries"
  // holds even if either side runs alone (e.g. operator manually
  // invokes teardown after a crash, or beforeAll skips because of
  // a missing dependency).
  try {
    rmSync(CACHE_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  try {
    rmSync(PERSISTENT_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
