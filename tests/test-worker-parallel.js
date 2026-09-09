'use strict';

var fs = require('fs');
var path = require('path');
var assert = require('assert');

var source = fs.readFileSync(path.join(__dirname, '..', 'js', 'worker.js'), 'utf8');
var concurrency = source.match(/var ZIP_CONCURRENCY = Math\.max\(2, Math\.min\(6, CPU - 1\)\);/);
assert.ok(concurrency, 'worker must use bounded parallel ZIP extraction');
assert.ok(source.indexOf('runConcurrent(files, ZIP_CONCURRENCY') !== -1, 'ZIP entries must be extracted concurrently');
assert.ok(source.indexOf('await f.item.entry.getData') !== -1, 'zip.js extraction path must remain active');
assert.ok(source.indexOf('await f.entry.async') !== -1, 'JSZip fallback must remain active');
assert.ok(source.indexOf('memory browser hampir penuh') !== -1, 'memory-pressure guard must remain active');
assert.ok(source.indexOf('cooperativePoint') !== -1, 'worker must yield cooperatively');

console.log('worker parallel throughput guards ok');
