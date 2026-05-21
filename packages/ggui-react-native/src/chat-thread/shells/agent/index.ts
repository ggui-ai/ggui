/**
 * @experimental AgentShell — a character-as-focus shell. Only the
 * public types are defined here; the component itself is not yet
 * implemented.
 *
 * These types are published ahead of the implementation so consumers
 * can typecheck against the future surface and see where AgentShell
 * will live without the runtime cost of an unfinished component.
 */
import type { ComponentType } from 'react';

export type CharacterState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'responding'
  | 'done-or-error';

export interface CharacterProps {
  state: CharacterState;
  /** The currently-speaking text fragment. */
  currentText?: string;
  /** Skip animated transitions (matches ExperiencePolicy.reducedMotion). */
  reducedMotion?: boolean;
}

/**
 * A pluggable character implementation. Integrators pass one to
 * `<AgentShell character={MyCharacter} />`.
 */
export type Character = ComponentType<CharacterProps>;
