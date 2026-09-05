/**
 * InMemoryThemeStore — the ThemeStore reference adapter (OSS
 * single-app default + test fixture). Semantics pinned by
 * `theme-store.test.ts`; those pins are the frozen surface any
 * durable adapter builds against (ggui#598-C).
 */
import type { StoredTheme, ThemeStore } from '../theme-store.js';

export class InMemoryThemeStore implements ThemeStore {
  private readonly rows = new Map<string, StoredTheme>();

  private key(appId: string, themeId: string): string {
    return `${appId}\u0000${themeId}`;
  }

  async get(appId: string, themeId: string): Promise<StoredTheme | null> {
    return this.rows.get(this.key(appId, themeId)) ?? null;
  }

  async put(theme: StoredTheme): Promise<void> {
    const key = this.key(theme.appId, theme.themeId);
    const existing = this.rows.get(key);
    this.rows.set(
      key,
      existing !== undefined
        ? { ...theme, registeredAt: existing.registeredAt }
        : theme,
    );
  }

  async list(appId: string): Promise<readonly StoredTheme[]> {
    return [...this.rows.values()]
      .filter((t) => t.appId === appId)
      .sort((a, b) => (a.themeId < b.themeId ? -1 : a.themeId > b.themeId ? 1 : 0));
  }

  async delete(appId: string, themeId: string): Promise<boolean> {
    return this.rows.delete(this.key(appId, themeId));
  }
}
