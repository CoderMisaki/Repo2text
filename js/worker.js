/**
 * Repo2Text Ultra — extraction worker.
 * Handles archive parsing, decompression, encoding, filtering, nested archives.
 */
/* eslint-disable no-undef */
'use strict';

var HAS_ZIPJS = false;
var HAS_JSZIP = false;
var HAS_FFLATE = false;

try {
  importScripts('./shared.js');
} catch (e) {
  try { importScripts('../js/shared.js'); } catch (e2) { /* ignore */ }
}

try {
  importScripts('../vendor/zip-inflate.min.js');
  HAS_ZIPJS = typeof zip !== 'undefined';
  if (HAS_ZIPJS && zip.configure) zip.configure({ useWebWorkers: false });
} catch (e) { HAS_ZIPJS = false; }

try {
  importScripts('../vendor/jszip.min.js');
  HAS_JSZIP = typeof JSZip !== 'undefined';
} catch (e) { HAS_JSZIP = false; }

try {
  importScripts('../vendor/fflate.min.js');
  HAS_FFLATE = typeof fflate !== 'undefined';
} catch (e) { HAS_FFLATE = false; }

var S = (self.R2T && self.R2T.shared) || {};

var state = {
  jobId: 0,
  cancelled: false,
  fatal: false,
  paused: false,
  pauseWait: null,
  continueWait: null,
  options: {},
  processed: 0,
  skipped: 0,
  bytes: 0,
  startedAt: 0
};

function resetState(jobId, options) {
  state.jobId = jobId;
  state.cancelled = false;
  state.fatal = false;
  state.paused = false;
  state.pauseWait = null;
  state.continueWait = null;
  state.options = options || {};
  state.processed = 0;
  state.skipped = 0;
  state.bytes = 0;
  state.startedAt = Date.now();
}

function post(msg) {
  msg.jobId = state.jobId;
  self.postMessage(msg);
}

function postFatal(message) {
  state.fatal = true;
  post({ type: 'error', fatal: true, message: message });
}

function CancelError() {
  this.name = 'CancelError';
  this.message = 'cancelled';
}
CancelError.prototype = Object.create(Error.prototype);

function checkCancel() {
  if (state.cancelled) throw new CancelError();
}

function waitIfPaused() {
  if (!state.paused) return Promise.resolve();
  return new Promise(function (resolve) {
    state.pauseWait = resolve;
  });
}

function waitContinue() {
  return new Promise(function (resolve) {
    state.continueWait = resolve;
    post({ type: 'await-continue' });
  }).then(function () {
    checkCancel();
    return waitIfPaused();
  });
}

async function readMagicFromBlob(blob) {
  var slice = blob.slice(0, 320);
  var buf = await slice.arrayBuffer();
  return new Uint8Array(buf);
}

async function processTextEntry(order, path, u8, extra) {
  checkCancel();
  await waitIfPaused();
  var clean = S.sanitizePath(path);
  if (!clean) {
    state.skipped++;
    post({ type: 'skipped', path: path, reason: 'nama file tidak valid' });
    return;
  }
  if (S.isAlwaysExcluded(clean)) {
    state.skipped++;
    post({ type: 'skipped', path: clean, reason: 'file sistem' });
    return;
  }
  var opts = state.options;
  if (opts.skipGenerated !== false && S.isGeneratedPath(clean, opts.generatedDirs)) {
    state.skipped++;
    post({ type: 'skipped', path: clean, reason: 'folder generated' });
    return;
  }
  if (S.isArchivePath(clean)) {
    var depth = (extra && extra.depth) || 0;
    if (opts.extractNested && depth < S.MAX_NESTED_DEPTH) {
      post({ type: 'nested', path: clean, depth: depth + 1 });
      var blob = new Blob([u8]);
      await extractArchiveBlob(blob, clean, depth + 1, extra && extra.orderBase != null ? extra.orderBase : order);
      return;
    }
    if (depth >= S.MAX_NESTED_DEPTH) {
      state.skipped++;
      post({ type: 'skipped', path: clean, reason: 'Nested archive depth exceeded safely' });
      return;
    }
    state.skipped++;
    post({ type: 'skipped', path: clean, reason: 'arsip bersarang dilewati' });
    return;
  }
  if (S.isBinaryExt(clean)) {
    state.skipped++;
    post({ type: 'skipped', path: clean, reason: 'binary' });
    return;
  }
  var decoded = S.decodeText(u8);
  if (decoded.binary) {
    state.skipped++;
    post({ type: 'skipped', path: clean, reason: 'bukan teks (binary)' });
    return;
  }
  var text = decoded.text;
  var lines = S.countLines(text);
  var bytes = u8.length;
  state.processed++;
  state.bytes += bytes;
  post({
    type: 'file',
    order: order,
    path: clean,
    text: text,
    lineCount: lines,
    byteLength: bytes,
    encoding: decoded.encoding,
    nested: !!(extra && extra.depth)
  });
  await waitContinue();
}

