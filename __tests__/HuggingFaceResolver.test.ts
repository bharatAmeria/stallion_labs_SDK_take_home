/**
 * Unit tests for HuggingFaceResolver.
 *
 * All network calls are mocked — no real HTTP requests.
 */

import {
  parseHFUrl,
  pickBestGguf,
  resolveModelUrl,
} from '../src/HuggingFaceResolver';

// ─── Mock global fetch ────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
});

// ─── parseHFUrl ───────────────────────────────────────────────────────────────

describe('parseHFUrl', () => {
  test('parses owner/repo without filename', () => {
    const result = parseHFUrl('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
    expect(result).toEqual({
      owner: 'microsoft',
      repo: 'bitnet-b1.58-2B-4T-gguf',
      filename: undefined,
    });
  });

  test('parses owner/repo/filename.gguf', () => {
    const result = parseHFUrl('hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf');
    expect(result).toEqual({
      owner: 'microsoft',
      repo: 'bitnet-b1.58-2B-4T-gguf',
      filename: 'ggml-model-i2_s.gguf',
    });
  });

  test('parses nested file path', () => {
    const result = parseHFUrl('hf://org/repo/sub/dir/model.gguf');
    expect(result.owner).toBe('org');
    expect(result.repo).toBe('repo');
    expect(result.filename).toBe('sub/dir/model.gguf');
  });

  test('throws on non-hf:// input', () => {
    expect(() => parseHFUrl('https://example.com')).toThrow('hf://');
  });

  test('throws when repo is missing', () => {
    expect(() => parseHFUrl('hf://onlyone')).toThrow('Invalid HuggingFace URL');
  });
});

// ─── pickBestGguf ─────────────────────────────────────────────────────────────

describe('pickBestGguf', () => {
  test('prefers i2_s variant', () => {
    const siblings = [
      { rfilename: 'ggml-model-f32.gguf', size: 4000000000 },
      { rfilename: 'ggml-model-Q4_K_M.gguf', size: 1200000000 },
      { rfilename: 'ggml-model-i2_s.gguf', size: 900000000 },
    ];
    expect(pickBestGguf(siblings)?.rfilename).toBe('ggml-model-i2_s.gguf');
  });

  test('falls back to Q4 when i2_s absent', () => {
    const siblings = [
      { rfilename: 'model-f32.gguf' },
      { rfilename: 'model-Q4_K_M.gguf' },
    ];
    expect(pickBestGguf(siblings)?.rfilename).toBe('model-Q4_K_M.gguf');
  });

  test('falls back to first gguf if nothing preferred', () => {
    const siblings = [{ rfilename: 'model.gguf' }, { rfilename: 'config.json' }];
    expect(pickBestGguf(siblings)?.rfilename).toBe('model.gguf');
  });

  test('returns undefined for empty list', () => {
    expect(pickBestGguf([])).toBeUndefined();
  });

  test('ignores non-gguf files', () => {
    const siblings = [
      { rfilename: 'README.md' },
      { rfilename: 'config.json' },
    ];
    expect(pickBestGguf(siblings)).toBeUndefined();
  });
});

// ─── resolveModelUrl ──────────────────────────────────────────────────────────

describe('resolveModelUrl', () => {
  // ── Direct HTTPS URL ────────────────────────────────────────────────────────

  test('passes through https:// URL and extracts filename', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'Content-Length' ? '123456789' : null) },
    });

    const result = await resolveModelUrl('https://example.com/models/model.gguf');
    expect(result.downloadUrl).toBe('https://example.com/models/model.gguf');
    expect(result.filename).toBe('model.gguf');
    expect(result.sizeBytes).toBe(123456789);
  });

  test('returns -1 size when Content-Length absent for https://', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
    });
    const result = await resolveModelUrl('https://example.com/model.gguf');
    expect(result.sizeBytes).toBe(-1);
  });

  test('returns -1 size when HEAD request fails for https://', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const result = await resolveModelUrl('https://example.com/model.gguf');
    expect(result.sizeBytes).toBe(-1);
  });

  // ── hf:// with explicit filename ────────────────────────────────────────────

  test('builds correct download URL for hf:// with explicit filename', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'Content-Length' ? '900000000' : null) },
    });

    const result = await resolveModelUrl(
      'hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf'
    );
    expect(result.downloadUrl).toBe(
      'https://huggingface.co/microsoft/bitnet-b1.58-2B-4T-gguf/resolve/main/ggml-model-i2_s.gguf'
    );
    expect(result.filename).toBe('ggml-model-i2_s.gguf');
    expect(result.sizeBytes).toBe(900000000);
  });

  // ── hf:// with auto-discovery ───────────────────────────────────────────────

  test('discovers best gguf via HF API when no filename given', async () => {
    // 1st call: HF API
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        siblings: [
          { rfilename: 'config.json' },
          { rfilename: 'ggml-model-i2_s.gguf', size: 850000000 },
          { rfilename: 'ggml-model-Q4_K_M.gguf', size: 1200000000 },
        ],
      }),
      headers: { get: () => null },
    });
    // size from siblings, no HEAD needed

    const result = await resolveModelUrl('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
    expect(result.downloadUrl).toContain('ggml-model-i2_s.gguf');
    expect(result.filename).toBe('ggml-model-i2_s.gguf');
    expect(result.sizeBytes).toBe(850000000);
  });

  test('falls back to HEAD probe when HF API returns no size', async () => {
    // HF API — no size field
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        siblings: [{ rfilename: 'model.gguf' }], // no size
      }),
      headers: { get: () => null },
    });
    // HEAD request for Content-Length
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'Content-Length' ? '500000000' : null) },
    });

    const result = await resolveModelUrl('hf://owner/repo');
    expect(result.sizeBytes).toBe(500000000);
  });

  test('throws when HF API returns non-200', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null } });
    await expect(resolveModelUrl('hf://bad/repo')).rejects.toThrow('404');
  });

  test('throws when no gguf file found in repo', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ siblings: [{ rfilename: 'README.md' }] }),
      headers: { get: () => null },
    });
    await expect(resolveModelUrl('hf://owner/repo')).rejects.toThrow('.gguf');
  });

  test('throws on unsupported scheme', async () => {
    await expect(resolveModelUrl('ftp://some/model')).rejects.toThrow('Unsupported');
  });
});
