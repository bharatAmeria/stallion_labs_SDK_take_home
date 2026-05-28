/**
 * Manual Jest mock for react-native-blob-util.
 *
 * react-native-blob-util is a peer dependency with native code — it is never
 * installed in the test environment. This stub satisfies the require() inside
 * DownloadAdapter.createRNBFAdapter() so the module graph can load without errors.
 *
 * Integration tests that exercise real downloads inject their own Node.js
 * DownloadAdapter and never call createRNBFAdapter(), so this stub is never
 * actually called at runtime.
 */

const stub = {
  fs: {
    dirs: { DocumentDir: '/mock-doc-dir', CacheDir: '/mock-cache-dir' },
    exists: jest.fn().mockResolvedValue(false),
    stat: jest.fn().mockResolvedValue({ size: 0 }),
    mkdir: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue('[]'),
    writeFile: jest.fn().mockResolvedValue(undefined),
    mv: jest.fn().mockResolvedValue(undefined),
    ls: jest.fn().mockResolvedValue([]),
  },
  config: jest.fn().mockReturnValue({
    fetch: jest.fn().mockReturnValue({
      progress: jest.fn().mockReturnThis(),
      then: jest.fn(),
      cancel: jest.fn(),
    }),
  }),
};

module.exports = { default: stub, __esModule: true };
