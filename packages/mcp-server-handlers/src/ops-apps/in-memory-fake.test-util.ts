/**
 * In-memory fakes for the `AppsSource` + `UserDefaultAppSource` seams,
 * shared across `ops-apps` test files. Lives inside the test layer so
 * production code can't accidentally import it.
 *
 * File suffix `.test-util.ts` keeps Vitest from collecting it as a
 * spec while the `.ts` extension keeps tsc happy.
 */

import type { AppRecord, AppsSource, UserDefaultAppSource } from './types.js';

export class InMemoryAppsSource implements AppsSource {
  private readonly rows = new Map<string, AppRecord>();
  private idCounter = 0;
  private clock = 0;

  constructor(seed: readonly AppRecord[] = []) {
    for (const row of seed) {
      this.rows.set(row.appId, row);
    }
  }

  private now(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }

  async list(ownerSub: string): Promise<readonly AppRecord[]> {
    return [...this.rows.values()].filter((r) => r.ownerSub === ownerSub);
  }

  async get(args: {
    appId: string;
    ownerSub: string;
  }): Promise<AppRecord | null> {
    const row = this.rows.get(args.appId);
    if (!row) return null;
    if (row.ownerSub !== args.ownerSub) return null;
    return row;
  }

  async create(args: {
    ownerSub: string;
    displayName?: string;
  }): Promise<AppRecord> {
    this.idCounter += 1;
    const appId = `app_${this.idCounter.toString(36).padStart(8, '0')}`;
    const now = this.now();
    const row: AppRecord = {
      appId,
      ownerSub: args.ownerSub,
      displayName: args.displayName ?? 'My ggui app',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(appId, row);
    return row;
  }

  async rename(args: {
    appId: string;
    ownerSub: string;
    displayName: string;
  }): Promise<AppRecord> {
    const row = this.rows.get(args.appId);
    if (!row || row.ownerSub !== args.ownerSub) {
      throw new Error(`InMemoryAppsSource.rename: not found ${args.appId}`);
    }
    const next: AppRecord = {
      ...row,
      displayName: args.displayName,
      updatedAt: this.now(),
    };
    this.rows.set(args.appId, next);
    return next;
  }

  async delete(args: { appId: string; ownerSub: string }): Promise<void> {
    const row = this.rows.get(args.appId);
    if (!row) return;
    if (row.ownerSub !== args.ownerSub) return;
    this.rows.delete(args.appId);
  }

  async setSystemPrompt(args: {
    appId: string;
    ownerSub: string;
    systemPrompt: string;
  }): Promise<AppRecord> {
    const row = this.rows.get(args.appId);
    if (!row || row.ownerSub !== args.ownerSub) {
      throw new Error(
        `InMemoryAppsSource.setSystemPrompt: not found ${args.appId}`,
      );
    }
    const next: AppRecord = {
      ...row,
      systemPrompt: args.systemPrompt === '' ? undefined : args.systemPrompt,
      updatedAt: this.now(),
    };
    this.rows.set(args.appId, next);
    return next;
  }
}

export class InMemoryUserDefaultAppSource implements UserDefaultAppSource {
  private readonly defaults = new Map<string, string>();

  async setDefault(args: {
    ownerSub: string;
    appId: string;
  }): Promise<void> {
    this.defaults.set(args.ownerSub, args.appId);
  }

  async getDefault(ownerSub: string): Promise<string | null> {
    return this.defaults.get(ownerSub) ?? null;
  }
}
