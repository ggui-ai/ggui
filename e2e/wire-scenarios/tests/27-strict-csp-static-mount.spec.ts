/**
 * Scenario 27 — strict-CSP host mount rides the asset path (ggui#522
 * slice 3's regression net).
 *
 * What this proves: a host page whose CSP grants NO scheme sources —
 * no `blob:`, no `data:`, no `'unsafe-eval'`; only `'self'` + the ggui
 * server's origin — still mounts and paints a generated view, because
 * every executable the frame needs is a fetchable asset:
 *
 *   - the runtime bundle (`/_ggui/iframe-runtime.<hash>.js`),
 *   - the component module VARIANT (`/code/<hash>.m<rt>.js` — stored
 *     bytes server-side import-rewritten so bare specifiers resolve to
 *     static shim assets),
 *   - the shim assets themselves (`/_ggui/shims/<rt>/<name>.js`),
 *   - the executable validator bundle (`/contract/<hash>.js`).
 *
 * The assertion set is deliberately sharper than "it painted": with
 * `'unsafe-inline'` present (the shell's bootstrap script needs it,
 * exactly like the ggui.ai landing under Next), a paint alone could be
 * the inline-exec fallback masking a dead asset path. So the scenario
 * ALSO pins that the browser fetched the module variant + a shim
 * (200s), and that zero securitypolicyviolation events fired — the
 * ladder never touched a scheme source.
 *
 * Zero-LLM: primes the blueprint through `/control`
 * `ggui_ops_register_blueprint` with pre-built componentCode (the
 * scenario-18 recipe), so this runs keyless in seconds and belongs to
 * the always-on sweep.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { readRenderCodeRef } from '../fixtures/render-contract.js';
import {
  MCP_APP_IFRAME_SELECTOR,
  mountRenderResource,
  type McpAppHostHandle,
} from '../fixtures/mcp-app-host.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const GGUI_ORIGIN = `http://localhost:${GGUI_PORT}`;
const MCP_URL = `${GGUI_ORIGIN}/mcp`;
const CONTROL_URL = `${GGUI_ORIGIN}/control`;

/**
 * The strict host policy. `'unsafe-inline'` mirrors the landing's real
 * posture (the embedding page's own framework needs it, and the shell's
 * `__GGUI_META__` bootstrap script rides it); everything ELSE is the
 * hardened shape: named origins only, no scheme sources anywhere.
 */
const STRICT_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${GGUI_ORIGIN}`,
  `connect-src 'self' ${GGUI_ORIGIN} ws://localhost:${GGUI_PORT}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
].join('; ');

/**
 * Unique-per-scenario contract — unique in SHAPE, not just in prose.
 *
 * `blueprintKey` canonicalization STRIPS `description`/`usage` by domain
 * rule (`@ggui-ai/protocol` canonicalize-contract: prose never alters
 * the wire surface), so two contracts that differ only in description
 * share the Tier-1 exact-match key and the registry treats them as ONE
 * shape — same shape + no variance ⇒ reuse whichever registration came
 * first. The keyless sweep runs this scenario and scenario 18 against
 * the same in-process server, and 27 primes first, so a description-only
 * "signature" here would hand 18's handshake THIS component (live: the
 * 2026-08-16 sweep red — 18 saw sha256(STRICT_CSP_COMPONENT_CODE) instead
 * of its own). Distinct prop NAMES + arity are what make the key unique.
 */
const STRICT_CSP_CONTRACT = {
  propsSpec: {
    description: 'strict-csp scenario 27 — a badge with a tone',
    properties: {
      badgeText: {
        schema: { type: 'string' },
        required: true,
        description: 'the badge caption',
      },
      tone: {
        schema: { type: 'string', enum: ['neutral', 'positive', 'warning'] },
        required: false,
        description: 'visual tone',
      },
    },
  },
} as const;

/**
 * Pre-built compiled component with BARE imports — the shape the LLM
 * generator emits. The bare specifiers are the point: they force the
 * mount through the import-rewrite machinery (static shims under this
 * CSP), so a green run proves the whole asset chain, not a
 * dependency-free special case.
 */
const STRICT_CSP_COMPONENT_CODE = [
  'import { jsx } from "react/jsx-runtime";',
  'import { Card, Text } from "@ggui-ai/design/primitives";',
  'export default function StrictCspCard() {',
  '  return jsx(Card, { children: jsx(Text, { children: "strict-csp-ok" }) });',
  '}',
  '',
].join('\n');

