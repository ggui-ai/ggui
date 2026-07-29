/**
 * In-memory fakes for the `AppsSource` + `UserDefaultAppSource` seams,
 * shared across `ops-apps` test files. Lives inside the test layer so
 * production code can't accidentally import it.
 *
 * File suffix `.test-util.ts` keeps Vitest from collecting it as a
 * spec while the `.ts` extension keeps tsc happy.
 */

import type { AppTheme } from '@ggui-ai/protocol';
import type {
  AppRecord,
  AppsSource,
  AppUpdatePatch,
  UserDefaultAppSource,
} from './types.js';

export class InMemoryAppsSource implements AppsSource {
  private readonly rows = new Map<string, AppRecord>();
  private readonly themes = new Map<string, AppTheme>();
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

  async update(args: {
    appId: string;
    ownerSub: string;
    patch: AppUpdatePatch;
  }): Promise<AppRecord> {
    const row = this.rows.get(args.appId);
    if (!row || row.ownerSub !== args.ownerSub) {
      throw new Error(`InMemoryAppsSource.update: not found ${args.appId}`);
    }
    const { patch } = args;
    if (
      patch.displayName === undefined &&
      patch.systemPrompt === undefined &&
      patch.rateLimitPerMinute === undefined
    ) {
      throw new Error('InMemoryAppsSource.update: empty patch');
    }
    // Mirror the production normalization: clearing sentinels map onto
    // field ABSENCE so reads stay single-valued.
    const systemPrompt =
      patch.systemPrompt === undefined
        ? row.systemPrompt
        : patch.systemPrompt === ''
          ? undefined
          : patch.systemPrompt;
    const rateLimitPerMinute =
      patch.rateLimitPerMinute === undefined
        ? row.rateLimitPerMinute
        : patch.rateLimitPerMinute === 0
          ? undefined
          : patch.rateLimitPerMinute;
    const next: AppRecord = {
      appId: row.appId,
      ownerSub: row.ownerSub,
      displayName:
        patch.displayName === undefined
          ? row.displayName
          : patch.displayName.trim(),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(rateLimitPerMinute !== undefined ? { rateLimitPerMinute } : {}),
      createdAt: row.createdAt,
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
    this.themes.delete(args.appId);
  }

  async setTheme(args: {
    appId: string;
    ownerSub: string;
    theme: AppTheme;
  }): Promise<{ appId: string; updatedAt: string }> {
    const row = this.rows.get(args.appId);
    if (!row || row.ownerSub !== args.ownerSub) {
      throw new Error(`InMemoryAppsSource.setTheme: not found ${args.appId}`);
    }
    const next: AppRecord = { ...row, updatedAt: this.now() };
    this.rows.set(args.appId, next);
    this.themes.set(args.appId, args.theme);
    return { appId: args.appId, updatedAt: next.updatedAt };
  }

  /** Test introspection: the last theme persisted for an app. */
  getTheme(appId: string): AppTheme | undefined {
    return this.themes.get(appId);
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
