'use strict';

var fs = require('fs');
var path = require('path');
var assert = require('assert');

var source = fs.readFileSync(path.join(__dirname, '..', 'js', 'worker.js'), 'utf8');

var batch = source.match(/var BATCH_SIZE = (\d+);/);
var currentEvery = source.match(/var CURRENT_EVERY = (\d+);/);
assert.ok(batch, 'worker must define a batch size');
assert.ok(currentEvery, 'worker must throttle current-path UI messages');
assert.ok(Number(batch[1]) >= 32 && Number(batch[1]) <= 128, 'batch size should stay in a smooth-memory range');
assert.ok(Number(currentEvery[1]) >= 4 && Number(currentEvery[1]) <= 32, 'current-path throttling should stay bounded');

var gateCalls = (source.match(/await batchGate\(false\)/g) || []).length;
assert.ok(gateCalls >= 5, 'all entry paths should participate in batched backpressure');
assert.ok(source.indexOf('await waitContinue();') !== -1, 'worker must retain cooperative backpressure');
assert.ok(source.indexOf('state.batchCount >= BATCH_SIZE') !== -1, 'backpressure must be batch based');

console.log('worker throughput guards ok');