describe('Scenario 27 — strict-CSP host: asset-path mount, no scheme sources', () => {
  let host: McpAppHostHandle | null = null;
  let browser: BrowserHandle | null = null;

  afterEach(async () => {
    await browser?.close();
    browser = null;
    await host?.close();
    host = null;
  });

  test(
    'view paints via codeModuleUrl + shims under a no-blob/no-data/no-eval CSP',
    async () => {
      const expectedCodeHash = createHash('sha256')
        .update(STRICT_CSP_COMPONENT_CODE)
        .digest('hex');

      // ── 1. Zero-LLM priming via /control (scenario-18 recipe) ───
      const ops = unwrapStructured<{ codeHash: string }>(
        await callTool(CONTROL_URL, 'ggui_ops_register_blueprint', {
          contract: STRICT_CSP_CONTRACT,
          componentCode: STRICT_CSP_COMPONENT_CODE,
          confirm: true,
        }),
      );
      expect(ops.codeHash).toBe(expectedCodeHash);

      // ── 2. handshake (cache) → render.accept ────────────────────
      const handshake = unwrapStructured<{
        handshakeId: string;
        suggestion: { origin: string };
      }>(
        await callTool(MCP_URL, 'ggui_handshake', {
          intent: 'a strict-csp badge card — paraphrased vs the priming',
          blueprintDraft: { contract: STRICT_CSP_CONTRACT },
        }),
      );
      expect(handshake.suggestion.origin).toBe('cache');

      const renderResp = await callTool(MCP_URL, 'ggui_render', {
        handshakeId: handshake.handshakeId,
        props: { badgeText: 'strict-csp-ok' },
      });
      const render = unwrapStructured<{
        sessionId: string;
        resourceUri: string;
      }>(renderResp);

      // ── 3. Wire half: the slice carries the module variant ──────
      const codeRef = readRenderCodeRef(renderResp);
      expect(codeRef.codeHash).toBe(expectedCodeHash);
      expect(codeRef.codeModuleUrl).toBeTypeOf('string');
      expect(codeRef.codeModuleUrl).toMatch(
        new RegExp(`/code/${expectedCodeHash}\\.m[a-f0-9]{12}\\.js$`),
      );

      // ── 4. Browser half: mount under the strict CSP ─────────────
      host = await mountRenderResource({
        mcpUrl: MCP_URL,
        resourceUri: render.resourceUri,
        csp: STRICT_CSP,
      });
      browser = await openBrowser();
      // CSP-violation net across every frame in the context. A scheme
      // source touched anywhere (the blob/data ladder waking up)
      // surfaces here even when a later rung recovers the paint.
      await browser.context.addInitScript(() => {
        const w = window as unknown as { __cspViolations: string[] };
        w.__cspViolations = [];
        window.addEventListener('securitypolicyviolation', (ev) => {
          w.__cspViolations.push(
            `${ev.violatedDirective} ${ev.blockedURI} @ ${ev.sourceFile}:${ev.lineNumber}:${ev.columnNumber}`,
          );
        });
      });
      const responses: Array<{ url: string; status: number }> = [];
      browser.page.on('response', (res) => {
        responses.push({ url: res.url(), status: res.status() });
      });

      await browser.page.goto(host.url, { waitUntil: 'domcontentloaded' });
      const frame = browser.page.frameLocator(MCP_APP_IFRAME_SELECTOR);
      await frame.getByText('strict-csp-ok').waitFor({ timeout: 30_000 });

      // ── 5. The paint came through the ASSET path, not a fallback ─
      const variantHit = responses.find(
        (r) => /\/code\/[a-f0-9]{64}\.m[a-f0-9]{12}\.js$/.test(r.url),
      );
      expect(
        variantHit,
        `no /code/<hash>.m<rt>.js fetch observed — asset path did not run (responses: ${responses
          .map((r) => r.url)
          .filter((u) => u.includes(`:${GGUI_PORT}`))
          .join(', ')})`,
      ).toBeDefined();
      expect(variantHit!.status).toBe(200);

      const shimHit = responses.find((r) =>
        r.url.includes('/_ggui/shims/'),
      );
      expect(
        shimHit,
        'no /_ggui/shims/<rt>/<name>.js fetch observed — the variant did not resolve its imports from static shims',
      ).toBeDefined();
      expect(shimHit!.status).toBe(200);

      // ── 6. Nothing anywhere touched a scheme source ─────────────
      const pageViolations = await browser.page.evaluate(
        () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
      );
      const frameViolations = await frame
        .locator('body')
        .evaluate(
          () =>
            (window as unknown as { __cspViolations: string[] })
              .__cspViolations,
        );
      expect(pageViolations).toEqual([]);
      expect(frameViolations).toEqual([]);
    },
    90_000,
  );
});
