import type { ReactNode } from 'react';
import type { AgentState } from '../../types/shell';

export type { AgentState } from '../../types/shell';

/**
 * Proxy for the old WebSocket connection-status value surfaced to
 * custom character components. Post-invoke-SSE rewrite there's no
 * persistent transport connection to probe; this string is a thin
 * mapping so builders who branch on it don't hard-break:
 *
 *   - `'connected'`   — endpoint resolved, not streaming — the
 *                       equivalent of "ready to send".
 *   - `'connecting'`  — streaming in progress, or endpoint not yet
 *                       resolved from context.
 *   - `'disconnected'`— useInvoke reported an error.
 *
 * Not intended as a protocol type; only useful inside
 * {@link HeadProps.connectionStatus}.
 */
export type ShellReadinessStatus = 'connected' | 'connecting' | 'disconnected';

// ── Component prop interfaces ────────────────────────────────────────

export interface HeadProps {
  state: AgentState;
  connectionStatus: ShellReadinessStatus;
  characterUrl?: string;
}

export interface FrameProps {
  state: AgentState;
  children: ReactNode;
}

export interface BubbleProps {
  state: AgentState;
  message: string | null;
  visible: boolean;
}

export interface InputProps {
  state: AgentState;
  onSubmit: (text: string) => void;
  disabled: boolean;
}

export interface BackgroundProps {
  state: AgentState;
  backgroundUrl?: string;
}

// ── Components map ───────────────────────────────────────────────────

export interface AgentShellComponents {
  head: (props: HeadProps) => ReactNode;
  frame: (props: FrameProps) => ReactNode;
  background: (props: BackgroundProps) => ReactNode;
  thinkingBubble: (props: BubbleProps) => ReactNode;
  inputField: (props: InputProps) => ReactNode;
}

// ── Sound ────────────────────────────────────────────────────────────

export type AudioSrc = string | HTMLAudioElement;

export interface SoundMap {
  thinking: AudioSrc;
  presenting: AudioSrc;
  error: AudioSrc;
  agentMsg: AudioSrc;
}

// ── Assets ───────────────────────────────────────────────────────────

export interface GguiAssets {
  background?: string;
  character?: string;
  bubble?: string;
}

// ── AgentShell Props ─────────────────────────────────────────────────

export interface AgentShellProps {
  /** Custom character components — falls back to the default Gumi set. */
  components?: Partial<AgentShellComponents>;
  /** Sound effects on state transitions. `false` disables all sounds. */
  sounds?: false | Partial<SoundMap>;
  /** Optional background / character / bubble asset overrides. */
  assets?: GguiAssets;
  /** Tenant accent color (hex). */
  primaryColor?: string;
  /** Fires on every agent-state transition. */
  onStateChange?: (state: AgentState) => void;
  /**
   * Override the invoke endpoint URL. When absent, falls through to
   * `useGguiContext().appConfig.endpointUrl`.
   */
  endpointUrl?: string;
  /**
   * Origin for render-resource URLs. Defaults to `apiBaseUrl` on the
   * context, or the origin component of the resolved `endpointUrl`.
   */
  renderResourceOrigin?: string;
}
