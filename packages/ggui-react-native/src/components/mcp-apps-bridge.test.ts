/**
 * `handleHostBridgeRequest` — the composable host-role bridge switch.
 *
 * The load-bearing pin is the `ui/initialize` result shape:
 * `@modelcontextprotocol/ext-apps` `App.connect` zod-validates the
 * response against `McpUiInitializeResultSchema` (`protocolVersion` +
 * `hostInfo` + `hostCapabilities` + `hostContext` ALL required), so a
 * draft-shaped result kills every embedded-page mount before the
 * renderer boots. Same bug class the `McpAppIframe` dispatcher had —
 * caught live by the npx-bootstrap e2e (ggui#425 item 5).
 */
import { describe, expect, it } from 'vitest';
import type { McpAppsGguiSession } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  LATEST_PROTOCOL_VERSION,
  McpUiInitializeResultSchema,
} from '@modelcontextprotocol/ext-apps';
import { handleHostBridgeRequest, type HostBridgeContext } from './mcp-apps-bridge';

const SAMPLE_RENDER: McpAppsGguiSession = {
  type: 'mcpApps',
  id: 'render-bridge-test',
  createdAt: '2026-08-07T00:00:00.000Z',
  source: {
    connectorId: 'test-connector',
    toolName: 'test_tool',
    resourceUri: 'ui://test/app',
  },
};

function makeCtx(overrides?: Partial<HostBridgeContext>): HostBridgeContext {
  return {
    sessionId: SAMPLE_RENDER.id,
    render: SAMPLE_RENDER,
    toolsCallUrl: 'https://ggui.test/mcp-apps/tools-call',
    ...overrides,
  };
}

describe('handleHostBridgeRequest — ui/initialize', () => {
  it('returns a spec-valid McpUiInitializeResult', async () => {
    const res = await handleHostBridgeRequest(
      { jsonrpc: '2.0', id: 3, method: 'ui/initialize' },
      makeCtx({
        locale: 'ko-KR',
        containerDimensions: { width: 320, height: 480 },
      }),
    );
    expect(res).not.toBeNull();
    const result = McpUiInitializeResultSchema.parse(res?.result);
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(result.hostContext.locale).toBe('ko-KR');
    expect(result.hostContext.containerDimensions).toEqual({
      width: 320,
      height: 480,
    });
  });

  it('echoes the requested protocolVersion when supplied', async () => {
    const res = await handleHostBridgeRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'ui/initialize',
        params: { protocolVersion: '2026-01-26' },
      },
      makeCtx(),
    );
    const result = McpUiInitializeResultSchema.parse(res?.result);
    expect(result.protocolVersion).toBe('2026-01-26');
  });
});
