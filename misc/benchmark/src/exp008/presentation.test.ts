// ggui#1492 — the eval cell's reader of `canvasPresentations` duplicates the writer's rules (it cannot import
// the writer's package), so both readers are pinned to ONE vector table. The table here is a byte copy of the
// writer's; the sha pin fails the moment either copy is edited alone.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@ggui-ai/protocol';
import { PRESENTATION_MALFORMED_REASONS, readCanvasPresentations, type PresentationRead } from './presentation';
import type { CanvasClass } from '../multi-sdk/canvas.js';

const TABLE_FILE = join(__dirname, '__fixtures__', 'presentation-vectors.json');
/** sha256 of the writer's table as committed (the writer's `__fixtures__/presentation-vectors.json`, blob 690298e45dd3). */
const TABLE_SHA256 = '808ae35a4be240127e8e83106d41b4e1f2207c2236abfe8936992d07385ce9a6';

interface VectorRow {
  readonly name: string;
  readonly judged: readonly CanvasClass[];
  readonly declaredPrimary?: CanvasClass;
  readonly input?: JsonValue;
  readonly expect: PresentationRead;
}
interface VectorTable {
  readonly version: number;
  readonly reasons: readonly string[];
  readonly rows: readonly VectorRow[];
}

const raw = readFileSync(TABLE_FILE);
const table = JSON.parse(raw.toString('utf8')) as VectorTable;

describe('ggui#1492 — the presentation vector table is the writer\'s, byte for byte', () => {
  it('its sha256 is the pinned one (edit both copies together, never one)', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(TABLE_SHA256);
  });

  it('names exactly this reader\'s reasons, in order, and every reason has a row', () => {
    expect(table.reasons).toEqual([...PRESENTATION_MALFORMED_REASONS]);
    const seen = new Set(table.rows.flatMap((r) => r.expect.malformed.map((m) => m.reason)));
    expect([...PRESENTATION_MALFORMED_REASONS].filter((r) => !seen.has(r))).toEqual([]);
  });
});

describe('readCanvasPresentations — every row of the table reads as the writer reads it', () => {
  for (const row of table.rows) {
    it(row.name, () => {
      expect(readCanvasPresentations(row.input, row.judged, row.declaredPrimary)).toEqual(row.expect);
    });
  }
});
