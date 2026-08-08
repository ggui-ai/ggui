/**
 * Sub-tier B — the `with-guuey` lane: the platform-composed (guuey-sdk)
 * golden path, end-to-end against the app COMPOSED from
 * `oss/samples/agents/with-guuey` + `oss/samples/apps/with-guuey-web`
 * (compose-app.mjs → per-dir npm installs → the 3-process boot in
 * compose-and-boot.sh: `ggui serve --mcp-only --dev-allow-all` :6781 →
 * `guuey dev --serve` :6790 → vite :6890, with the colocated todo MCP on
 * :6740 spawned by the guuey CLI itself). `--dev-allow-all` is what admits
 * the page's anonymous guest relay + locator resources/read (same note as
 * cache-hit.spec / seed-pool-reuse.spec).
 *
 * A SEPARATE spec from render.spec.ts on purpose: the web half is a
 * different app (`@guuey/agent-client`'s `useAgentInvoke` +
 * `@guuey/mcp-apps-host`'s view-mount dispatcher instead of
 * ggui-basic-web's hand-rolled Chat.tsx), and the journey asserts guuey's
 * published dev-router wire contract — `POST /agent/invoke` SSE + `GET
 * /healthz` + `GET /threads/:id/messages` (in-memory TEXT rows only — no
 * card/artifact rows), sessionId-keyed in-memory sessions, no manifest
 * (`@guuey/cli` 0.3.0 recon; 0.2.0 had no `/threads` route at all). The
 * framework-native lanes in render.spec.ts are untouched — they remain
 * the wire-scenarios substrate.
 *
 * Journey (adapted to the dev server's real contract):
 *
 *   render      — prompt through the page; the agent (guuey.worker.js →
 *                 Claude Agent SDK) adds todos via the colocated todo MCP
 *                 and renders through the CLI-injected ggui runtime MCP;
 *                 the card mounts through the MCP-Apps double iframe
 *                 (second-origin sandbox proxy :7890 → ggui shell).
 *   toggle      — click "buy milk" in the card. The action rides the
 *                 card's ggui live channel (WS to :6781) into the
 *                 runtime's pending queue. Nothing drains it yet: unlike
 *                 the framework lanes' agent-server (whose connector event
 *                 loop drains actions in code), guuey's dev router has no
 *                 ggui consumer — the drain happens on the NEXT
 *                 `/agent/invoke` turn.
 *   same-session sync — the second prompt drives the drain IN THE SAME
 *                 dev-router session (see the SAME-SESSION note below):
 *                 the agent consumes the pending toggle (ggui_consume),
 *                 applies it via the todo MCP (todo_toggle), and
 *                 ggui_update-s the EXISTING render — the still-mounted
 *                 card flips to checked over the live channel, with no
 *                 page-side invoke in flight.
 *   rehydrate   — reload the page. The transcript starts empty (the
 *                 dev-router/hook threadId dialect gap — see the RELOAD
 *                 LEG note at the bottom), but the CARD comes back: the
 *                 host persisted the render's durable `ui://` locator and
 *                 re-fetches fresh mount material via `resources/read` on
 *                 its ggui relay (`@guuey/mcp-apps-host`'s reader). Fresh
 *                 material, provably: the remounted card shows "buy milk"
 *                 CHECKED — the turn-1 bootstrap predates the toggle, so
 *                 a stale replay would render it unchecked.
 *
 * Assertions: same `sessionId` rides the second response's SSE `session`
 * frame; the toggle round-trips to the todo store (authoritative
 * `/admin/state` read); the first render's state persists in-page; the
 * reloaded page remounts the card live via the locator reader.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { spawnComposedApp, type ComposedAppHandle } from './composed-app-harness';
import { findTodoToggleable, waitForTodoCheckedIndicator } from './todo-locators';

// The proven agent-loop prompt (mirrors render.spec.ts) — the trailing
// "keep in sync" sentence primes the agent for the toggle round-trip.
const JOURNEY_PROMPT =
  'Please use the todo MCP server to add these items to my todo list: ' +
  'buy milk, walk the dog, write code. Then show me my todo list as an ' +
  'interactive UI where I can click an item to mark it done. When I toggle ' +
  'an item, update it in the todo MCP so my list stays in sync.';

// Turn 2 — drives the drain. Steers the agent to update the EXISTING render:
// this turn's tool results never reach the page (the page's hook is not in
// this invoke), so only an in-place ggui_update on the live channel can move
// the mounted card. A fresh ggui_render would be invisible to the page.
const SYNC_PROMPT =
  'I just toggled a todo item in the rendered UI. Consume my pending UI ' +
  'actions from the ggui server, apply the toggle to the todo list via the ' +
  'todo MCP server, and update the existing rendered UI in place so it ' +
  'shows the new checked state. Do not create a new UI render.';

const EXPECTED_TODOS = ['buy milk', 'walk', 'write code'];

// The colocated todo MCP (guuey.json `devPort: 6740`, spawned by `guuey
// dev`). Its `GET /admin/state` debug route exists exactly for harness
// assertions that want backing state without an MCP round trip — the
// authoritative "the toggle really round-tripped" read.
const TODO_ADMIN_STATE_URL = 'http://localhost:6740/admin/state';

/** `@ggui-samples/mcp-todo`'s `/admin/state` response shape (store.ts `Todo`). */
interface TodoAdminState {
  readonly todos: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly done: boolean;
  }>;
}

