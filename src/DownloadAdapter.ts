/**
 * DownloadAdapter — abstracts file-system I/O and HTTP downloads.
 *
 * Having this interface makes ModelManager fully testable without a device:
 * tests inject a mock adapter; production uses createRNBFAdapter() which
 * delegates to react-native-blob-util.
 *
 * react-native-blob-util is required here because it:
 *  • streams multi-GB files directly to disk (no JS memory buffering)
 *  • supports resume via appendData + Range headers
 *  • exposes real-time progress events at configurable intervals
 */

// ─── Interface ────────────────────────────────────────────────────────────────

export interface FileStat {
  /** File size in bytes. */
  size: number;
}

export interface DownloadTask {
  /** Cancel an in-progress download. Safe to call after completion. */
  cancel(): void;
}

export interface DownloadResult {
  /** HTTP status code (200 or 206 for partial content / resume). */
  status: number;
}

export interface DownloadFileParams {
  /** Remote URL to fetch. */
  url: string;
  /** Absolute local path to write the file to. */
  destPath: string;
  /** Extra request headers (e.g. `Authorization`, `Range`). */
  headers?: Record<string, string>;
  /** If true, bytes are appended to an existing file (used for resume). */
  appendData?: boolean;
  /**
   * Progress callback. `received` and `total` are bytes for *this* request
   * (not the full file when resuming). Caller adjusts with the resume offset.
   */
  onProgress?: (received: number, total: number) => void;
}

export interface DownloadAdapter {
  // ── File system ─────────────────────────────────────────────────────────────
  /** Absolute path to the platform documents directory. */
  getDocumentDir(): string;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  /** Create directory (and parents). No-op if already exists. */
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Rename / move a file. */
  move(src: string, dest: string): Promise<void>;

  // ── HTTP download ────────────────────────────────────────────────────────────
  /**
   * Start a file download.
   * Returns a {@link DownloadTask} for cancellation and a Promise that resolves
   * with the HTTP result when the download completes.
   */
  downloadFile(params: DownloadFileParams): {
    task: DownloadTask;
    done: Promise<DownloadResult>;
  };
}

// ─── react-native-blob-util adapter ──────────────────────────────────────────

/**
 * Create the production adapter backed by react-native-blob-util.
 *
 * The require() is deferred inside the function so Jest can import this module
 * without react-native-blob-util being installed in the test environment.
 */
export function createRNBFAdapter(): DownloadAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RNBF = (require('react-native-blob-util') as { default: unknown }).default as {
    fs: {
      dirs: { DocumentDir: string };
      exists(path: string): Promise<boolean>;
      stat(path: string): Promise<{ size: number | string }>;
      mkdir(path: string): Promise<void>;
      unlink(path: string): Promise<void>;
      readFile(path: string, encoding: string): Promise<string>;
      writeFile(path: string, content: string, encoding: string): Promise<void>;
      mv(src: string, dest: string): Promise<void>;
    };
    config(opts: {
      path: string;
      appendData?: boolean;
      timeout?: number;
    }): {
      fetch(
        method: string,
        url: string,
        headers: Record<string, string>
      ): {
        progress(
          opts: { interval?: number },
          cb: (received: number, total: number) => void
        ): void;
        then(onFulfilled: (res: {
          info(): { status: number };
          path(): string;
        }) => void, onRejected?: (e: unknown) => void): void;
        cancel(reason?: string): void;
      };
    };
  };

  return {
    getDocumentDir() {
      return RNBF.fs.dirs.DocumentDir;
    },

    async exists(path) {
      return RNBF.fs.exists(path);
    },

    async stat(path) {
      const s = await RNBF.fs.stat(path);
      return { size: Number(s.size) };
    },

    async mkdir(path) {
      try {
        await RNBF.fs.mkdir(path);
      } catch {
        // ignore EEXIST
      }
    },

    async unlink(path) {
      return RNBF.fs.unlink(path);
    },

    async readFile(path) {
      return RNBF.fs.readFile(path, 'utf8');
    },

    async writeFile(path, content) {
      return RNBF.fs.writeFile(path, content, 'utf8');
    },

    async move(src, dest) {
      return RNBF.fs.mv(src, dest);
    },

    downloadFile({ url, destPath, headers = {}, appendData = false, onProgress }) {
      const rnbfTask = RNBF.config({
        path: destPath,
        appendData,
        timeout: 0, // no timeout for large model files
      }).fetch('GET', url, headers);

      if (onProgress) {
        rnbfTask.progress({ interval: 500 }, onProgress);
      }

      let cancelFn: () => void = () => {};

      const done = new Promise<DownloadResult>((resolve, reject) => {
        cancelFn = () => rnbfTask.cancel('User cancelled');

        rnbfTask.then(
          (res) => resolve({ status: res.info().status }),
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.toLowerCase().includes('cancel')) {
              // Wrap as a recognisable sentinel so ModelManager can detect it
              reject(new DownloadCancelledError());
            } else {
              reject(err);
            }
          }
        );
      });

      return {
        task: { cancel: () => cancelFn() },
        done,
      };
    },
  };
}

// ─── Sentinel error ───────────────────────────────────────────────────────────

/** Thrown (and caught) internally when the user cancels a download. */
export class DownloadCancelledError extends Error {
  constructor() {
    super('Download was cancelled');
    this.name = 'DownloadCancelledError';
    Object.setPrototypeOf(this, DownloadCancelledError.prototype);
  }
}
