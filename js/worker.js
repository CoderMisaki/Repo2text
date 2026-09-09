/*
 * Repo2Text Ultra — parallel high-throughput extraction worker.
 * Decompresses multiple ZIP entries concurrently inside the worker while
 * keeping bounded memory pressure and lightweight progress reporting.
 */
/* eslint-disable no-undef */
'use strict';

var HAS_ZIPJS = false;
var HAS_JSZIP = false;
var HAS_FFLATE = false;
try { importScripts('./shared.js'); } catch (e) { try { importScripts('../js/shared.js'); } catch (e2) {} }
try { importScripts('../vendor/zip-inflate.min.js'); HAS_ZIPJS = typeof zip !== 'undefined'; if (HAS_ZIPJS && zip.configure) zip.configure({ useWebWorkers: false }); } catch (e3) {}
try { importScripts('../vendor/jszip.min.js'); HAS_JSZIP = typeof JSZip !== 'undefined'; } catch (e4) {}
try { importScripts('../vendor/fflate.min.js'); HAS_FFLATE = typeof fflate !== 'undefined'; } catch (e5) {}

var S = (self.R2T && self.R2T.shared) || {};
var CPU = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
var ZIP_CONCURRENCY = Math.max(2, Math.min(6, CPU - 1));
var CURRENT_EVERY = 16;
var YIELD_EVERY = 24;
var state = { jobId: 0, cancelled: false, fatal: false, paused: false, pauseWait: null, options: {}, processed: 0, skipped: 0, bytes: 0, startedAt: 0, currentCount: 0, yieldCount: 0 };
var pendingDecision = null;

function resetState(jobId, options) {
  state.jobId = jobId; state.cancelled = false; state.fatal = false; state.paused = false;
  state.pauseWait = null; state.options = options || {}; state.processed = 0; state.skipped = 0;
  state.bytes = 0; state.startedAt = Date.now(); state.currentCount = 0; state.yieldCount = 0;
}
function post(msg) { msg.jobId = state.jobId; self.postMessage(msg); }
function postFatal(message) { state.fatal = true; post({ type: 'error', fatal: true, message: message }); }
function CancelError() { this.name = 'CancelError'; this.message = 'cancelled'; }
CancelError.prototype = Object.create(Error.prototype);
function checkCancel() { if (state.cancelled) throw new CancelError(); }
function waitIfPaused() { if (!state.paused) return Promise.resolve(); return new Promise(function (resolve) { state.pauseWait = resolve; }); }
function yieldWorker() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }
async function cooperativePoint() {
  checkCancel(); await waitIfPaused();
  state.yieldCount++;
  if (state.yieldCount >= YIELD_EVERY) { state.yieldCount = 0; await yieldWorker(); }
}
function postCurrent(path, index, total) {
  state.currentCount++;
  if (state.currentCount % CURRENT_EVERY === 0 || index === 0 || index + 1 === total) post({ type: 'current', path: path, index: index, total: total });
}
function waitForDecision(kind, payload) { return new Promise(function (resolve) { pendingDecision = resolve; post({ type: 'decision', kind: kind, payload: payload }); }); }
async function readMagicFromBlob(blob) { return new Uint8Array(await blob.slice(0, 320).arrayBuffer()); }

