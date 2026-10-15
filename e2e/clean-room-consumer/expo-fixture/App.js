// A stock Expo app (no metro.config.js, no babel.config.js) that imports
// both entries of @ggui-ai/mcp-apps-react-native exactly as a React
// Native host would. The gate passes when `expo export` bundles it and
// the bundle carries both entries' code.
import { Text, View } from 'react-native';
import { McpAppIframe } from '@ggui-ai/mcp-apps-react-native';
import { extractRenderFromToolResult } from '@ggui-ai/mcp-apps-react-native/chat-helpers';

export default function App() {
  return (
    <View>
      <Text>{typeof McpAppIframe}</Text>
      <Text>{typeof extractRenderFromToolResult}</Text>
    </View>
  );
}
