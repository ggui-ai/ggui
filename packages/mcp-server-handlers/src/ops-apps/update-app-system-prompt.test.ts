import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createUpdateAppSystemPromptHandler } from './update-app-system-prompt.js';
import { AppNotFoundError } from './rename-app.js';
import { InMemoryAppsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createUpdateAppSystemPromptHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createUpdateAppSystemPromptHandler({
      apps: new InMemoryAppsSource(),
    });
    expect(handler.name).toBe('ggui_ops_update_app_system_prompt');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createUpdateAppSystemPromptHandler — happy path', () => {
  it('writes the system prompt onto the row', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'A',
    });
    const handler = createUpdateAppSystemPromptHandler({ apps });
    const result = await handler.handler(
      { appId: created.appId, systemPrompt: 'You are helpful.' },
      makeCtx(),
    );
    expect(result.systemPrompt).toBe('You are helpful.');
  });

  it('clears the system prompt when given empty string', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'A',
    });
    await apps.setSystemPrompt({
      appId: created.appId,
      ownerSub: 'user-1',
      systemPrompt: 'Old prompt',
    });
    const handler = createUpdateAppSystemPromptHandler({ apps });
    const result = await handler.handler(
      { appId: created.appId, systemPrompt: '' },
      makeCtx(),
    );
    expect(result.systemPrompt).toBeUndefined();
  });
});

describe('createUpdateAppSystemPromptHandler — tenancy', () => {
  it('rejects cross-user target with AppNotFoundError', async () => {
    const apps = new InMemoryAppsSource();
    const other = await apps.create({
      ownerSub: 'user-2',
      displayName: 'Theirs',
    });
    const handler = createUpdateAppSystemPromptHandler({ apps });
    await expect(
      handler.handler(
        { appId: other.appId, systemPrompt: 'evil' },
        makeCtx({ userId: 'user-1' }),
      ),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });
});
