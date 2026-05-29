/**
 * SQLite connection + schema for the table-order sample.
 *
 * Uses `better-sqlite3` (synchronous, already a proven dep elsewhere in
 * this monorepo). Default is an in-memory database (`:memory:`) — perfect
 * for a demo/sample: zero files on disk, fresh per process, reseeded via
 * `/admin/reset`. Pass a file path for durability if you want orders to
 * survive a restart.
 *
 * This module owns ONLY the connection + DDL. Row↔domain mapping lives in
 * `store.ts`; business rules + authz live in `service.ts`.
 */
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';

export type { SqliteDatabase };

/** Open a connection and ensure the schema exists. */
export function openDb(filename = ':memory:'): SqliteDatabase {
  const db = new Database(filename);
  // WAL only helps a real file; skip it for the in-memory demo default.
  if (filename !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_item (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL,
      price_cents   INTEGER NOT NULL,
      category      TEXT NOT NULL,
      tags_json     TEXT NOT NULL DEFAULT '[]',
      options_json  TEXT NOT NULL DEFAULT '[]',
      available     INTEGER NOT NULL DEFAULT 1,
      photo_path    TEXT NOT NULL DEFAULT '',
      sort_order    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS restaurant_table (
      id               TEXT PRIMARY KEY,
      label            TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'empty',
      current_order_id TEXT,
      sort_order       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id         TEXT PRIMARY KEY,
      table_id   TEXT NOT NULL,
      status     TEXT NOT NULL,
      placed_at  TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_line (
      id                    TEXT PRIMARY KEY,
      order_id              TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      item_id               TEXT NOT NULL,
      name                  TEXT NOT NULL,
      qty                   INTEGER NOT NULL,
      selected_options_json TEXT NOT NULL DEFAULT '[]',
      line_total_cents      INTEGER NOT NULL,
      seq                   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_orders_table  ON orders(table_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_line_order    ON order_line(order_id);
  `);
}

/** Drop all rows (used by reseed). Schema is preserved. */
export function truncateAll(db: SqliteDatabase): void {
  db.exec(`
    DELETE FROM order_line;
    DELETE FROM orders;
    DELETE FROM restaurant_table;
    DELETE FROM menu_item;
  `);
}
