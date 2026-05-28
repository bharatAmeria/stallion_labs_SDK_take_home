/**
 * ModelCache — persists model metadata between app restarts.
 *
 * The manifest is stored as a JSON array at:
 *   {DocumentDir}/bitnet-models/.manifest.json
 *
 * All mutations (set / remove) are immediately flushed to disk so the
 * manifest survives crashes mid-download.
 */
const MODELS_SUBDIR = 'bitnet-models';
const MANIFEST_FILENAME = '.manifest.json';
export class ModelCache {
    constructor(adapter) {
        this.models = new Map();
        this.loaded = false;
        this.adapter = adapter;
        this.modelsDir = `${adapter.getDocumentDir()}/${MODELS_SUBDIR}`;
        this.manifestPath = `${this.modelsDir}/${MANIFEST_FILENAME}`;
    }
    // ── Directory & path helpers ─────────────────────────────────────────────────
    getModelsDir() {
        return this.modelsDir;
    }
    // ── Lazy load ────────────────────────────────────────────────────────────────
    async ensureLoaded() {
        if (!this.loaded)
            await this.load();
    }
    async load() {
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
            const arr = JSON.parse(json);
            if (!Array.isArray(arr))
                throw new Error('Manifest is not an array');
            this.models = new Map(arr.map((m) => [m.id, m]));
        }
        catch (_a) {
            // Corrupt manifest — start fresh
            this.models = new Map();
        }
        this.loaded = true;
    }
    // ── Persist ──────────────────────────────────────────────────────────────────
    async save() {
        const arr = Array.from(this.models.values());
        await this.adapter.writeFile(this.manifestPath, JSON.stringify(arr, null, 2));
    }
    // ── CRUD ─────────────────────────────────────────────────────────────────────
    get(id) {
        return this.models.get(id);
    }
    getAll() {
        return Array.from(this.models.values());
    }
    async set(id, info) {
        await this.ensureLoaded();
        this.models.set(id, info);
        await this.save();
    }
    async remove(id) {
        await this.ensureLoaded();
        this.models.delete(id);
        await this.save();
    }
}
