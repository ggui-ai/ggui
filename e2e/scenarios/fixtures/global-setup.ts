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
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/**
 * Load `.env.local` from the workspace root into process.env BEFORE
 * any services boot. Vitest's built-in dotenv loader is opt-in via
 * `test.env`/`test.envPrefix` and doesn't pick up `.env.local` for
 * arbitrary keys (`ANTHROPIC_API_KEY` isn't `VITE_`-prefixed). Hand-
 * rolling the parse is one file + zero deps.
 *
 * Lookup tries the monorepo root first (oss/e2e/scenarios/fixtures →
 * 4 parents up = /workspaces/ggui-workspace), then the oss/ subtree
 * root (3 up) — the latter is the repo root in the OSS-standalone
 * checkout.
 */
function loadDotenvLocal(): void {
  const candidates = [
    resolve(import.meta.dirname, '..', '..', '..', '..', '.env.local'),
    resolve(import.meta.dirname, '..', '..', '..', '.env.local'),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes if present.
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key.length > 0 && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[e2e/scenarios] loaded ${path}`);
      return;
    } catch {
      /* try next */
    }
  }
}

interface ServiceSpec {
  readonly name: string;
  readonly pkg: string;
  readonly port: number;
  readonly healthPath: string;
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
  // for the committed sample; the push gate only checks key presence,
  // not value validity). Scenario 20 exercises the publicEnv push gate
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
  // `app.publicEnv` so the push gate's `assertPublicEnvSatisfied`
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
  // Canvas slice — `ggui.json#app.defaultMcpAppsMode: 'canvas'`. Used
  // by scenarios 23 + 24 to verify `ggui_new_session` mints a
  // session-scoped iframe resourceUri and subsequent `ggui_push` calls
  // route through the session channel (no per-push `ui://` minting).
  {
    name: 'ggui-canvas-demo',
    pkg: '@ggui-samples/ggui-canvas-demo',
    port: Number.parseInt(process.env.GGUI_CANVAS_PORT ?? '6786', 10),
    healthPath: '/healthz',
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
 * hits still work (e.g. scenario 08 pushes twice; second hits
 * cache).
 */
const CACHE_DIR = join(tmpdir(), 'ggui-e2e-cache');
const PERSISTENT_DIR = join(tmpdir(), 'ggui-e2e-persistent');

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

  // Per-run-clean persistent dir (SQLite SessionStore + VectorStore).
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
    const child = spawn('pnpm', ['--filter', svc.pkg, 'start'], {
      env: { ...process.env, PORT: String(svc.port) },
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
