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
// ─── react-native-blob-util adapter ──────────────────────────────────────────
/**
 * Create the production adapter backed by react-native-blob-util.
 *
 * The require() is deferred inside the function so Jest can import this module
 * without react-native-blob-util being installed in the test environment.
 */
export function createRNBFAdapter() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RNBF = require('react-native-blob-util').default;
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
            }
            catch (_a) {
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
            let cancelFn = () => { };
            const done = new Promise((resolve, reject) => {
                cancelFn = () => rnbfTask.cancel('User cancelled');
                rnbfTask.then((res) => resolve({ status: res.info().status }), (err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg.toLowerCase().includes('cancel')) {
                        // Wrap as a recognisable sentinel so ModelManager can detect it
                        reject(new DownloadCancelledError());
                    }
                    else {
                        reject(err);
                    }
                });
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
