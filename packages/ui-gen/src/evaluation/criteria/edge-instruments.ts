/**
 * #1765 — the identity of each edge instrument on a capture: its row id and the sha256 of the page expression it ran,
 * so every reading names exactly which probe produced it (v1 is frozen at `cec465319`; v2 and v3 are separate
 * instruments, each frozen once its id is on the #1765 row).
 */
import { createHash } from 'node:crypto';
import { EDGE_BLOCKS_EXPRESSION } from './edge-probe.js';
import { EDGE_BLOCKS_V2_EXPRESSION } from './edge-probe-v2.js';
import { EDGE_BLOCKS_V3_EXPRESSION } from './edge-probe-v3.js';

const digest = (expression: string): string => createHash('sha256').update(expression).digest('hex').slice(0, 12);

export const EDGE_INSTRUMENT_IDS = {
  v1: `space.edge@${digest(EDGE_BLOCKS_EXPRESSION)}`,
  v2: `space.edge.v2@${digest(EDGE_BLOCKS_V2_EXPRESSION)}`,
  v3: `space.edge.v3@${digest(EDGE_BLOCKS_V3_EXPRESSION)}`,
} as const;
