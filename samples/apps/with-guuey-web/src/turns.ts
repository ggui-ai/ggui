import type { AgMessage } from '@guuey/agent-client';

/**
 * One agent turn as folded from the AgJSON transcript: the assistant's
 * answer, its interim narration, and the tool names the turn invoked
 * (rendered as activity chips).
 */
export interface AssistantTurn {
  key: string;
  /** The answer: every assistant text block not marked `phase: "interim"`. */
  text: string;
  /**
   * Interim narration ("Looking that up…"), one entry per non-empty
   * `phase: "interim"` text block, in order. Drawn as status lines beside
   * the answer, never inside it.
   */
  narration: string[];
  tools: string[];
}

/**
 * Group the fold's messages into per-turn assistant output, in first-seen
 * turn order. The dev router runs one turn per invoke, so turn N pairs with
 * the user's Nth message (the zip in `App.tsx`'s `Transcript`). Text is taken
 * from assistant-role messages only — tool-role messages carry tool-result
 * payloads, not prose. A text block marked `phase: "interim"` is narration,
 * not answer; any other phase, known or not, is answer text.
 */
export function foldAssistantTurns(foldMessages: AgMessage[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  const indexByTurn = new Map<string, number>();
  for (const m of foldMessages) {
    const turnKey = m.turnId ?? m.id;
    let i = indexByTurn.get(turnKey);
    if (i === undefined) {
      i = turns.length;
      indexByTurn.set(turnKey, i);
      turns.push({ key: turnKey, text: '', narration: [], tools: [] });
    }
    const turn = turns[i];
    for (const block of m.content) {
      if (block.type === 'text' && m.role === 'assistant') {
        if (block.phase === 'interim') {
          if (block.text.length > 0) turn.narration.push(block.text);
        } else {
          turn.text += block.text;
        }
      } else if (block.type === 'tool-call') {
        turn.tools.push(block.name);
      }
    }
  }
  return turns;
}
