/**
 * Thread-level operations against a self-hosted server.
 *
 * Kept outside the adapter because `FullChatStorageAdapter` is
 * per-thread; these operations create/read/list threads themselves
 * and have different callers (thread creation + thread-list lookups).
 *
 * All functions return the protocol `Thread` shape verbatim.
 */
import type {
  ListThreadsFilter,
  ListThreadsResult,
  Thread,
} from '@ggui-ai/protocol';
import { httpRequest, threadsPath, type TransportConfig } from './transport.js';

export interface SelfHostedThreadOpsOptions {
  readonly baseUrl: string;
  readonly pairingToken: string;
  readonly fetch?: typeof fetch;
}

function toCfg(opts: SelfHostedThreadOpsOptions): TransportConfig {
  return {
    baseUrl: opts.baseUrl,
    pairingToken: opts.pairingToken,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
}

export interface CreateSelfHostedThreadInput {
  readonly appId: string;
  /** Optional hint the server seeds as the thread title. */
  readonly firstMessageHint?: string;
  readonly metadata?: Record<string, unknown>;
}

export async function createSelfHostedThread(
  opts: SelfHostedThreadOpsOptions,
  input: CreateSelfHostedThreadInput,
): Promise<Thread> {
  const body: Record<string, unknown> = { appId: input.appId };
  if (input.firstMessageHint !== undefined) body['firstMessageHint'] = input.firstMessageHint;
  if (input.metadata !== undefined) body['metadata'] = input.metadata;
  return httpRequest<Thread>(toCfg(opts), threadsPath(), {
    method: 'POST',
    body,
  });
}

export async function getSelfHostedThread(
  opts: SelfHostedThreadOpsOptions,
  threadId: string,
): Promise<Thread> {
  return httpRequest<Thread>(
    toCfg(opts),
    `${threadsPath()}/${encodeURIComponent(threadId)}`,
  );
}

export async function listSelfHostedThreads(
  opts: SelfHostedThreadOpsOptions,
  filter: ListThreadsFilter = {},
): Promise<ListThreadsResult> {
  const query = new URLSearchParams();
  if (filter.status) query.set('status', filter.status);
  if (filter.appId) query.set('appId', filter.appId);
  if (typeof filter.limit === 'number')
    query.set('limit', String(filter.limit));
  if (filter.cursor) query.set('cursor', filter.cursor);
  const q = query.toString();
  return httpRequest<ListThreadsResult>(
    toCfg(opts),
    threadsPath() + (q ? `?${q}` : ''),
  );
}
