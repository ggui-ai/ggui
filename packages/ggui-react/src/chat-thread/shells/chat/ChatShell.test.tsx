// @vitest-environment jsdom
/**
 * ChatShell text-block rendering — code-property tests (deterministic;
 * this is first-party shell code, not LLM output).
 *
 * Chat transcript text is PLAIN by design (rich presentation belongs in
 * the generated UI), but plain must still respect authored whitespace:
 * agents separate paragraphs with newlines, and a collapsed one-line
 * blob misreads. The text block therefore carries
 * `white-space: pre-wrap`.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import type { AppDisplayConfig } from '@ggui-ai/protocol';
import { ChatShell } from './ChatShell';
import { ChatThreadProvider } from '../../ChatThreadProvider';
import type { MessageStorageAdapter, StoredMessage } from '../../adapters/types';

const APP_ID = 'app_test';
const THREAD_ID = 't1';

function appConfig(): AppDisplayConfig {
  return {
    appId: APP_ID,
    name: 'Test App',
    defaultShellType: 'chat',
    themeId: 'ggui',
    designSystemPreset: 'default',
    endpointUrl: 'https://agent.example.com',
  };
}

/** Read-only adapter over a fixed history — enough to mount the shell. */
function fixedHistoryAdapter(messages: StoredMessage[]): MessageStorageAdapter {
  return {
    async loadMessages() {
      return [...messages];
    },
    observeMessages() {
      return () => {};
    },
    async appendMessage() {
      throw new Error('not exercised by this test');
    },
  };
}

const MULTI_PARAGRAPH: StoredMessage = {
  key: 'msg_1',
  threadId: THREAD_ID,
  authorRole: 'agent',
  kind: 'text',
  blocks: [{ type: 'text', text: 'para one\n\npara two' }],
  cardSnapshot: null,
  textPreview: 'para one',
  seq: 1,
  at: '2026-08-07T00:00:00Z',
};

function mountShell(): ReturnType<typeof render> {
  return render(
    <ChatThreadProvider
      threadId={THREAD_ID}
      appId={APP_ID}
      appConfig={appConfig()}
      adapter={fixedHistoryAdapter([MULTI_PARAGRAPH])}
      loadingFallback={<div data-testid="loading" />}
    >
      <ChatShell />
    </ChatThreadProvider>,
  );
}

describe('ChatShell text block', () => {
  it('preserves authored newlines via white-space: pre-wrap', async () => {
    const { container } = mountShell();
    await waitFor(() => {
      expect(container.querySelector('[data-ggui-block="text"]')).not.toBeNull();
    });
    const p = container.querySelector('[data-ggui-block="text"]') as HTMLElement;
    expect(p.textContent).toBe('para one\n\npara two');
    expect(p.style.whiteSpace).toBe('pre-wrap');
  });
});
