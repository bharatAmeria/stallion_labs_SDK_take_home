/**
 * ModelCache — persists model metadata between app restarts.
 *
 * The manifest is stored as a JSON array at:
 *   {DocumentDir}/bitnet-models/.manifest.json
 *
 * All mutations (set / remove) are immediately flushed to disk so the
 * manifest survives crashes mid-download.
 */

import type { ModelInfo } from './types';
import type { DownloadAdapter } from './DownloadAdapter';

const MODELS_SUBDIR = 'bitnet-models';
const MANIFEST_FILENAME = '.manifest.json';

export class ModelCache {
  private readonly adapter: DownloadAdapter;
  private readonly modelsDir: string;
  private readonly manifestPath: string;
  private models: Map<string, ModelInfo> = new Map();
  private loaded = false;

  constructor(adapter: DownloadAdapter) {
    this.adapter = adapter;
    this.modelsDir = `${adapter.getDocumentDir()}/${MODELS_SUBDIR}`;
    this.manifestPath = `${this.modelsDir}/${MANIFEST_FILENAME}`;
  }

  // ── Directory & path helpers ─────────────────────────────────────────────────

  getModelsDir(): string {
    return this.modelsDir;
  }

  // ── Lazy load ────────────────────────────────────────────────────────────────

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async load(): Promise<void> {
    // Ensure the directory exists first
    await this.adapter.mkdir(this.modelsDir);

    const exists = await this.adapter.exists(this.manifestPath);
    if (!exists) {
      this.models = new Map();
      this.loaded = true;
      return;
    }

    try {
      const json = await this.adapter.readFile(this.manifestPath);
      const arr = JSON.parse(json) as ModelInfo[];
      if (!Array.isArray(arr)) throw new Error('Manifest is not an array');
      this.models = new Map(arr.map((m) => [m.id, m]));
    } catch {
      // Corrupt manifest — start fresh
      this.models = new Map();
    }

    this.loaded = true;
  }

  // ── Persist ──────────────────────────────────────────────────────────────────

  async save(): Promise<void> {
    const arr = Array.from(this.models.values());
    await this.adapter.writeFile(this.manifestPath, JSON.stringify(arr, null, 2));
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  get(id: string): ModelInfo | undefined {
    return this.models.get(id);
  }

  getAll(): ModelInfo[] {
    return Array.from(this.models.values());
  }

  async set(id: string, info: ModelInfo): Promise<void> {
    await this.ensureLoaded();
    this.models.set(id, info);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    this.models.delete(id);
    await this.save();
  }
}
