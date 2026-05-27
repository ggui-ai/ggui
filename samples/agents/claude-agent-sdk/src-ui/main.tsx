import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, getRawTheme } from '@ggui-ai/design/themes';
import { Chat } from './Chat';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Pair the sample-agent chat shell with the SAME theme the iframe
// content uses (canvas-demo's `ggui.json` sets `theme: indigo / dark`).
// `<ThemeProvider>` expects the raw `DtcgTheme` token tree — `getTheme()`
// returns a different `ParsedTheme` shape (CSS-var references, not the
// token tree); the provider's `generateCssVariables` walks the raw tree
// to emit `--ggui-color-*` etc. into a `<style>` tag on `<head>`.
const indigoDark = getRawTheme('indigo', 'dark');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={indigoDark} mode="dark">
      <Chat />
    </ThemeProvider>
  </StrictMode>,
);
