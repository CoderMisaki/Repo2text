'use strict';
// Harness: runs js/worker.js in a vm sandbox with stubbed Worker APIs,
// feeds it tests/fixtures/sample.rar, and verifies the message flow.
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var assert = require('assert');

var REPO = path.join(__dirname, '..');
var JS = path.join(REPO, 'js');

var messages = [];
function readB64U8(rel) {
  var b64 = fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\s+/g, '');
  var buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
var wasmB64Text = fs.readFileSync(path.join(REPO, 'vendor', 'unrar.wasm.b64'), 'utf8');

function resolveImport(p) {
  // worker.js lives in js/ ; './x' -> js/x , '../x' -> repo/x
  if (p.startsWith('./')) return path.join(JS, p.slice(2));
  if (p.startsWith('../')) return path.join(REPO, p.slice(3));
  return path.join(JS, p);
}

var sandbox;
sandbox = {
  console: console,
  TextDecoder: TextDecoder,
  TextEncoder: TextEncoder,
  URL: URL,
  Blob: Blob,
  Uint8Array: Uint8Array,
  Uint32Array: Uint32Array,
  Uint8Array: Uint8Array,
  ArrayBuffer: ArrayBuffer,
  DataView: DataView,
  WebAssembly: WebAssembly,
  atob: atob,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  performance: performance,
  fetch: async function (url) {
    assert.ok(/unrar\.wasm\.b64$/.test(url), 'unexpected fetch: ' + url);
    return { ok: true, text: async function () { return wasmB64Text; } };
  },
  importScripts: function () {
    for (var i = 0; i < arguments.length; i++) {
      var file = resolveImport(arguments[i]);
      var code = fs.readFileSync(file, 'utf8');
      vm.runInContext(code, sandbox, { filename: file });
    }
  }
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.location = { href: 'https://example.test/js/worker.js' };
sandbox.postMessage = function (msg) {
  messages.push(msg);
  if (msg.type === 'await-continue') {
    // auto-continue like the UI does
    setTimeout(function () { sandbox.onmessage({ data: { type: 'continue', jobId: msg.jobId } }); }, 0);
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(JS, 'worker.js'), 'utf8'), sandbox, { filename: 'worker.js' });

assert.ok(sandbox.R2T && sandbox.R2T.shared, 'shared loaded in worker');
assert.strictEqual(messages[0].type, 'boot');
assert.strictEqual(messages[0].libs.unrar, true, 'HAS_UNRAR must be true');

var rarBytes = readB64U8('tests/fixtures/sample.rar.b64');
var nestedTarBytes = readB64U8('tests/fixtures/nested-rar.tar.b64');
var blob = new Blob([rarBytes], { type: 'application/x-rar-compressed' });

sandbox.onmessage({ data: {
  type: 'open-archive',
  jobId: 7,
  file: blob,
  name: 'sample.rar',
  options: { skipGenerated: true, extractNested: true }
} });

function waitDone() {
  return new Promise(function (resolve, reject) {
    var tries = 0;
    (function poll() {
      tries++;
      var last = messages[messages.length - 1];
      if (last && (last.type === 'done' || last.type === 'error' || last.type === 'cancelled')) return resolve(last);
      if (tries > 600) return reject(new Error('timeout waiting for done'));
      setTimeout(poll, 50);
    })();
  });
}

waitDone().then(function (last) {
  var byType = {};
  messages.forEach(function (m) { (byType[m.type] = byType[m.type] || []).push(m); });
  console.log('message types:', Object.keys(byType).join(', '));

  assert.strictEqual(byType.format[0].format, 'rar');
  assert.strictEqual(byType.meta[0].format, 'rar');
  assert.strictEqual(byType.meta[0].bomb.level, 'ok');
  var planPaths = JSON.parse(JSON.stringify(byType.plan[0].paths));
  assert.deepStrictEqual(planPaths, ['README.md', 'empty.txt', 'secret.txt', 'src/app.ts', 'src/hello.js']);

  var files = {};
  byType.file.forEach(function (m) { files[m.path] = m.text; });
  assert.ok(files['README.md'].indexOf('# Sample RAR') !== -1, 'README content');
  assert.ok(files['src/hello.js'].indexOf('hello-world') !== -1, 'hello.js content');
  assert.ok(files['empty.txt'] !== undefined, 'empty.txt present');
  assert.ok(!files['assets/logo.bin'], 'binary filtered');

  var skippedReasons = {};
  (byType.skipped || []).forEach(function (m) { skippedReasons[m.path] = m.reason; });
  console.log('skipped:', JSON.stringify(skippedReasons));
  assert.strictEqual(skippedReasons['secret.txt'], 'RAR terenkripsi');
  assert.ok(!files['assets/logo.bin'], 'binary filtered');

  assert.strictEqual(last.type, 'done');
  assert.strictEqual(last.processed, 4);
  assert.strictEqual(last.skipped, 1);
  console.log('worker rar integration ok');

  // nested: RAR inside TAR must extract with prefix
  messages.length = 0;
  var tarBlob = new Blob([nestedTarBytes], { type: 'application/x-tar' });
  sandbox.onmessage({ data: {
    type: 'open-archive',
    jobId: 8,
    file: tarBlob,
    name: 'nested-rar.tar',
    options: { skipGenerated: true, extractNested: true }
  } });
  return waitDone();
}).then(function (last2) {
  var nested = {};
  messages.forEach(function (m) { if (m.type === 'file') nested[m.path] = m.text; });
  console.log('nested files:', JSON.stringify(Object.keys(nested).sort()));
  assert.ok(nested['top.txt'] === 'top level', 'zip top-level file');
  assert.ok(nested['nested/archive/README.md'].indexOf('# Sample RAR') !== -1, 'nested rar README with prefix');
  assert.ok(nested['nested/archive/src/hello.js'].indexOf('hello-world') !== -1, 'nested rar hello.js with prefix');
  var nestedSkipped = {};
  messages.forEach(function (m) { if (m.type === 'skipped') nestedSkipped[m.path] = m.reason; });
  assert.strictEqual(nestedSkipped['nested/archive/secret.txt'], 'RAR terenkripsi');
  assert.strictEqual(last2.type, 'done');
  console.log('worker nested rar ok');
}).catch(function (err) {
  console.error('MESSAGES SO FAR:', JSON.stringify(messages.slice(-5), null, 1).slice(0, 2000));
  console.error(err);
  process.exit(1);
});
