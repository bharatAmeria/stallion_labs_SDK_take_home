/**
 * Shared BitNet client instance for the example app.
 *
 * Importing from here guarantees a single shared client across all screens.
 */
import { BitNetClient } from 'react-native-bitnet';

export const client = new BitNetClient({
  threads: 4,
  contextSize: 2048,
  batchSize: 512,
  maxConcurrency: 1,
});

/** The model we download + use throughout the demo. */
export const DEMO_MODEL_ID = 'hf://microsoft/bitnet-b1.58-2B-4T-gguf';

/** Human-readable short name for the demo model. */
export const DEMO_MODEL_NAME = 'BitNet b1.58 2B';
