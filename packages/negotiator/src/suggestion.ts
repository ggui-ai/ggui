/**
 * Suggestion engine — detects structured data patterns in free-form
 * agent text and proposes a ggui_push call that would show them
 * interactively.
 *
 * Pure regex heuristics — zero I/O, zero LLM. The agent can call this
 * opportunistically on streamed output to decide whether to surface a
 * UI suggestion. Callers must pass a deduplication set to avoid
 * re-suggesting the same UI repeatedly in a live session.
 */

import { computeIntentId } from './intent.js';

/** Suggestion event sent to the agent. */
export interface NegotiatorSuggestion {
  type: 'negotiator:suggest';
  trigger: 'stream-data-detected' | 'session-context' | 'user-pattern';
  message: string;
  suggestedAction: {
    tool: 'ggui_push';
    input: { data?: Record<string, unknown>; prompt?: string };
  };
  confidence: number;
  intentId: string;
}

interface DetectionPattern {
  name: string;
  regex: RegExp;
  uiType: string;
  confidence: number;
}

const PATTERNS: DetectionPattern[] = [
  { name: 'temperature', regex: /\b\d+\s*°[CF]\b/i, uiType: 'weather display', confidence: 0.8 },
  { name: 'percentage', regex: /\b\d+(\.\d+)?\s*%/, uiType: 'metrics display', confidence: 0.6 },
  { name: 'currency', regex: /\$\s*[\d,]+(\.\d{2})?|\b\d+(\.\d{2})?\s*(USD|EUR|GBP|JPY|KRW)\b/i, uiType: 'financial display', confidence: 0.7 },
  { name: 'speed-or-distance', regex: /\b\d+(\.\d+)?\s*(km\/h|mph|km|mi|m\/s)\b/i, uiType: 'data display', confidence: 0.6 },
  { name: 'numbered-list', regex: /(?:^|\n)\s*[1-9]\.\s+\S/m, uiType: 'step flow or list', confidence: 0.5 },
  { name: 'comparison', regex: /\b(vs\.?|versus|compared to|on the other hand|alternatively)\b/i, uiType: 'comparison view', confidence: 0.6 },
  { name: 'table-like', regex: /\|.*\|.*\|/, uiType: 'table or grid', confidence: 0.8 },
];

/** Detect structured data patterns in streamed text. */
export function detectDataPatterns(text: string): Array<{ pattern: string; uiType: string; confidence: number }> {
  const matches: Array<{ pattern: string; uiType: string; confidence: number }> = [];
  for (const p of PATTERNS) {
    if (p.regex.test(text)) {
      matches.push({ pattern: p.name, uiType: p.uiType, confidence: p.confidence });
    }
  }
  return matches;
}

/** Build a suggestion event from detected patterns. */
export function buildSuggestion(
  renderId: string,
  detections: Array<{ pattern: string; uiType: string; confidence: number }>,
  activeIntentIds: Set<string>,
): NegotiatorSuggestion | null {
  if (detections.length === 0) return null;
  const best = detections.reduce((a, b) => (a.confidence > b.confidence ? a : b));
  const intentId = computeIntentId(renderId, { detectedPattern: best.pattern }, 'create');
  if (activeIntentIds.has(intentId)) return null;
  return {
    type: 'negotiator:suggest',
    trigger: 'stream-data-detected',
    message: `I noticed structured data in your response (${best.pattern}). Consider calling ggui_push for an interactive ${best.uiType} instead.`,
    suggestedAction: { tool: 'ggui_push', input: { prompt: best.uiType } },
    confidence: best.confidence,
    intentId,
  };
}
