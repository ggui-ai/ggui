export { AgentShell } from './AgentShell';
export type { AgentShellProps } from './agent-shell/types';
export type {
  AgentShellComponents,
  HeadProps,
  FrameProps,
  BubbleProps,
  InputProps,
  BackgroundProps,
  SoundMap,
} from './agent-shell/types';
export {
  GumiHead,
  GumiFrame,
  GumiBackground,
  GumiBubble,
  GumiInput,
} from './agent-shell/gumi';

export { ChatShell } from './ChatShell';
export type { ChatShellProps } from './ChatShell';

export { FullscreenShell } from './FullscreenShell';
export type { FullscreenShellProps } from './FullscreenShell';

export { WelcomePage } from './WelcomePage';
export type { WelcomePageProps } from './WelcomePage';

export {
  hexToRgb,
  darkenRgb,
  rgba,
  buildDarkCssOverrides,
  buildPrimaryCssOverrides,
  buildShellTheme,
  DEFAULT_PRIMARY,
} from './theme';
export type { ShellTheme } from './theme';