async function processTextEntry(order, path, u8, extra) {
  await cooperativePoint();
  var clean = S.sanitizePath(path), opts = state.options;
  if (!clean) { state.skipped++; post({ type: 'skipped', path: path, reason: 'nama file tidak valid' }); return; }
  if (S.isAlwaysExcluded(clean)) { state.skipped++; post({ type: 'skipped', path: clean, reason: 'file sistem' }); return; }
  if (opts.skipGenerated !== false && S.isGeneratedPath(clean, opts.generatedDirs)) { state.skipped++; post({ type: 'skipped', path: clean, reason: 'folder generated' }); return; }
  if (S.isArchivePath(clean)) {
    var depth = (extra && extra.depth) || 0;
    if (opts.extractNested && depth < S.MAX_NESTED_DEPTH) {
      post({ type: 'nested', path: clean, depth: depth + 1 });
      await extractArchiveBlob(new Blob([u8]), clean, depth + 1, extra && extra.orderBase != null ? extra.orderBase : order);
      return;
    }
    state.skipped++; post({ type: 'skipped', path: clean, reason: depth >= S.MAX_NESTED_DEPTH ? 'Nested archive depth exceeded safely' : 'arsip bersarang dilewati' }); return;
  }
  if (S.isBinaryExt(clean)) { state.skipped++; post({ type: 'skipped', path: clean, reason: 'binary' }); return; }
  var decoded = S.decodeText(u8);
  if (decoded.binary) { state.skipped++; post({ type: 'skipped', path: clean, reason: 'bukan teks (binary)' }); return; }
  var text = decoded.text, bytes = u8.length;
  state.processed++; state.bytes += bytes;
  post({ type: 'file', order: order, path: clean, text: text, lineCount: S.countLines(text), byteLength: bytes, encoding: decoded.encoding, nested: !!(extra && extra.depth) });
}

function buildFilesFromZipEntries(entries, prefix) {
  var files = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]; if (e.directory) continue;
    var p = (prefix ? prefix.replace(/\/?$/, '/') : '') + e.filename;
    var clean = S.sanitizePath(p);
    if (!S.isIncluded(clean, state.options) && !S.isArchivePath(clean)) continue;
    files.push({ path: p, item: e, size: e.uncompressedSize || 0 });
  }
  return files;
}
function sortFiles(files) {
  files.sort(function (a, b) {
    var sa = S.priorityScore(a.path, a.size), sb = S.priorityScore(b.path, b.size);
    if (sa !== sb) return sa - sb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  var paths = files.map(function (f) { return S.sanitizePath(f.path); }).sort(), orderMap = {};
  for (var i = 0; i < paths.length; i++) orderMap[paths[i]] = i;
  return { paths: paths, orderMap: orderMap };
}

async function runConcurrent(items, limit, handler) {
  var next = 0, active = 0, firstError = null;
  return new Promise(function (resolve, reject) {
    function pump() {
      if (firstError) { if (!active) reject(firstError); return; }
      if (state.cancelled) { if (!active) reject(new CancelError()); return; }
      while (active < limit && next < items.length) {
        var idx = next++, item = items[idx]; active++;
        Promise.resolve().then(function (i, x) { return handler(x, i); }.bind(null, idx, item))
          .catch(function (err) { if (err instanceof CancelError || (err && err.fatal)) firstError = err; else if (!firstError) post({ type: 'warning', message: err && err.message ? err.message : 'Gagal membaca file' }); })
          .then(function () { active--; pump(); });
      }
      if (!active && next >= items.length) resolve();
    }
    pump();
  });
}

async function extractZipZipJS(blob, prefix, depth, orderBase) {
  var reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false }), entries;
  try { entries = await reader.getEntries(); } catch (err) { await reader.close().catch(function () {}); throw new Error('ZIP rusak atau tidak dapat dibaca: ' + (err && err.message ? err.message : String(err))); }
  var list = [];
  for (var i = 0; i < entries.length; i++) { var e = entries[i]; list.push({ filename: e.filename, directory: e.directory, uncompressedSize: e.uncompressedSize || 0, compressedSize: e.compressedSize || 0, encrypted: e.encrypted, entry: e }); }
  if (depth === 0) {
    var bomb = S.analyzeArchiveMeta(list, blob.size || 0); post({ type: 'meta', bomb: bomb, entryCount: list.length, compressedTotal: blob.size || 0, format: 'zip' });
    if (bomb.level === 'block') { await reader.close(); postFatal(bomb.reason); return; }
    if (bomb.level === 'warn' && !(await waitForDecision('suspicious', bomb))) { await reader.close(); postFatal('Dibatalkan: arsip mencurigakan.'); return; }
  }
  var files = buildFilesFromZipEntries(list, prefix), plan = sortFiles(files);
  if (depth === 0) post({ type: 'plan', total: files.length, paths: plan.paths });
  try {
    await runConcurrent(files, ZIP_CONCURRENCY, async function (f, k) {
      await cooperativePoint();
      var clean = S.sanitizePath(f.path); postCurrent(clean, k, files.length);
      if (f.item.encrypted) { state.skipped++; post({ type: 'skipped', path: clean, reason: 'ZIP terenkripsi' }); return; }
      if (S.memoryPressure() > 0.88) { var memErr = new Error('Resource exhaustion: memori browser hampir penuh.'); memErr.fatal = true; throw memErr; }
      try {
        var data = await f.item.entry.getData(new zip.Uint8ArrayWriter());
        var u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        var order = (orderBase || 0) + (plan.orderMap[clean] != null ? plan.orderMap[clean] : k);
        await processTextEntry(order, clean, u8, { depth: depth, orderBase: (orderBase || 0) + files.length });
      } catch (err) {
        if (err instanceof CancelError) throw err;
        state.skipped++; post({ type: 'skipped', path: clean, reason: 'gagal didekompresi: ' + (err && err.message ? err.message : 'error') });
      }
    });
  } finally { await reader.close().catch(function () {}); }
}

