'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var assert = require('assert');

var sharedCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared.js'), 'utf8');
var sandbox = {
  console: console,
  TextDecoder: TextDecoder,
  TextEncoder: TextEncoder,
  URL: URL,
  Uint8Array: Uint8Array,
  Uint32Array: Uint32Array,
  ArrayBuffer: ArrayBuffer
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(sharedCode, sandbox);
var S = sandbox.R2T.shared;

var JSZip = require(path.join(__dirname, '..', 'vendor', 'jszip.min.js'));
if (typeof JSZip !== 'function') {
  // UMD in node typically module.exports
  JSZip = require('/home/user/Repo2text/vendor/jszip.min.js');
}

(async function () {
  var buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.zip'));
  var zip = await JSZip.loadAsync(buf);
  var opts = { skipGenerated: true, extractNested: true, generatedDirs: S.GENERATED_DIRS };
  var kept = [];
  var skipped = [];
  var names = Object.keys(zip.files).sort();
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var entry = zip.files[name];
    if (entry.dir) continue;
    var clean = S.sanitizePath(name);
    if (!S.isIncluded(clean, opts) && !S.isArchivePath(clean)) {
      skipped.push(clean + ' (filter)');
      continue;
    }
    var u8 = await entry.async('uint8array');
    if (S.isArchivePath(clean)) {
      skipped.push(clean + ' (nested archive present)');
      continue;
    }
    var dec = S.decodeText(u8);
    if (dec.binary) { skipped.push(clean + ' (binary)'); continue; }
    kept.push({ path: clean, text: dec.text });
  }
  var paths = kept.map(function (k) { return k.path; }).sort();
  console.log('kept', paths);
  console.log('skipped', skipped);
  assert.ok(paths.indexOf('README.md') !== -1);
  assert.ok(paths.indexOf('src/hello.js') !== -1);
  assert.ok(paths.indexOf('src/app.ts') !== -1);
  assert.ok(paths.indexOf('empty.txt') !== -1);
  assert.ok(paths.indexOf('assets/logo.bin') === -1);
  var hello = kept.filter(function (k) { return k.path === 'src/hello.js'; })[0];
  assert.ok(hello.text.indexOf('hello-world') !== -1);
  assert.ok(hello.text.indexOf('function x()') !== -1);
  console.log('zip pipeline ok');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
