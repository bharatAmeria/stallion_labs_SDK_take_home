const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '..');

/**
 * Metro configuration for the BitNet example app.
 *
 * Because the SDK is linked via `file:../` we need to tell Metro to:
 *  1. Watch the parent (SDK) directory for changes
 *  2. Resolve the SDK's node_modules from the example's node_modules
 *     (avoids duplicate React / React-Native instances)
 */
const config = {
  watchFolders: [root],

  resolver: {
    // When Metro resolves a module inside the SDK source, prefer the
    // example's node_modules so there is only one copy of React.
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(root, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