async function extractZipJSZip(blob, prefix, depth, orderBase) {
  if (!HAS_JSZIP) throw new Error('Library ZIP tidak tersedia.');
  var z = await JSZip.loadAsync(blob), files = [];
  z.forEach(function (relativePath, entry) {
    if (entry.dir) return;
    var p = (prefix ? prefix.replace(/\/?$/, '/') : '') + relativePath, clean = S.sanitizePath(p);
    if (!S.isIncluded(clean, state.options) && !S.isArchivePath(clean)) return;
    files.push({ path: p, entry: entry, size: entry._data && entry._data.uncompressedSize || 0 });
  });
  if (depth === 0) {
    var bomb = S.analyzeArchiveMeta(files.map(function (f) { return { uncompressedSize: f.size, directory: false }; }), blob.size || 0);
    post({ type: 'meta', bomb: bomb, entryCount: files.length, compressedTotal: blob.size || 0, format: 'zip' });
    if (bomb.level === 'block') { postFatal(bomb.reason); return; }
    if (bomb.level === 'warn' && !(await waitForDecision('suspicious', bomb))) { postFatal('Dibatalkan: arsip mencurigakan.'); return; }
  }
  var plan = sortFiles(files); if (depth === 0) post({ type: 'plan', total: files.length, paths: plan.paths });
  await runConcurrent(files, ZIP_CONCURRENCY, async function (f, k) {
    await cooperativePoint();
    var clean = S.sanitizePath(f.path); postCurrent(clean, k, files.length);
    if (S.memoryPressure() > 0.88) { var memErr = new Error('Resource exhaustion: memori browser hampir penuh.'); memErr.fatal = true; throw memErr; }
    try {
      var buf = await f.entry.async('uint8array'), order = (orderBase || 0) + (plan.orderMap[clean] != null ? plan.orderMap[clean] : k);
      await processTextEntry(order, clean, buf, { depth: depth, orderBase: (orderBase || 0) + files.length });
    } catch (err) {
      if (err instanceof CancelError) throw err;
      state.skipped++; post({ type: 'skipped', path: clean, reason: 'gagal dibaca' });
    }
  });
}

