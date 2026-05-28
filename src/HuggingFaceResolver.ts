/**
 * HuggingFaceResolver — resolves model identifiers into concrete download URLs.
 *
 * Supported schemes:
 *   hf://owner/repo                     → auto-discover the best .gguf in the repo
 *   hf://owner/repo/path/to/file.gguf   → direct file within the repo
 *   https://...                         → pass-through; HEAD for Content-Length
 */

export interface ResolvedModel {
  /** Final HTTP(S) download URL. */
  downloadUrl: string;
  /** Filename to use when saving locally. */
  filename: string;
  /** File size in bytes. -1 when the server does not advertise Content-Length. */
  sizeBytes: number;
}

const HF_BASE = 'https://huggingface.co';

// ─── URL parsing ──────────────────────────────────────────────────────────────

export interface ParsedHFUrl {
  owner: string;
  repo: string;
  /** Relative file path within the repo, or undefined to auto-discover. */
  filename?: string;
}

/**
 * Parse an `hf://` URL into its components.
 *
 * Examples:
 *   hf://microsoft/bitnet-b1.58-2B-4T-gguf
 *   hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf
 */
export function parseHFUrl(url: string): ParsedHFUrl {
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

// ─── HuggingFace REST API ─────────────────────────────────────────────────────

interface HFSibling {
  rfilename: string;
  size?: number;
}

interface HFModelApiResponse {
  siblings?: HFSibling[];
}

async function fetchHFSiblings(
  owner: string,
  repo: string,
  token?: string
): Promise<HFSibling[]> {
  const apiUrl = `${HF_BASE}/api/models/${owner}/${repo}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(apiUrl, { headers });
  if (!res.ok) {
    const hint =
      res.status === 401
        ? ' This model requires a HuggingFace token. Pass one via the token option or set HF_TOKEN env var.'
        : ' Check the repo ID is correct and the model is publicly accessible.';
    throw new Error(
      `HuggingFace API error ${res.status} for "${owner}/${repo}".${hint}`
    );
  }
  const data = (await res.json()) as HFModelApiResponse;
  return data.siblings ?? [];
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
export function pickBestGguf(siblings: HFSibling[]): HFSibling | undefined {
  const gguf = siblings.filter((f) => f.rfilename.endsWith('.gguf'));
  if (gguf.length === 0) return undefined;

  return (
    gguf.find((f) => f.rfilename.includes('i2_s')) ??
    gguf.find((f) => f.rfilename.toLowerCase().includes('i2')) ??
    gguf.find((f) => f.rfilename.toUpperCase().includes('Q4')) ??
    gguf.find((f) => f.rfilename.toUpperCase().includes('Q2')) ??
    gguf[0]
  );
}

// ─── Content-Length probe ─────────────────────────────────────────────────────

async function probeContentLength(url: string, token?: string): Promise<number> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(url, { method: 'HEAD', headers });
    const cl = res.headers.get('Content-Length');
    if (cl) {
      const n = parseInt(cl, 10);
      return isNaN(n) ? -1 : n;
    }
  } catch {
    // network error during HEAD — non-fatal, sizeBytes will be -1
  }
  return -1;
}

// ─── Public resolver ──────────────────────────────────────────────────────────

export interface ResolveOptions {
  /**
   * HuggingFace API token (Bearer).
   * Required for gated/private models. Falls back to the HF_TOKEN env var.
   * Get one at https://huggingface.co/settings/tokens
   */
  token?: string;
}

/**
 * Resolve a model identifier to a concrete download URL + metadata.
 *
 * @param modelId  `hf://owner/repo`, `hf://owner/repo/file.gguf`, or `https://...`
 * @param opts     Optional: `{ token }` for gated models
 */
export async function resolveModelUrl(
  modelId: string,
  opts: ResolveOptions = {}
): Promise<ResolvedModel> {
  // Read token from option or env
  const token = opts.token ?? (typeof process !== 'undefined' ? process.env['HF_TOKEN'] : undefined);

  // ── Direct HTTPS URL ──────────────────────────────────────────────────────
  if (modelId.startsWith('https://') || modelId.startsWith('http://')) {
    const parts = modelId.split('/');
    const filename = decodeURIComponent(parts[parts.length - 1] ?? 'model.gguf');
    const sizeBytes = await probeContentLength(modelId, token);
    return { downloadUrl: modelId, filename, sizeBytes };
  }

  // ── HuggingFace scheme ────────────────────────────────────────────────────
  if (!modelId.startsWith('hf://')) {
    throw new Error(
      `Unsupported model ID scheme in "${modelId}". ` +
      `Use hf://owner/repo, hf://owner/repo/file.gguf, or https://...`
    );
  }

  const { owner, repo, filename: explicitFilename } = parseHFUrl(modelId);

  if (explicitFilename) {
    const downloadUrl = `${HF_BASE}/${owner}/${repo}/resolve/main/${explicitFilename}`;
    const sizeBytes = await probeContentLength(downloadUrl, token);
    const filename = explicitFilename.split('/').pop() ?? explicitFilename;
    return { downloadUrl, filename, sizeBytes };
  }

  // Auto-discover the best GGUF in the repo
  const siblings = await fetchHFSiblings(owner, repo, token);
  const best = pickBestGguf(siblings);

  if (!best) {
    throw new Error(
      `No .gguf file found in "${owner}/${repo}". ` +
      `Specify a filename explicitly: hf://${owner}/${repo}/model.gguf`
    );
  }

  const downloadUrl = `${HF_BASE}/${owner}/${repo}/resolve/main/${best.rfilename}`;
  const filename = best.rfilename.split('/').pop() ?? best.rfilename;

  const sizeBytes = best.size != null && best.size > 0
    ? best.size
    : await probeContentLength(downloadUrl, token);

  return { downloadUrl, filename, sizeBytes };
}