/** The dev router's SSE `session` frame (`@guuey/cli` 0.3.0 `handleInvoke` —
 *  re-verified against the published 0.3.0 dist: shape unchanged from 0.2.0,
 *  `{sessionId, userId, authMode}` with no `threadId`). */
interface DevSessionFrame {
  readonly sessionId: string;
  readonly userId: string;
  readonly authMode: string;
}

/**
 * Session ids the dev router has materialized on disk. `handleInvoke` calls
 * `sessionFs(projectRoot, sessionId)` at TURN START, which mkdirs
 * `<appRoot>/.guuey-dev/sessions/<sessionId>/` — ground truth for "which
 * sessions exist" that doesn't depend on buffering the page's SSE stream.
 */
function sessionIdsOnDisk(appDir: string): string[] {
  const dir = join(appDir, '.guuey-dev', 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

async function readTodoAdminState(): Promise<TodoAdminState> {
  const res = await fetch(TODO_ADMIN_STATE_URL);
  if (!res.ok) throw new Error(`todo /admin/state responded ${res.status}`);
  return (await res.json()) as TodoAdminState;
}

/** Poll `/admin/state` until the named todo reads `done === true`. */
async function waitForTodoDoneInStore(name: RegExp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no matching todo seen yet';
  while (Date.now() < deadline) {
    const state = await readTodoAdminState();
    const todo = state.todos.find((t) => name.test(t.text));
    if (todo?.done === true) return;
    last = JSON.stringify(state.todos);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `todo matching ${name.source} never read done:true in the todo store within ${timeoutMs}ms — last state: ${last}`,
  );
}

test.describe('samples-render: with-guuey full journey against the composed published app', () => {
  let app: ComposedAppHandle | undefined;

  test.beforeAll(() => {
    // This lane needs ONLY the Anthropic key: the agent half is a Claude
    // Agent SDK worker and ggui's UI generation is Claude-driven — same env
    // gate idiom as render.spec.ts, one key instead of two.
    test.skip(
      !process.env['ANTHROPIC_API_KEY']?.trim(),
      'ANTHROPIC_API_KEY required (ggui UI generation + the claude worker)',
    );
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('with-guuey: render → toggle → same-session sync (drain + live update)', async ({
    page,
    request,
  }) => {
    // First test bears the one-time build+publish (ensureSetup) plus
    // compose+install+boot+LLM — same nightly-capstone budget as render.spec.
    test.setTimeout(1_500_000);
    app = await spawnComposedApp({ sdk: 'with-guuey' });

    // Failure diagnostics: the captured boot output carries all three
    // servers' logs (ggui serve cache traces, guuey dev worker stderr, vite)
    // — without the dump a CI red is undiagnosable (ggui#367 lesson).
    const dumpBootTail = (label: string): void => {
      // eslint-disable-next-line no-console -- failure diagnostics for the run log.
      console.log(
        `[with-guuey:${label}] app boot output (tail):\n${app?.stdout().slice(-8000) ?? '(no app handle)'}`,
      );
    };

    // ── STEP 1 — render ──────────────────────────────────────────────────
    // No `?agent=` param: the with-guuey web half defaults its endpoint to
    // guuey dev's published port (http://localhost:6790) — the ?agent=
    // override is a framework-shell (ggui-basic-web) contract.
    await page.goto(app.webUrl);
    try {
      await expect(page.getByRole('textbox')).toBeVisible({ timeout: 90_000 });
    } catch (err) {
      dumpBootTail('shell-never-mounted');
      throw err;
    }
    await page.getByRole('textbox').fill(JOURNEY_PROMPT);
    await page.getByRole('button', { name: /send/i }).click();

    // Double-iframe drill (outer sandbox-proxy page → inner ggui shell) —
    // same MCP-Apps topology as the framework lanes, mounted here by
    // `@guuey/agent-client`'s card dispatcher + <AppRenderer>.
    const initialFrame = page.frameLocator('iframe').first().frameLocator('iframe').first();
    try {
      for (const todo of EXPECTED_TODOS) {
        await expect(initialFrame.getByText(new RegExp(todo, 'i')).first()).toBeVisible({
          timeout: 240_000,
        });
      }
    } catch (err) {
      dumpBootTail('render-never-appeared');
      throw err;
    }

    // Turn 1 must END before the same-session leg: the dev router appends
    // history at turn end, and firing turn 2 mid-turn would interleave two
    // drivers on one session. `status` is the hook's real per-turn union —
    // 'ready' is the settled state.
    await expect(page.locator('.status')).toHaveAttribute('data-status', 'ready', {
      timeout: 300_000,
    });

    // The dev router materialized exactly ONE session for the page's turn —
    // its id is the page's session, read off disk (ground truth; the page
    // cannot surface it: see the SAME-SESSION note below).
    const idsAfterTurn1 = sessionIdsOnDisk(app.appDir);
    expect(idsAfterTurn1).toHaveLength(1);
    const sessionId = idsAfterTurn1[0];

    // Evidence integrity for the round-trip: "buy milk" exists in the todo
    // store and is NOT done before the toggle — so done:true later can only
    // be the drained action, never a turn-1 artifact.
    const before = await readTodoAdminState();
    const milkBefore = before.todos.find((t) => /buy milk/i.test(t.text));
    expect(milkBefore).toBeDefined();
    expect(milkBefore?.done).toBe(false);

    // ── STEP 2 — toggle (queues the action; nothing drains yet) ──────────
    await findTodoToggleable(initialFrame, /buy milk/i).click({ timeout: 30_000 });
    // The action dispatches as a guest `tools/call` through the HOST's
    // relay to ggui serve (App.tsx `relayCallTool` — the live-channel WS
    // carries server→card updates, never card→server actions) into the
    // runtime's pending queue; there is no page-observable ack. Give the
    // cross-process dispatch a beat before draining; a too-early drain
    // finds an empty queue (retries: 1 absorbs a genuine race).
    await page.waitForTimeout(2_000);

    // ── STEP 3 — same-session sync over the wire ─────────────────────────
    // SAME-SESSION, ON THE WIRE — why this prompt bypasses the page: the
    // dev router keys its in-memory sessions on `body.sessionId` and echoes
    // it on every response's `session` frame ({sessionId, userId,
    // authMode:"anonymous"}). The published `@guuey/agent-client` hook
    // speaks the hosted pod's `threadId` dialect (sends body.threadId,
    // reads session.threadId) — the dev router ignores the one and omits
    // the other, so a page-driven second prompt would mint a FRESH session
    // (randomUUID) instead of continuing this one. (Re-verified against
    // `@guuey/cli` 0.3.0 + `@guuey/agent-client` 0.3.0: dialects unchanged
    // on both sides.) The test is therefore the session-aware client: it
    // replays the dev router's own contract (`body.sessionId`) and asserts
    // the SAME sessionId rides the second response's SSE `session` frame —
    // in-session continuity at the wire level (the worker's history fold
    // sees turn 1) — while the page proves the in-page halves below.
    const resp = await request.post(`${app.agentUrl}/agent/invoke`, {
      data: { input: SYNC_PROMPT, sessionId },
      timeout: 300_000,
    });
    expect(resp.status()).toBe(200);
    const sse = await resp.text();
    const sessionFrameMatch = /event: session\ndata: (.+)/.exec(sse);
    expect(sessionFrameMatch).not.toBeNull();
    const sessionFrame = JSON.parse(sessionFrameMatch![1]) as DevSessionFrame;
    expect(sessionFrame.sessionId).toBe(sessionId);
    expect(sessionFrame.authMode).toBe('anonymous');
    // Clean completion: the router only sends `done` when the worker turn
    // finished (an error turn sends an `error` frame and no `done`).
    expect(sse).toContain('event: done');
    expect(sse).not.toContain('WORKER_ERROR');
    // No second session materialized — the router continued OURS.
    expect(sessionIdsOnDisk(app.appDir)).toEqual([sessionId]);

    // ── STEP 4 — the toggle round-tripped and the first render persists ──
    // Authoritative: the drained action reached the todo STORE.
    try {
      await waitForTodoDoneInStore(/buy milk/i, 30_000);
    } catch (err) {
      // The turn claimed clean completion (done, no WORKER_ERROR) yet the
      // store never flipped — the two branches (drain found an empty
      // queue vs. drained-but-fumbled tool sequence) are distinguishable
      // only from the agent's own turn transcript + the servers' logs.
      // eslint-disable-next-line no-console -- failure diagnostics for the run log.
      console.log(`[with-guuey:toggle-never-round-tripped] sync turn SSE (tail):\n${sse.slice(-6000)}`);
      dumpBootTail('toggle-never-round-tripped');
      throw err;
    }
    // In-page: the still-mounted card received the turn's ggui_update over
    // the live channel — checked state appears with NO page-side invoke in
    // flight. `.last()` mirrors render.spec's remount-tolerant read (this
    // page has a single card slot, so last === first unless it re-keyed).
    const afterSyncFrame = page.frameLocator('iframe').last().frameLocator('iframe').first();
    try {
      await waitForTodoCheckedIndicator(afterSyncFrame, /buy milk/i, 180_000);
    } catch (err) {
      dumpBootTail('checked-never-appeared');
      throw err;
    }
    // The first render's state persists in-page: all three todos still on
    // the card, and the transcript still carries the turn-1 exchange (the
    // wire-driven turn never touched the page's React tree).
    for (const todo of EXPECTED_TODOS) {
      await expect(afterSyncFrame.getByText(new RegExp(todo, 'i')).first()).toBeVisible({
        timeout: 30_000,
      });
    }
    await expect(page.getByTestId('transcript')).toContainText(/buy milk/i);

    // ── STEP 5 — reload: locator rehydration through the host's reader ──
    // FULL PAGE-RELOAD leg, not a re-fold: the card's durable identity is
    // its persisted `ui://` locator (the host keeps it in localStorage —
    // App.tsx `CardMemento`), and the reloaded page resolves it with
    // `@guuey/mcp-apps-host`'s reader over the ggui relay — ONE fresh
    // `resources/read`, which ggui serve answers with a newly minted shell
    // for the render's CURRENT state (fresh live-channel credentials).
    //
    // What stays honestly absent: the TEXT transcript. The 0.3.0 courtesy
    // history endpoint (`GET /threads/:id/messages`) landed, but its rows
    // are text-only AND the dev router's session frame still carries no
    // `threadId` for the hook to bind — so the transcript starts empty and
    // the card alone rehydrates. Do NOT "fix" that gap here with a
    // hand-rolled threadId shim.
    await page.reload();
    try {
      await expect(page.getByRole('textbox')).toBeVisible({ timeout: 60_000 });
    } catch (err) {
      dumpBootTail('shell-never-remounted-after-reload');
      throw err;
    }
    // The rehydrated card: reader fetch + shell boot only (no generation,
    // no LLM turn) — the todos should reappear well inside 120s.
    const rehydratedFrame = page
      .frameLocator('iframe')
      .last()
      .frameLocator('iframe')
      .first();
    try {
      for (const todo of EXPECTED_TODOS) {
        await expect(rehydratedFrame.getByText(new RegExp(todo, 'i')).first()).toBeVisible({
          timeout: 120_000,
        });
      }
    } catch (err) {
      dumpBootTail('rehydrated-card-never-appeared');
      throw err;
    }
    // The card came back LIVE via the reader's fresh read: "buy milk"
    // mounts CHECKED with no invoke in flight. The turn-1 bootstrap
    // predates the toggle (milk was asserted done:false back then) AND its
    // live-channel wsToken is long expired — a stale replay could neither
    // carry the checked state nor resync to it over the WS. Checked here
    // therefore proves a live remount from the render's current
    // server-side state, which only the fresh resources/read can mint.
    try {
      await waitForTodoCheckedIndicator(rehydratedFrame, /buy milk/i, 60_000);
    } catch (err) {
      dumpBootTail('rehydrated-card-stale');
      throw err;
    }
    // And the transcript really did start over — the reload leg proves
    // card rehydration, not a hidden history replay. Point-in-time check
    // by design: a negated toContainText samples the transcript as it is
    // NOW and could not catch a hypothetically late-arriving replay — an
    // honest bound, and sufficient here because the sample wires no
    // history adapter at all (nothing exists to replay later).
    await expect(page.getByTestId('transcript')).not.toContainText(/buy milk/i);
  });
});
