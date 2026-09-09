'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var assert = require('assert');

var code = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared.js'), 'utf8');
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
vm.runInContext(code, sandbox);
var S = sandbox.R2T.shared;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL ' + name);
    console.error('  ' + err.stack);
  }
}

test('sanitizePath strips traversal and nulls', function () {
  assert.strictEqual(S.sanitizePath('../etc/passwd'), 'etc/passwd');
  assert.strictEqual(S.sanitizePath('/abs/path.js'), 'abs/path.js');
  assert.strictEqual(S.sanitizePath('a/./b/../c.js'), 'a/c.js');
  assert.strictEqual(S.sanitizePath('ok\0.js'), 'ok.js');
});

test('isIncluded skips binaries, dirs, generated', function () {
  var opts = { skipGenerated: true, extractNested: false, generatedDirs: S.GENERATED_DIRS };
  assert.strictEqual(S.isIncluded('src/app.js', opts), true);
  assert.strictEqual(S.isIncluded('logo.png', opts), false);
  assert.strictEqual(S.isIncluded('node_modules/x/index.js', opts), false);
  assert.strictEqual(S.isIncluded('.git/config', opts), false);
  assert.strictEqual(S.isIncluded('vendor/lib.php', opts), false);
  assert.strictEqual(S.isIncluded('src/vendorlike.js', opts), true);
  assert.strictEqual(S.isIncluded('folder.zip', opts), false);
  opts.extractNested = true;
  assert.strictEqual(S.isIncluded('folder.zip', opts), true);
  opts.skipGenerated = false;
  assert.strictEqual(S.isIncluded('dist/app.js', opts), true);
  assert.strictEqual(S.isIncluded('.git/config', opts), false);
});

test('decodeText utf-8, BOM, binary', function () {
  var enc = new TextEncoder();
  var d = S.decodeText(enc.encode('hello'));
  assert.strictEqual(d.binary, false);
  assert.strictEqual(d.text, 'hello');
  var bom = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]);
  var b = S.decodeText(bom);
  assert.strictEqual(b.encoding, 'utf-8-bom');
  assert.strictEqual(b.text, 'a');
  var bin = new Uint8Array([0, 1, 2, 0, 0, 9]);
  assert.strictEqual(S.decodeText(bin).binary, true);
});

test('countLines and formatBytes', function () {
  assert.strictEqual(S.countLines(''), 1);
  assert.strictEqual(S.countLines('a'), 1);
  assert.strictEqual(S.countLines('a\nb\n'), 3);
  assert.ok(S.formatBytes(2048).indexOf('KB') !== -1);
});

test('parseRepoUrl github and codeberg', function () {
  var g = S.parseRepoUrl('https://github.com/foo/bar.git');
  assert.strictEqual(g.platform, 'github');
  assert.strictEqual(g.owner, 'foo');
  assert.strictEqual(g.repo, 'bar');
  var gb = S.parseRepoUrl('https://github.com/foo/bar/tree/feature/x');
  assert.strictEqual(gb.branch, 'feature/x');
  var c = S.parseRepoUrl('https://codeberg.org/acme/app/src/branch/dev');
  assert.strictEqual(c.platform, 'codeberg');
  assert.strictEqual(c.branch, 'dev');
});

test('parseRepoUrl rejects spoofed and unsafe URLs', function () {
  assert.strictEqual(S.parseRepoUrl('http://github.com/foo/bar'), null);
  assert.strictEqual(S.parseRepoUrl('https://github.evil.com/foo/bar'), null);
  assert.strictEqual(S.parseRepoUrl('https://mygithub.com/foo/bar'), null);
  assert.strictEqual(S.parseRepoUrl('https://evil.com/github.com/foo/bar'), null);
  assert.strictEqual(S.parseRepoUrl('javascript:alert(1)'), null);
  assert.strictEqual(S.parseRepoUrl('https://user:pass@github.com/foo/bar'), null);
  assert.strictEqual(S.parseRepoUrl('https://github.com/foo/bar/../../../etc/passwd'), null);
  assert.ok(S.parseRepoUrl('https://www.github.com/foo/bar'));
});

test('isAllowedFetchUrl allowlist', function () {
  assert.strictEqual(S.isAllowedFetchUrl('https://api.github.com/repos/foo/bar'), true);
  assert.strictEqual(S.isAllowedFetchUrl('https://raw.githubusercontent.com/foo/bar/main/a.js'), true);
  assert.strictEqual(S.isAllowedFetchUrl('https://evil.com/steal'), false);
  assert.strictEqual(S.isAllowedFetchUrl('http://api.github.com/repos/foo/bar'), false);
  assert.strictEqual(S.isAllowedFetchUrl('https://api.github.com.evil.com/x'), false);
});

test('safeJsonParse strips prototype keys', function () {
  var obj = S.safeJsonParse('{"ok":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}');
  assert.strictEqual(obj.ok, 1);
  assert.strictEqual(obj.polluted, undefined);
  assert.strictEqual({}.polluted, undefined);
});

test('safeFilename and path encoding', function () {
  var fn = S.safeFilename('../evil.txt');
  assert.ok(fn.indexOf('..') === -1 && fn.indexOf('/') === -1);
  assert.ok(S.safeFilename('a/b\\c:d').indexOf('/') === -1);
  assert.strictEqual(S.encodeGitPath('src/foo bar.js'), 'src/foo%20bar.js');
});

test('analyzeArchiveMeta blocks zip bombs', function () {
  var ok = S.analyzeArchiveMeta([{ uncompressedSize: 100, directory: false }], 80);
  assert.strictEqual(ok.level, 'ok');
  var block = S.analyzeArchiveMeta([{ uncompressedSize: 2 * 1024 * 1024 * 1024, directory: false }], 1024);
  assert.strictEqual(block.level, 'block');
});

test('priorityScore prefers readme', function () {
  assert.ok(S.priorityScore('README.md', 100) < S.priorityScore('src/huge.js', 5e6));
});

test('detectFormat magic', function () {
  assert.strictEqual(S.detectFormat('a.zip', [0x50, 0x4B, 0x03, 0x04]), 'zip');
  assert.strictEqual(S.detectFormat('a.tar.gz', [0x1F, 0x8B]), 'tar.gz');
  assert.strictEqual(S.detectFormat('a.7z', [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]), '7z');
});

test('parseTarBuffer reads ustar files', function () {
  var tar = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.tar'));
  var entries = S.parseTarBuffer(new Uint8Array(tar));
  var names = entries.map(function (e) { return e.path; });
  assert.ok(names.indexOf('src/hello.js') !== -1, names.join(','));
  var hello = entries.filter(function (e) { return e.path === 'src/hello.js'; })[0];
  var text = new TextDecoder().decode(hello.data);
  assert.ok(text.indexOf('hello-world') !== -1);
  var empty = entries.filter(function (e) { return e.path === 'empty.txt'; })[0];
  assert.ok(empty);
  assert.strictEqual(empty.size, 0);
});

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall tests passed');
