/**
 * run-stage2.js  —  Stage 2 live demo
 *
 * Commands
 * ─────────────────────────────────────────────────
 *   node run-stage2.js              → download model (shows live progress)
 *   node run-stage2.js --list       → list downloaded models
 *   node run-stage2.js --delete     → delete the downloaded model
 *   node run-stage2.js --resolve    → just resolve the HF URL (no download)
 */

'use strict';

const fs   = require('fs');
const fsP  = require('fs/promises');
const path = require('path');
const https = require('https');
const http  = require('http');

const { resolveModelUrl } = require('./dist/HuggingFaceResolver');
const { ModelManager }    = require('./dist/ModelManager');

// ── Node.js DownloadAdapter ───────────────────────────────────────────────────

const MODELS_DIR = path.join(__dirname, 'downloaded-models');

const nodeAdapter = {
  getDocumentDir: () => MODELS_DIR,

  async exists(p) {
    try { await fsP.access(p); return true; } catch { return false; }
  },
  async stat(p) {
    const s = await fsP.stat(p);
    return { size: s.size };
  },
  async mkdir(p)        { await fsP.mkdir(p, { recursive: true }); },
  async unlink(p)       { await fsP.unlink(p); },
  async readFile(p)     { return fsP.readFile(p, 'utf8'); },
  async writeFile(p, c) { await fsP.writeFile(p, c, 'utf8'); },
  async move(src, dst)  { await fsP.rename(src, dst); },

  downloadFile({ url, destPath, headers = {}, appendData = false, onProgress }) {
    let cancelled = false;
    let activeReq = null;

    const task = { cancel() { cancelled = true; activeReq?.destroy(); } };

    const done = new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(destPath, { flags: appendData ? 'a' : 'w' });
      let received = 0;

      function request(reqUrl) {
        const mod = reqUrl.startsWith('https') ? https : http;
        activeReq = mod.get(reqUrl, { headers }, (res) => {
          // Follow redirects
          if ([301, 302, 307, 308].includes(res.statusCode)) {
            activeReq = null;
            request(res.headers.location);
            return;
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          res.on('data', chunk => {
            if (cancelled) { activeReq?.destroy(); return; }
            received += chunk.length;
            writeStream.write(chunk);
            onProgress?.(received, total);
          });
          res.on('end', () => { writeStream.end(); resolve({ status: res.statusCode }); });
          res.on('error', e => { writeStream.destroy(); reject(e); });
        });
        activeReq.on('error', e => { writeStream.destroy(); reject(e); });
      }

      request(url);
    });

    return { task, done };
  },
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function progressBar(p, w = 40) {
  const n = Math.max(0, Math.min(w, Math.round(p * w)));
  return '[' + '█'.repeat(n) + '░'.repeat(w - n) + ']';
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Default model — https://huggingface.co/microsoft/bitnet-b1.58-2B-4T-gguf
const DEFAULT_MODEL_ID = 'hf://microsoft/bitnet-b1.58-2B-4T-gguf';

const rawArgs   = process.argv.slice(2);
const args      = new Set(rawArgs);

// Allow --model=hf://owner/repo or --model hf://owner/repo
const modelArg  = rawArgs.find(a => a.startsWith('--model='))?.split('=').slice(1).join('=')
               ?? rawArgs[rawArgs.indexOf('--model') + 1];
const MODEL_ID  = (modelArg && !modelArg.startsWith('--')) ? modelArg : DEFAULT_MODEL_ID;

(async () => {
  const manager = new ModelManager(nodeAdapter);

  // ── --resolve: just print the download URL ──────────────────────────────
  if (args.has('--resolve')) {
    console.log('\n  Resolving HuggingFace URL ...\n');
    const r = await resolveModelUrl(MODEL_ID);
    console.log('  Model ID   :', MODEL_ID);
    console.log('  File       :', r.filename);
    console.log('  Size       :', r.sizeBytes > 0 ? fmtBytes(r.sizeBytes) : 'unknown');
    console.log('  Download   :', r.downloadUrl);
    console.log();
    return;
  }

  // ── --list: show downloaded models ──────────────────────────────────────
  if (args.has('--list')) {
    const models = await manager.listModels();
    console.log();
    if (!models.length) {
      console.log('  No models downloaded yet.\n');
    } else {
      console.log('  Downloaded models:\n');
      for (const m of models) {
        console.log('  ●', m.id);
        console.log('    Path  :', m.localPath);
        console.log('    Size  :', fmtBytes(m.sizeBytes));
        console.log('    Status:', m.status);
        console.log();
      }
      const st = await manager.getStorageInfo();
      console.log('  Total:', fmtBytes(st.totalBytes), 'across', st.modelCount, 'model(s)');
    }
    console.log();
    return;
  }

  // ── --delete: remove the model ───────────────────────────────────────────
  if (args.has('--delete')) {
    if (!(await manager.isDownloaded(MODEL_ID))) {
      console.log('\n  Model not found — nothing to delete.\n');
      return;
    }
    await manager.deleteModel(MODEL_ID);
    console.log('\n  ✅  Model deleted.\n');
    return;
  }

  // ── Default: download ────────────────────────────────────────────────────
  console.log('\n  ════════════════════════════════════════════════');
  console.log('   react-native-bitnet  ·  Stage 2 Demo');
  console.log('  ════════════════════════════════════════════════\n');

  if (await manager.isDownloaded(MODEL_ID)) {
    console.log('  ✅  Already downloaded:', manager.getLocalPath(MODEL_ID));
    console.log('\n  Run with --list   to see all models');
    console.log('  Run with --delete to remove it\n');
    return;
  }

  // Step 1: Resolve
  process.stdout.write('  [1/3] Resolving HuggingFace URL ...');
  let resolved;
  try {
    resolved = await resolveModelUrl(MODEL_ID);
    console.log(' ✓');
    console.log('        File :', resolved.filename);
    console.log('        Size :', resolved.sizeBytes > 0 ? fmtBytes(resolved.sizeBytes) : 'unknown');
    console.log();
  } catch (e) {
    console.log('\n  ❌  Could not resolve URL:', e.message);
    process.exit(1);
  }

  // Step 2: Download
  console.log('  [2/3] Downloading ...\n');
  const t0 = Date.now();
  let modelInfo;
  try {
    modelInfo = await manager.downloadModel(MODEL_ID, {
      onProgress({ bytesReceived, totalBytes, progress }) {
        const pct = progress >= 0 ? (progress * 100).toFixed(1).padStart(5) + '%' : '  ?%';
        const bar = progressBar(progress >= 0 ? progress : 0);
        const rcv = fmtBytes(bytesReceived).padStart(9);
        const tot = totalBytes > 0 ? fmtBytes(totalBytes) : '???';
        process.stdout.write(`\r  ${bar} ${pct}  ${rcv} / ${tot}   `);
      },
    });
  } catch (e) {
    console.log('\n\n  ❌  Download failed:', e.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n');
  console.log('  [3/3] Verifying ...\n');
  console.log('  ✅  Download complete!');
  console.log('       Path  :', modelInfo.localPath);
  console.log('       Size  :', fmtBytes(modelInfo.sizeBytes));
  console.log('       Time  :', elapsed + 's');
  console.log();
  console.log('  isDownloaded() →', await manager.isDownloaded(MODEL_ID));
  console.log('  getLocalPath() →', manager.getLocalPath(MODEL_ID));
  console.log('\n  ════════════════════════════════════════════════\n');
})();
