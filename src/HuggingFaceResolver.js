/**
 * HuggingFaceResolver — resolves model identifiers into concrete download URLs.
 *
 * Supported schemes:
 *   hf://owner/repo                     → auto-discover the best .gguf in the repo
 *   hf://owner/repo/path/to/file.gguf   → direct file within the repo
 *   https://...                         → pass-through; HEAD for Content-Length
 */
const HF_BASE = 'https://huggingface.co';
/**
 * Parse an `hf://` URL into its components.
 *
 * Examples:
 *   hf://microsoft/bitnet-b1.58-2B-4T-bf16-GGUF
 *   hf://microsoft/bitnet-b1.58-2B-4T-bf16-GGUF/ggml-model-i2_s.gguf
 */
export function parseHFUrl(url) {
    if (!url.startsWith('hf://')) {
        throw new Error(`parseHFUrl: expected hf:// scheme, got "${url}"`);
    }
    const withoutScheme = url.slice('hf://'.length);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx === -1) {
        throw new Error(`Invalid HuggingFace URL — expected "hf://owner/repo": ${url}`);
    }
    const owner = withoutScheme.slice(0, slashIdx);
    const rest = withoutScheme.slice(slashIdx + 1);
    const repoEnd = rest.indexOf('/');
    if (repoEnd === -1) {
        return { owner, repo: rest };
    }
    const repo = rest.slice(0, repoEnd);
    const filename = rest.slice(repoEnd + 1) || undefined;
    return { owner, repo, filename };
}
async function fetchHFSiblings(owner, repo) {
    var _a;
    const apiUrl = `${HF_BASE}/api/models/${owner}/${repo}`;
    const res = await fetch(apiUrl, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`HuggingFace API error ${res.status} for "${owner}/${repo}". ` +
            `Check the repo ID is correct and the model is publicly accessible.`);
    }
    const data = (await res.json());
    return (_a = data.siblings) !== null && _a !== void 0 ? _a : [];
}
/**
 * Pick the best .gguf file for mobile deployment.
 *
 * Priority (highest → lowest):
 *   1. i2_s  — BitNet 1.58-bit packed kernel (fastest on arm64)
 *   2. i2    — any other 1.58-bit format
 *   3. Q4    — 4-bit quantised (common fallback)
 *   4. Q2    — 2-bit quantised
 *   5. first .gguf found
 */
export function pickBestGguf(siblings) {
    var _a, _b, _c, _d;
    const gguf = siblings.filter((f) => f.rfilename.endsWith('.gguf'));
    if (gguf.length === 0)
        return undefined;
    return ((_d = (_c = (_b = (_a = gguf.find((f) => f.rfilename.includes('i2_s'))) !== null && _a !== void 0 ? _a : gguf.find((f) => f.rfilename.toLowerCase().includes('i2'))) !== null && _b !== void 0 ? _b : gguf.find((f) => f.rfilename.toUpperCase().includes('Q4'))) !== null && _c !== void 0 ? _c : gguf.find((f) => f.rfilename.toUpperCase().includes('Q2'))) !== null && _d !== void 0 ? _d : gguf[0]);
}
// ─── Content-Length probe ─────────────────────────────────────────────────────
async function probeContentLength(url) {
    try {
        const res = await fetch(url, { method: 'HEAD' });
        const cl = res.headers.get('Content-Length');
        if (cl) {
            const n = parseInt(cl, 10);
            return isNaN(n) ? -1 : n;
        }
    }
    catch (_a) {
        // network error during HEAD — non-fatal, sizeBytes will be -1
    }
    return -1;
}
// ─── Public resolver ──────────────────────────────────────────────────────────
/**
 * Resolve a model identifier to a concrete download URL + metadata.
 *
 * @param modelId  `hf://owner/repo`, `hf://owner/repo/file.gguf`, or `https://...`
 */
export async function resolveModelUrl(modelId) {
    var _a, _b, _c;
    // ── Direct HTTPS URL ──────────────────────────────────────────────────────
    if (modelId.startsWith('https://') || modelId.startsWith('http://')) {
        const parts = modelId.split('/');
        const filename = decodeURIComponent((_a = parts[parts.length - 1]) !== null && _a !== void 0 ? _a : 'model.gguf');
        const sizeBytes = await probeContentLength(modelId);
        return { downloadUrl: modelId, filename, sizeBytes };
    }
    // ── HuggingFace scheme ────────────────────────────────────────────────────
    if (!modelId.startsWith('hf://')) {
        throw new Error(`Unsupported model ID scheme in "${modelId}". ` +
            `Use hf://owner/repo, hf://owner/repo/file.gguf, or https://...`);
    }
    const { owner, repo, filename: explicitFilename } = parseHFUrl(modelId);
    if (explicitFilename) {
        // Explicit file — build URL directly
        const downloadUrl = `${HF_BASE}/${owner}/${repo}/resolve/main/${explicitFilename}`;
        const sizeBytes = await probeContentLength(downloadUrl);
        const filename = (_b = explicitFilename.split('/').pop()) !== null && _b !== void 0 ? _b : explicitFilename;
        return { downloadUrl, filename, sizeBytes };
    }
    // Auto-discover the best GGUF in the repo
    const siblings = await fetchHFSiblings(owner, repo);
    const best = pickBestGguf(siblings);
    if (!best) {
        throw new Error(`No .gguf file found in "${owner}/${repo}". ` +
            `Specify a filename explicitly: hf://${owner}/${repo}/model.gguf`);
    }
    const downloadUrl = `${HF_BASE}/${owner}/${repo}/resolve/main/${best.rfilename}`;
    const filename = (_c = best.rfilename.split('/').pop()) !== null && _c !== void 0 ? _c : best.rfilename;
    // Use size from HF API if available; fall back to HEAD probe
    const sizeBytes = best.size != null && best.size > 0
        ? best.size
        : await probeContentLength(downloadUrl);
    return { downloadUrl, filename, sizeBytes };
}