async function extractZipZipJS(blob, prefix, depth, orderBase) {
  var reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false });
  var entries;
  try {
    entries = await reader.getEntries();
  } catch (err) {
    await reader.close().catch(function () {});
    throw new Error('ZIP rusak atau tidak dapat dibaca: ' + (err && err.message ? err.message : String(err)));
  }
  var list = [];
  var compressedTotal = blob.size || 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    list.push({
      filename: e.filename,
      directory: e.directory,
      uncompressedSize: e.uncompressedSize || 0,
      compressedSize: e.compressedSize || 0,
      encrypted: e.encrypted,
      entry: e
    });
  }
  if (depth === 0) {
    var bomb = S.analyzeArchiveMeta(list, compressedTotal);
    post({ type: 'meta', bomb: bomb, entryCount: list.length, compressedTotal: compressedTotal, format: 'zip' });
    if (bomb.level === 'block') {
      await reader.close();
      postFatal(bomb.reason);
      return;
    }
    if (bomb.level === 'warn') {
      var proceed = await waitForDecision('suspicious', bomb);
      if (!proceed) {
        await reader.close();
        postFatal('Dibatalkan: arsip mencurigakan.');
        return;
      }
    }
  }

  var files = [];
  for (var j = 0; j < list.length; j++) {
    if (list[j].directory) continue;
    var p = (prefix ? prefix.replace(/\/?$/, '/') : '') + list[j].filename;
    var clean0 = S.sanitizePath(p);
    if (!S.isIncluded(clean0, state.options) && !S.isArchivePath(clean0)) continue;
    files.push({ path: p, item: list[j], size: list[j].uncompressedSize });
  }
  files.sort(function (a, b) {
    var sa = S.priorityScore(a.path, a.size);
    var sb = S.priorityScore(b.path, b.size);
    if (sa !== sb) return sa - sb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  var pathOrder = files.map(function (f) { return S.sanitizePath(f.path); }).sort();
  var orderMap = {};
  for (var o = 0; o < pathOrder.length; o++) orderMap[pathOrder[o]] = (orderBase || 0) + o;

  if (depth === 0) {
    post({
      type: 'plan',
      total: files.length,
      paths: pathOrder
    });
  }

  for (var k = 0; k < files.length; k++) {
    checkCancel();
    await waitIfPaused();
    var f = files[k];
    var clean = S.sanitizePath(f.path);
    post({ type: 'current', path: clean, index: k, total: files.length });
    if (f.item.encrypted) {
      state.skipped++;
      post({ type: 'skipped', path: clean, reason: 'ZIP terenkripsi' });
      continue;
    }
    if (!S.isIncluded(clean, state.options) && !S.isArchivePath(clean)) {
      state.skipped++;
      post({ type: 'skipped', path: clean, reason: 'difilter' });
      continue;
    }
    var pressure = S.memoryPressure();
    if (pressure > 0.88) {
      postFatal('Resource exhaustion: memori browser hampir penuh (' + Math.round(pressure * 100) + '%). Proses dihentikan dengan aman.' );
      await reader.close();
      return;
    }
    try {
      var writer = new zip.Uint8ArrayWriter();
      var data = await f.item.entry.getData(writer);
      var u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      var order = orderMap[clean] != null ? orderMap[clean] : (orderBase || 0) + k;
      await processTextEntry(order, clean, u8, { depth: depth, orderBase: (orderBase || 0) + files.length });
      u8 = null;
      data = null;
    } catch (err) {
      if (err instanceof CancelError) throw err;
      state.skipped++;
      post({ type: 'skipped', path: clean, reason: 'gagal didekompresi: ' + (err && err.message ? err.message : 'error') });
    }
  }
  await reader.close();
}

async function extractZipJSZip(blob, prefix, depth, orderBase) {
  if (!HAS_JSZIP) throw new Error('Library ZIP tidak tersedia.');
  var z = await JSZip.loadAsync(blob);
  var files = [];
  z.forEach(function (relativePath, zipEntry) {
    if (zipEntry.dir) return;
    var p = (prefix ? prefix.replace(/\/?$/, '/') : '') + relativePath;
    var clean0 = S.sanitizePath(p);
    if (!S.isIncluded(clean0, state.options) && !S.isArchivePath(clean0)) return;
    var raw = zipEntry._data && zipEntry._data.uncompressedSize || 0;
    files.push({ path: p, entry: zipEntry, size: raw });
  });
  if (depth === 0) {
    var bomb = S.analyzeArchiveMeta(files.map(function (f) {
      return { uncompressedSize: f.size, directory: false };
    }), blob.size || 0);
    post({ type: 'meta', bomb: bomb, entryCount: files.length, compressedTotal: blob.size || 0, format: 'zip' });
    if (bomb.level === 'block') {
      postFatal(bomb.reason);
      return;
    }
    if (bomb.level === 'warn') {
      var proceed = await waitForDecision('suspicious', bomb);
      if (!proceed) {
        postFatal('Dibatalkan: arsip mencurigakan.');
        return;
      }
    }
  }
  files.sort(function (a, b) {
    var sa = S.priorityScore(a.path, a.size);
    var sb = S.priorityScore(b.path, b.size);
    if (sa !== sb) return sa - sb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  var pathOrder = files.map(function (f) { return S.sanitizePath(f.path); }).sort();
  var orderMap = {};
  for (var o = 0; o < pathOrder.length; o++) orderMap[pathOrder[o]] = (orderBase || 0) + o;
  if (depth === 0) post({ type: 'plan', total: files.length, paths: pathOrder });

  for (var k = 0; k < files.length; k++) {
    checkCancel();
    await waitIfPaused();
    var f = files[k];
    var clean = S.sanitizePath(f.path);
    post({ type: 'current', path: clean, index: k, total: files.length });
    if (!S.isIncluded(clean, state.options) && !S.isArchivePath(clean)) {
      state.skipped++;
      post({ type: 'skipped', path: clean, reason: 'difilter' });
      continue;
    }
    try {
      var buf = await f.entry.async('uint8array');
      var order = orderMap[clean] != null ? orderMap[clean] : (orderBase || 0) + k;
      await processTextEntry(order, clean, buf, { depth: depth, orderBase: (orderBase || 0) + files.length });
    } catch (err) {
      if (err instanceof CancelError) throw err;
      state.skipped++;
      post({ type: 'skipped', path: clean, reason: 'gagal dibaca' });
    }
  }
}

async function extractTarU8(u8, prefix, depth, orderBase, compressedSize) {
  var collected = [];
  S.parseTarBuffer(u8, function (item) {
    collected.push(item);
  });
  if (depth === 0) {
    var bomb = S.analyzeArchiveMeta(collected.map(function (c) {
      return { uncompressedSize: c.size, directory: false };
    }), compressedSize || u8.length);
    post({ type: 'meta', bomb: bomb, entryCount: collected.length, compressedTotal: compressedSize || u8.length, format: 'tar' });
    if (bomb.level === 'block') {
      postFatal(bomb.reason);
      return;
    }
    if (bomb.level === 'warn') {
      var proceed = await waitForDecision('suspicious', bomb);
      if (!proceed) {
        postFatal('Dibatalkan: arsip mencurigakan.');
        return;
      }
    }
  }
  var files = [];
  for (var ti = 0; ti < collected.length; ti++) {
    var c = collected[ti];
    var p = (prefix ? prefix.replace(/\/?$/, '/') : '') + c.path;
    var clean0 = S.sanitizePath(p);
    if (!S.isIncluded(clean0, state.options) && !S.isArchivePath(clean0)) continue;
    files.push({ path: p, data: c.data, size: c.size });
  }
  files.sort(function (a, b) {
    var sa = S.priorityScore(a.path, a.size);
    var sb = S.priorityScore(b.path, b.size);
    if (sa !== sb) return sa - sb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  var pathOrder = files.map(function (f) { return S.sanitizePath(f.path); }).sort();
  var orderMap = {};
  for (var o = 0; o < pathOrder.length; o++) orderMap[pathOrder[o]] = (orderBase || 0) + o;
  if (depth === 0) post({ type: 'plan', total: files.length, paths: pathOrder });

  for (var k = 0; k < files.length; k++) {
    checkCancel();
    await waitIfPaused();
    var f = files[k];
    var clean = S.sanitizePath(f.path);
    post({ type: 'current', path: clean, index: k, total: files.length });
    if (!S.isIncluded(clean, state.options) && !S.isArchivePath(clean)) {
      state.skipped++;
      post({ type: 'skipped', path: clean, reason: 'difilter' });
      continue;
    }
    var order = orderMap[clean] != null ? orderMap[clean] : (orderBase || 0) + k;
    await processTextEntry(order, clean, f.data, { depth: depth, orderBase: (orderBase || 0) + files.length });
    f.data = null;
  }
}

async function gunzipBlob(blob) {
  if (!HAS_FFLATE) throw new Error('Library GZIP (fflate) tidak tersedia di worker.');
  var CHUNK = 1024 * 1024;
  var parts = [];
  var total = 0;
  await new Promise(function (resolve, reject) {
    var gz = new fflate.Gunzip(function (chunk, final) {
      if (chunk && chunk.length) {
        parts.push(chunk);
        total += chunk.length;
        var pressure = S.memoryPressure();
        if (pressure > 0.9) {
          try { gz.terminate && gz.terminate(); } catch (e) {}
          reject(new Error('Resource exhaustion: dekompresi GZIP melebihi memori perangkat.'));
          return;
        }
      }
      if (final) resolve();
    });
    var offset = 0;
    function pump() {
      if (state.cancelled) {
        reject(new CancelError());
        return;
      }
      if (offset >= blob.size) {
        try { gz.push(new Uint8Array(0), true); } catch (e) { reject(e); }
        return;
      }
      var end = Math.min(offset + CHUNK, blob.size);
      blob.slice(offset, end).arrayBuffer().then(function (buf) {
        offset = end;
        try {
          gz.push(new Uint8Array(buf), offset >= blob.size);
          if (offset < blob.size) {
            setTimeout(pump, 0);
          }
        } catch (err) {
          reject(err);
        }
      }).catch(reject);
    }
    pump();
  });
  if (parts.length === 1) return parts[0];
  var out = new Uint8Array(total);
  var o = 0;
  for (var i = 0; i < parts.length; i++) {
    out.set(parts[i], o);
    o += parts[i].length;
    parts[i] = null;
  }
  return out;
}

async function extractArchiveBlob(blob, name, depth, orderBase) {
  depth = depth || 0;
  orderBase = orderBase || 0;
  var magic = await readMagicFromBlob(blob);
  var format = S.detectFormat(name, magic);
  post({ type: 'format', format: format, name: name, depth: depth });

  if (format === '7z' || format === 'rar' || format === 'unsupported') {
    if (depth === 0) {
      postFatal('Format ' + String(format).toUpperCase() + ' tidak dapat diproses di browser ini (tidak ada decoder client-side yang aman). Gunakan ZIP, TAR, atau TAR.GZ.'
      );
    } else {
      state.skipped++;
      post({ type: 'skipped', path: name, reason: 'format ' + format + ' tidak didukung' });
    }
    return;
  }

  if (format === 'zip' || format === 'unknown' && /\.zip$/i.test(name)) {
    if (HAS_ZIPJS) {
      try {
        await extractZipZipJS(blob, depth > 0 ? name.replace(/\.(zip)$/i, '') : '', depth, orderBase);
        return;
      } catch (err) {
        if (err instanceof CancelError) throw err;
        if (!HAS_JSZIP) throw err;
        post({ type: 'warning', message: 'zip.js gagal (' + err.message + '), memakai JSZip.' });
      }
    }
    await extractZipJSZip(blob, depth > 0 ? name.replace(/\.(zip)$/i, '') : '', depth, orderBase);
    return;
  }

  if (format === 'tar') {
    var tarBuf = new Uint8Array(await blob.arrayBuffer());
    await extractTarU8(tarBuf, depth > 0 ? name.replace(/\.tar$/i, '') : '', depth, orderBase, blob.size);
    return;
  }

  if (format === 'tar.gz' || format === 'gz') {
    var unzipped = await gunzipBlob(blob);
    var innerMagic = [];
    for (var i = 0; i < Math.min(320, unzipped.length); i++) innerMagic.push(unzipped[i]);
    var inner = S.detectFormat(name.replace(/\.gz$/i, ''), innerMagic);
    var looksTar = inner === 'tar' || /\.tar(\.gz)?$/i.test(name) || /\.tgz$/i.test(name);
    if (looksTar) {
      await extractTarU8(unzipped, depth > 0 ? name.replace(/\.tar\.gz$|\.tgz$/i, '') : '', depth, orderBase, blob.size);
    } else {
      var innerName = name.replace(/\.gz$/i, '');
      if (depth === 0) post({ type: 'plan', total: 1, paths: [S.sanitizePath(innerName)] });
      await processTextEntry(orderBase, innerName, unzipped, { depth: depth });
    }
    return;
  }

  if (format === 'unknown') {
    var asText = S.decodeText(new Uint8Array(await blob.arrayBuffer()));
    if (!asText.binary) {
      if (depth === 0) post({ type: 'plan', total: 1, paths: [S.sanitizePath(name)] });
      await processTextEntry(orderBase, name, new TextEncoder().encode(asText.text), { depth: depth });
      return;
    }
    postFatal('Format arsip tidak dikenali. Dukung: ZIP, TAR, TAR.GZ / TGZ, GZ.'
    );
  }
}

var pendingDecision = null;

function waitForDecision(kind, payload) {
  return new Promise(function (resolve) {
    pendingDecision = resolve;
    post({ type: 'decision', kind: kind, payload: payload });
  });
}

async function processBytesJob(msg) {
  var u8 = msg.buffer ? new Uint8Array(msg.buffer) : (msg.text != null ? new TextEncoder().encode(msg.text) : new Uint8Array(0));
  await processTextEntry(msg.order || 0, msg.path, u8, { depth: 0 });
  post({ type: 'item-done', path: msg.path, order: msg.order });
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (msg.type === 'cancel') {
    state.cancelled = true;
    if (state.continueWait) { var c = state.continueWait; state.continueWait = null; c(); }
    if (state.pauseWait) { var p = state.pauseWait; state.pauseWait = null; p(); }
    if (pendingDecision) { var d = pendingDecision; pendingDecision = null; d(false); }
    return;
  }
  if (msg.type === 'pause') {
    state.paused = true;
    return;
  }
  if (msg.type === 'resume') {
    state.paused = false;
    if (state.pauseWait) { var r = state.pauseWait; state.pauseWait = null; r(); }
    return;
  }
  if (msg.type === 'continue') {
    if (msg.jobId != null && msg.jobId !== state.jobId) return;
    if (state.continueWait) { var w = state.continueWait; state.continueWait = null; w(); }
    return;
  }
  if (msg.type === 'decision-result') {
    if (pendingDecision) { var dec = pendingDecision; pendingDecision = null; dec(!!msg.proceed); }
    return;
  }

  (async function () {
    try {
      if (msg.type === 'ping') {
        post({
          type: 'ready',
          libs: { zipjs: HAS_ZIPJS, jszip: HAS_JSZIP, fflate: HAS_FFLATE }
        });
        return;
      }
      if (msg.type === 'open-archive') {
        resetState(msg.jobId, msg.options || {});
        post({ type: 'started', kind: 'archive' });
        await extractArchiveBlob(msg.file, msg.name || (msg.file && msg.file.name) || 'archive.zip', 0, 0);
        if (state.fatal || state.cancelled) return;
        checkCancel();
        post({
          type: 'done',
          processed: state.processed,
          skipped: state.skipped,
          bytes: state.bytes,
          elapsed: Date.now() - state.startedAt
        });
        return;
      }
      if (msg.type === 'process-bytes') {
        if (msg.jobId != null) state.jobId = msg.jobId;
        state.options = msg.options || state.options;
        state.cancelled = false;
        await processBytesJob(msg);
        return;
      }
    } catch (err) {
      if (err instanceof CancelError || (err && err.name === 'CancelError')) {
        post({ type: 'cancelled' });
        return;
      }
      postFatal(err && err.message ? err.message : String(err)
      );
    }
  })();
};

self.postMessage({
  type: 'boot',
  libs: { zipjs: HAS_ZIPJS, jszip: HAS_JSZIP, fflate: HAS_FFLATE }
});