async function extractTarU8(u8, prefix, depth, orderBase, compressedSize) {
  var collected = []; S.parseTarBuffer(u8, function (item) { collected.push(item); });
  if (depth === 0) {
    var bomb = S.analyzeArchiveMeta(collected.map(function (c) { return { uncompressedSize: c.size, directory: false }; }), compressedSize || u8.length);
    post({ type: 'meta', bomb: bomb, entryCount: collected.length, compressedTotal: compressedSize || u8.length, format: 'tar' });
    if (bomb.level === 'block') { postFatal(bomb.reason); return; }
    if (bomb.level === 'warn' && !(await waitForDecision('suspicious', bomb))) { postFatal('Dibatalkan: arsip mencurigakan.'); return; }
  }
  var files = [];
  for (var i = 0; i < collected.length; i++) {
    var c = collected[i], p = (prefix ? prefix.replace(/\/?$/, '/') : '') + c.path, clean = S.sanitizePath(p);
    if (!S.isIncluded(clean, state.options) && !S.isArchivePath(clean)) continue;
    files.push({ path: p, data: c.data, size: c.size });
  }
  var plan = sortFiles(files); if (depth === 0) post({ type: 'plan', total: files.length, paths: plan.paths });
  for (var k = 0; k < files.length; k++) {
    await cooperativePoint(); var f = files[k], clean2 = S.sanitizePath(f.path); postCurrent(clean2, k, files.length);
    var order = (orderBase || 0) + (plan.orderMap[clean2] != null ? plan.orderMap[clean2] : k);
    await processTextEntry(order, clean2, f.data, { depth: depth, orderBase: (orderBase || 0) + files.length }); f.data = null;
  }
}

async function gunzipBlob(blob) {
  if (!HAS_FFLATE) throw new Error('Library GZIP (fflate) tidak tersedia di worker.');
  var CHUNK = 1024 * 1024, parts = [], total = 0;
  await new Promise(function (resolve, reject) {
    var gz = new fflate.Gunzip(function (chunk, final) {
      if (chunk && chunk.length) { parts.push(chunk); total += chunk.length; if (S.memoryPressure() > 0.9) { try { gz.terminate && gz.terminate(); } catch (e) {} reject(new Error('Resource exhaustion: dekompresi GZIP melebihi memori perangkat.')); return; } }
      if (final) resolve();
    });
    var offset = 0;
    function pump() {
      if (state.cancelled) { reject(new CancelError()); return; }
      if (offset >= blob.size) { try { gz.push(new Uint8Array(0), true); } catch (e) { reject(e); } return; }
      var end = Math.min(offset + CHUNK, blob.size);
      blob.slice(offset, end).arrayBuffer().then(function (buf) { offset = end; try { gz.push(new Uint8Array(buf), offset >= blob.size); if (offset < blob.size) setTimeout(pump, 0); } catch (err) { reject(err); } }).catch(reject);
    }
    pump();
  });
  if (parts.length === 1) return parts[0];
  var out = new Uint8Array(total), off = 0;
  for (var i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; parts[i] = null; }
  return out;
}

