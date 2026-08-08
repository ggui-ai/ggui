/**
 * `mountMcpAppIframe` — the runtime's own HOST role for embedded
 * foreign MCP Apps (`type === 'mcpApps'` renders).
 *
 * The load-bearing pin is the `ui/initialize` response shape: a
 * spec-canonical embedded app connects via `@modelcontextprotocol/
 * ext-apps` `App.connect`, which zod-validates the response against
 * `McpUiInitializeResultSchema` (`protocolVersion` + `hostInfo` +
 * `hostCapabilities` + `hostContext` ALL required). The pre-App draft
 * shape (`{theme, containerDimensions, locale}` at the top level)
 * fails that gate and kills the embedded mount — same bug class as
 * the RN `McpAppIframe` dispatcher, caught by the npx-bootstrap e2e
 * (ggui#425 item 5).
 */
import { describe, expect, it, vi } from 'vitest';
import type { McpAppsGguiSession } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  LATEST_PROTOCOL_VERSION,
  McpUiInitializeResultSchema,
} from '@modelcontextprotocol/ext-apps';
import { mountMcpAppIframe } from '../mcp-app-iframe-host.js';

const SAMPLE_RENDER: McpAppsGguiSession = {
  type: 'mcpApps',
  id: 'render-embed-test',
  createdAt: '2026-08-07T00:00:00.000Z',
  source: {
    connectorId: 'test-connector',
    toolName: 'test_tool',
    resourceUri: 'ui://test/app',
  },
};

async function initializeRoundTrip(
  params?: Record<string, unknown>,
): Promise<unknown> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mount = mountMcpAppIframe(container, {
    render: SAMPLE_RENDER,
    sessionId: SAMPLE_RENDER.id,
  });
  const inner = mount.element.contentWindow;
  if (inner === null) throw new Error('jsdom iframe has no contentWindow');
  const posted = vi.spyOn(inner, 'postMessage');

  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        id: 11,
        method: 'ui/initialize',
        ...(params !== undefined ? { params } : {}),
      },
      source: inner,
    }),
  );
  // The bridge handler is async — flush the microtask queue.
  await Promise.resolve();
  await Promise.resolve();

  expect(posted).toHaveBeenCalledTimes(1);
  const response = posted.mock.calls[0]?.[0] as {
    jsonrpc: string;
    id: number;
    result?: unknown;
  };
  expect(response.jsonrpc).toBe('2.0');
  expect(response.id).toBe(11);
  mount.unmount();
  container.remove();
  return response.result;
}

describe('mountMcpAppIframe — ui/initialize host response', () => {
  it('returns a spec-valid McpUiInitializeResult', async () => {
    const raw = await initializeRoundTrip();
    const result = McpUiInitializeResultSchema.parse(raw);
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(result.hostContext).toHaveProperty('locale');
    expect(result.hostContext).toHaveProperty('containerDimensions');
  });

  it('echoes the requested protocolVersion when supplied', async () => {
    const raw = await initializeRoundTrip({ protocolVersion: '2026-01-26' });
    const result = McpUiInitializeResultSchema.parse(raw);
    expect(result.protocolVersion).toBe('2026-01-26');
  });
});

describe('ui/initialize advertises implemented capabilities (ggui#440)', () => {
  it('advertises serverTools because the host proxies tools/call', async () => {
    const raw = await initializeRoundTrip();
    const result = McpUiInitializeResultSchema.parse(raw);
    expect(result.hostCapabilities.serverTools).toBeDefined();
  });

  it('does NOT advertise message — this host has no ui/message case', async () => {
    // Honesty matters more than completeness: a doorbell posted to this
    // host goes nowhere, and the runtime now tells the user so.
    const raw = await initializeRoundTrip();
    const result = McpUiInitializeResultSchema.parse(raw);
    expect(result.hostCapabilities.message).toBeUndefined();
  });
});
