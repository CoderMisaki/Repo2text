'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var assert = require('assert');

var sharedCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared.js'), 'utf8');
var unrarCode = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'unrar-js.min.js'), 'utf8');

function readB64U8(relPath) {
  var b64 = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8').replace(/\s+/g, '');
  var buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
function readB64Buf(relPath) {
  var u8 = readB64U8(relPath);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
var wasmBinary = readB64Buf('vendor/unrar.wasm.b64');

var sandbox = {
  console: console,
  TextDecoder: TextDecoder,
  TextEncoder: TextEncoder,
  URL: URL,
  Uint8Array: Uint8Array,
  Uint32Array: Uint32Array,
  ArrayBuffer: ArrayBuffer,
  DataView: DataView,
  WebAssembly: WebAssembly,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  performance: performance
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(sharedCode, sandbox);
vm.runInContext(unrarCode, sandbox);
var S = sandbox.R2T.shared;
var NodeUnrarJS = sandbox.NodeUnrarJS;
assert.ok(NodeUnrarJS && NodeUnrarJS.createExtractorFromData, 'unrar bundle loaded');

(async function () {
  var u8 = readB64U8('tests/fixtures/sample.rar.b64');

  // 1. magic detection
  var magic = Array.prototype.slice.call(u8.subarray(0, 16));
  assert.strictEqual(S.detectFormat('sample.rar', magic), 'rar');
  assert.ok(S.isArchivePath('sample.rar'));

  // 2. list headers
  var extractor = await NodeUnrarJS.createExtractorFromData({
    wasmBinary: wasmBinary,
    data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
  });
  var names = [];
  var encrypted = [];
  var list = extractor.getFileList();
  for (var h of list.fileHeaders) {
    names.push(h.name);
    if (h.flags && h.flags.encrypted) encrypted.push(h.name);
  }
  names.sort();
  assert.deepStrictEqual(names, ['README.md', 'assets/logo.bin', 'empty.txt', 'secret.txt', 'src/app.ts', 'src/hello.js']);
  assert.deepStrictEqual(encrypted, ['secret.txt']);

  // 3. extract non-encrypted through the same filter pipeline as worker
  var extractor2 = await NodeUnrarJS.createExtractorFromData({
    wasmBinary: wasmBinary,
    data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
  });
  var opts = { skipGenerated: true, extractNested: true, generatedDirs: S.GENERATED_DIRS };
  var wanted = {};
  var skipped = [];
  for (var i = 0; i < names.length; i++) {
    var clean0 = S.sanitizePath(names[i]);
    if (!S.isIncluded(clean0, opts) && !S.isArchivePath(clean0)) { skipped.push(clean0 + ' (filter)'); continue; }
    wanted[clean0] = true;
  }
  assert.ok(!wanted['assets/logo.bin'], 'binary ext filtered');
  assert.ok(wanted['secret.txt'], 'encrypted file still listed before extract');
  // drop encrypted from extract set like the worker does
  delete wanted['secret.txt'];
  skipped.push('secret.txt (encrypted)');

  var res = extractor2.extract({ files: function (fh) { return !!wanted[S.sanitizePath(fh.name)]; } });
  var kept = [];
  for (var f of res.files) {
    var clean = S.sanitizePath(f.fileHeader.name);
    var data = f.extraction instanceof Uint8Array ? f.extraction : new Uint8Array(f.extraction);
    var dec = S.decodeText(data);
    if (dec.binary) { skipped.push(clean + ' (binary)'); continue; }
    kept.push({ path: clean, text: dec.text });
  }
  var paths = kept.map(function (k) { return k.path; }).sort();
  console.log('kept', paths);
  console.log('skipped', skipped);
  assert.deepStrictEqual(paths, ['README.md', 'empty.txt', 'src/app.ts', 'src/hello.js']);
  var hello = kept.filter(function (k) { return k.path === 'src/hello.js'; })[0];
  assert.ok(hello.text.indexOf('hello-world') !== -1);
  var readme = kept.filter(function (k) { return k.path === 'README.md'; })[0];
  assert.ok(readme.text.indexOf('# Sample RAR') !== -1);

  // 4. bogus input -> UnrarError, not a crash
  var extractor3 = await NodeUnrarJS.createExtractorFromData({
    wasmBinary: wasmBinary,
    data: new Uint8Array([1, 2, 3, 4]).buffer
  });
  var threw = false;
  try {
    var l3 = extractor3.getFileList();
    for (var x of l3.fileHeaders) { /* consume */ }
  } catch (e) { threw = true; }
  assert.ok(threw, 'bogus input must throw');

  console.log('rar pipeline ok');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
