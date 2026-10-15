#!/usr/bin/env bash
#
# Expo export smoke: a stock Expo app bundles @ggui-ai/mcp-apps-react-native
# as installed from the registry.
#
# Plain Node cannot load a React Native host helper, so the import smoke
# only resolves its entry. This step runs the bundler a React Native app
# actually uses: Metro, through `expo export`, with no metro.config.js
# and no babel.config.js. A package that ships TypeScript source, or a
# relative import that names a file it does not ship, fails here the way
# it fails in an app.
#
#   expo-export.sh <packages-root> <registry> <fixture-dir>
#
# Passes when the export exits 0 for android and ios, and each bundle
# carries both entries' code (`McpAppIframe` from ".",
# `extractRenderFromToolResult` from "./chat-helpers").
set -euo pipefail

PACKAGES_ROOT="$1"
REGISTRY="$2"
FIXTURE="$3"
APP="${EXPO_APP_DIR:-/tmp/expo-fixture}"

VERSION=$(node -p "require('$PACKAGES_ROOT/mcp-apps-react-native/package.json').version")

rm -rf "$APP"
mkdir -p "$APP"
cp "$FIXTURE/App.js" "$FIXTURE/index.js" "$FIXTURE/app.json" "$APP/"
sed "s/__GGUI_VERSION__/$VERSION/" "$FIXTURE/package.template.json" > "$APP/package.json"
printf 'registry=%s\n' "$REGISTRY" > "$APP/.npmrc"

cd "$APP"
echo "  installing a stock Expo app with @ggui-ai/mcp-apps-react-native@$VERSION"
npm install --no-audit --no-fund --loglevel=error

for platform in android ios; do
  out="dist-$platform"
  echo "  expo export --platform $platform"
  CI=1 npx expo export --platform "$platform" --no-bytecode --no-minify \
    --output-dir "$out"
  bundles=$(find "$out/_expo/static/js/$platform" -name '*.js')
  if [ -z "$bundles" ]; then
    echo "  FAIL  $platform: the export wrote no JavaScript bundle" >&2
    exit 1
  fi
  for symbol in McpAppIframe extractRenderFromToolResult; do
    # shellcheck disable=SC2086 # one or more bundle paths, none with spaces
    if ! grep -q -F "$symbol" $bundles; then
      echo "  FAIL  $platform: the bundle does not carry $symbol" >&2
      exit 1
    fi
  done
  echo "  ok    $platform bundle carries McpAppIframe and extractRenderFromToolResult"
done

echo "  expo export smoke passed"
