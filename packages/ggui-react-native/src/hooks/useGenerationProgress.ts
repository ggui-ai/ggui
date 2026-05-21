/**
 * Hook that listens for ggui:logs CustomEvents and maintains
 * a map of generation progress per stack item.
 *
 * Used by shell components to show real-time generation status
 * instead of static "Generating..." placeholders.
 */

import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';

/** Human-readable labels for each generation step */
const STEP_LABELS: Record<string, string> = {
  start: 'Starting generation...',
  blueprint_match: 'Matching blueprints...',
  writing: 'Writing code...',
  reviewing: 'Reviewing...',
  compiling: 'Compiling...',
  evaluating: 'Evaluating quality...',
  fixing: 'Fixing issues...',
  complete: 'Complete',
  error: 'Error',
};

/** Progress percentages for each step (used by FullscreenShell skeleton) */
export const STEP_PROGRESS: Record<string, number> = {
  start: 5,
  blueprint_match: 10,
  writing: 30,
  reviewing: 50,
  compiling: 60,
  evaluating: 75,
  fixing: 85,
  complete: 100,
  error: 0,
};

/**
 * Represents the current generation progress for a single stack item.
 */
export interface ProgressState {
  step: string;
  message: string;
  label: string;
  percent: number;
  timestamp: number;
}

/**
 * Hook that tracks real-time UI generation progress per stack item.
 *
 * On web platform, listens for `ggui:logs` CustomEvents dispatched by
 * the session layer. On native platforms, this is a no-op (progress events
 * are delivered via the `onProgress` callback on GguiSession instead).
 *
 * @returns `getProgress(stackItemId)` for a specific item, and
 *          `getLatestProgress()` for the most recent event across all items
 */
export function useGenerationProgress() {
  const [progressMap, setProgressMap] = useState<Map<string, ProgressState>>(new Map());

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    function handleProgress(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (!detail || typeof detail !== 'object') return;

      const stackItemId = detail.stackItemId;
      const { step, message } = detail;
      if (!stackItemId || !step) return;

      setProgressMap(prev => {
        const next = new Map(prev);
        next.set(stackItemId, {
          step,
          message: message || '',
          label: STEP_LABELS[step] || step,
          percent: STEP_PROGRESS[step] ?? 50,
          timestamp: Date.now(),
        });
        return next;
      });
    }

    window.addEventListener('ggui:logs', handleProgress);
    return () => window.removeEventListener('ggui:logs', handleProgress);
  }, []);

  const getProgress = useCallback(
    (stackItemId: string): ProgressState | undefined => progressMap.get(stackItemId),
    [progressMap]
  );

  /** Get the latest progress event across all stack items */
  const getLatestProgress = useCallback((): ProgressState | undefined => {
    let latest: ProgressState | undefined;
    for (const p of progressMap.values()) {
      if (!latest || p.timestamp > latest.timestamp) latest = p;
    }
    return latest;
  }, [progressMap]);

  return { getProgress, getLatestProgress };
}
