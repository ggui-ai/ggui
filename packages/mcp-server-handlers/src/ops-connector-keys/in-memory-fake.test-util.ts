/**
 * In-memory fake for the `ConnectorKeysSource` seam, shared across
 * `ops-connector-keys` test files.
 */

import type {
  ConnectorKeySummary,
  ConnectorKeysSource,
  IssueConnectorKeyResult,
} from './types.js';
import {
  ConnectorKeyAccessDeniedError,
  ConnectorKeyNotFoundError,
} from './types.js';

interface InternalRow extends ConnectorKeySummary {
  readonly ownerSub: string;
}

export class InMemoryConnectorKeysSource implements ConnectorKeysSource {
  private readonly rows = new Map<string, InternalRow>();
  private idCounter = 0;
  private clock = 0;

  private now(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }

  async list(ownerSub: string): Promise<readonly ConnectorKeySummary[]> {
    return [...this.rows.values()]
      .filter((r) => r.ownerSub === ownerSub)
      .map(({ ownerSub: _ownerSub, ...summary }) => summary);
  }

  async issue(args: {
    ownerSub: string;
    name?: string;
    appId?: string;
    expiresAt?: string;
  }): Promise<IssueConnectorKeyResult> {
    this.idCounter += 1;
    const id = `key_${this.idCounter.toString(36).padStart(8, '0')}`;
    const plaintext = `ggui_user_${this.idCounter
      .toString(36)
      .padStart(24, '0')}`;
    const apiKeyPrefix = plaintext.slice('ggui_user_'.length).slice(0, 8);
    const now = this.now();
    const row: InternalRow = {
      ownerSub: args.ownerSub,
      id,
      apiKeyPrefix,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.appId !== undefined ? { appId: args.appId } : {}),
      status: 'active',
      createdAt: now,
      ...(args.expiresAt !== undefined
        ? { expiresAt: args.expiresAt }
        : {}),
    };
    this.rows.set(id, row);
    const { ownerSub: _ownerSub, ...summary } = row;
    return { summary, plaintextKey: plaintext };
  }

  async revoke(args: {
    ownerSub: string;
    keyId: string;
  }): Promise<{
    summary: ConnectorKeySummary;
    alreadyRevoked: boolean;
  }> {
    const existing = this.rows.get(args.keyId);
    if (!existing) {
      throw new ConnectorKeyNotFoundError(args.keyId);
    }
    if (existing.ownerSub !== args.ownerSub) {
      throw new ConnectorKeyAccessDeniedError(
        `caller ${args.ownerSub} cannot revoke key ${args.keyId}`,
      );
    }
    if (existing.status === 'revoked') {
      const { ownerSub: _ownerSub, ...summary } = existing;
      return { summary, alreadyRevoked: true };
    }
    const updated: InternalRow = { ...existing, status: 'revoked' };
    this.rows.set(args.keyId, updated);
    const { ownerSub: _ownerSub, ...summary } = updated;
    return { summary, alreadyRevoked: false };
  }
}