async function extractArchiveBlob(blob, name, depth, orderBase) {
  depth = depth || 0; orderBase = orderBase || 0;
  var magic = await readMagicFromBlob(blob), format = S.detectFormat(name, magic);
  post({ type: 'format', format: format, name: name, depth: depth });
  if (format === '7z' || format === 'rar' || format === 'unsupported') {
    if (depth === 0) postFatal('Format ' + String(format).toUpperCase() + ' tidak dapat diproses di browser ini (tidak ada decoder client-side yang aman). Gunakan ZIP, TAR, atau TAR.GZ.');
    else { state.skipped++; post({ type: 'skipped', path: name, reason: 'format ' + format + ' tidak didukung' }); }
    return;
  }
  if (format === 'zip' || (format === 'unknown' && /\.zip$/i.test(name))) {
    if (HAS_ZIPJS) { try { await extractZipZipJS(blob, depth > 0 ? name.replace(/\.zip$/i, '') : '', depth, orderBase); return; } catch (err) { if (err instanceof CancelError || (err && err.fatal)) throw err; if (!HAS_JSZIP) throw err; post({ type: 'warning', message: 'zip.js gagal (' + err.message + '), memakai JSZip.' }); } }
    await extractZipJSZip(blob, depth > 0 ? name.replace(/\.zip$/i, '') : '', depth, orderBase); return;
  }
  if (format === 'tar') { await extractTarU8(new Uint8Array(await blob.arrayBuffer()), depth > 0 ? name.replace(/\.tar$/i, '') : '', depth, orderBase, blob.size); return; }
  if (format === 'tar.gz' || format === 'gz') {
    var unzipped = await gunzipBlob(blob), innerName = name.replace(/\.gz$/i, ''), innerMagic = unzipped.slice(0, 320), inner = S.detectFormat(innerName, innerMagic);
    if (inner === 'tar' || /\.tar$/i.test(innerName) || /\.tgz$/i.test(name)) await extractTarU8(unzipped, depth > 0 ? name.replace(/\.tar\.gz$|\.tgz$/i, '') : '', depth, orderBase, blob.size);
    else { if (depth === 0) post({ type: 'plan', total: 1, paths: [S.sanitizePath(innerName)] }); await processTextEntry(orderBase, innerName, unzipped, { depth: depth }); }
    return;
  }
  if (format === 'unknown') {
    var asText = S.decodeText(new Uint8Array(await blob.arrayBuffer()));
    if (!asText.binary) { if (depth === 0) post({ type: 'plan', total: 1, paths: [S.sanitizePath(name)] }); await processTextEntry(orderBase, name, new TextEncoder().encode(asText.text), { depth: depth }); return; }
    postFatal('Format arsip tidak dikenali. Dukung: ZIP, TAR, TAR.GZ / TGZ, GZ.');
  }
}

self.onmessage = function (ev) {
  var msg = ev.data || {}; if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (msg.type === 'cancel') { state.cancelled = true; if (state.pauseWait) { var p = state.pauseWait; state.pauseWait = null; p(); } if (pendingDecision) { var d = pendingDecision; pendingDecision = null; d(false); } return; }
  if (msg.type === 'pause') { state.paused = true; return; }
  if (msg.type === 'resume') { state.paused = false; if (state.pauseWait) { var r = state.pauseWait; state.pauseWait = null; r(); } return; }
  if (msg.type === 'decision-result') { if (pendingDecision) { var dec = pendingDecision; pendingDecision = null; dec(!!msg.proceed); } return; }
  (async function () {
    try {
      if (msg.type === 'ping') { post({ type: 'ready', libs: { zipjs: HAS_ZIPJS, jszip: HAS_JSZIP, fflate: HAS_FFLATE }, concurrency: ZIP_CONCURRENCY }); return; }
      if (msg.type === 'open-archive') { resetState(msg.jobId, msg.options || {}); post({ type: 'started', kind: 'archive', concurrency: ZIP_CONCURRENCY }); await extractArchiveBlob(msg.file, msg.name || (msg.file && msg.file.name) || 'archive.zip', 0, 0); if (state.fatal || state.cancelled) return; checkCancel(); post({ type: 'done', processed: state.processed, skipped: state.skipped, bytes: state.bytes, elapsed: Date.now() - state.startedAt, concurrency: ZIP_CONCURRENCY }); return; }
      if (msg.type === 'process-bytes') { if (msg.jobId != null) state.jobId = msg.jobId; state.options = msg.options || state.options; state.cancelled = false; await processTextEntry(msg.order || 0, msg.path, msg.buffer ? new Uint8Array(msg.buffer) : (msg.text != null ? new TextEncoder().encode(msg.text) : new Uint8Array(0)), { depth: 0 }); post({ type: 'item-done', path: msg.path, order: msg.order }); }
    } catch (err) { if (err instanceof CancelError || (err && err.name === 'CancelError')) { post({ type: 'cancelled' }); return; } postFatal(err && err.message ? err.message : String(err)); }
  })();
};
self.postMessage({ type: 'boot', libs: { zipjs: HAS_ZIPJS, jszip: HAS_JSZIP, fflate: HAS_FFLATE }, concurrency: ZIP_CONCURRENCY });
