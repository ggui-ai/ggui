// Sample-side type re-exports.
//
// All chat-shape types live in `@ggui-ai/react/chat-helpers`. The
// sample-agent owns only sample-specific UI state (currently just
// `LayoutMode` for the Inline | Panel toggle); everything else is
// re-exported so the sample's components keep a single local import
// path.

export type LayoutMode = 'inline' | 'panel';

export type {
  ChatEntry,
  RenderRef,
  ToolCallEntry,
} from '@ggui-ai/react/chat-helpers';
