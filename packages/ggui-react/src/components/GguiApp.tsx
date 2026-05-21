/**
 * GguiApp — top-level entry point for ggui applications.
 *
 * Wraps `<GguiProvider>` (app config, auth context) and renders the
 * selected shell. Shells read endpoint + auth from GguiProvider
 * context directly, so GguiApp is a thin picker with no wrapping
 * lifecycle.
 *
 * Three ways to set the shell:
 *   <GguiApp shell="agent" />                      // string shorthand
 *   <GguiApp shell={AgentShell} />                 // component reference
 *   <GguiApp shell={() => <ChatShell primary…/>} /> // render function
 */
import React from 'react';
import { GguiProvider } from './GguiProvider';
import type { GguiProviderProps } from './GguiProvider';
import { AgentShell } from '../shells/AgentShell';
import { ChatShell } from '../shells/ChatShell';
import { FullscreenShell } from '../shells/FullscreenShell';

/** The `shell` prop on GguiApp. All three forms accept the zero-prop shell surface. */
export type ShellProp =
  | 'agent'
  | 'chat'
  | 'fullscreen'
  | React.ComponentType
  | (() => React.ReactNode);

export interface GguiAppProps extends Omit<GguiProviderProps, 'children'> {
  /** Shell to render. String shorthand, component, or render function. */
  shell: ShellProp;
  children?: never;
}

function renderShell(shell: ShellProp): React.ReactNode {
  if (typeof shell === 'string') {
    switch (shell) {
      case 'agent':
        return <AgentShell />;
      case 'chat':
        return <ChatShell />;
      case 'fullscreen':
        return <FullscreenShell />;
      default: {
        const exhaustive: never = shell;
        throw new Error(`Unknown shell: ${JSON.stringify(exhaustive)}. Use "agent", "chat", or "fullscreen".`);
      }
    }
  }
  // Component ref or render function — invoke without props.
  const ShellComponent = shell as React.ComponentType;
  return <ShellComponent />;
}

export function GguiApp({ shell, ...providerProps }: GguiAppProps) {
  return (
    <GguiProvider {...providerProps}>
      {renderShell(shell)}
    </GguiProvider>
  );
}
