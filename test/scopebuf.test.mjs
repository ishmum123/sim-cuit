// test/scopebuf.test.mjs
// Node.js test suite for js/ui/scopebuf.js — DOM-free oscilloscope buffering
// and trace-management logic (ring buffer, add/evict/remove, windowing,
// autoscale, sample-rate gating).
// Run: node test/scopebuf.test.mjs
// Exit nonzero on failure.

import assert from 'assert';
import {
  RingBuffer, ScopeModel, MAX_TRACES, MAX_SAMPLE_MAGNITUDE, autoscale, shouldSample,
} from '../js/ui/scopebuf.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.stack || err.message}`);
    failCount++;
  }
}

// ============================================================================
await test('RingBuffer accumulates samples in chronological order under capacity', () => {
  const rb = new RingBuffer(5);
  rb.push(0, 1);
  rb.push(1, 2);
  rb.push(2, 3);
  const arr = rb.toArray();
  assert.deepStrictEqual(arr.map((p) => p.v), [1, 2, 3]);
  assert.deepStrictEqual(rb.last(), { t: 2, v: 3 });
});

await test('RingBuffer wraps and drops the oldest sample once full', () => {
  const rb = new RingBuffer(3);
  rb.push(0, 'a'.charCodeAt(0));
  rb.push(1, 10);
  rb.push(2, 20);
  rb.push(3, 30); // should evict the t=0 sample
  const arr = rb.toArray();
  assert.strictEqual(arr.length, 3);
  assert.deepStrictEqual(arr.map((p) => p.t), [1, 2, 3]);
  assert.deepStrictEqual(arr.map((p) => p.v), [10, 20, 30]);
});

await test('RingBuffer.clear() resets to empty', () => {
  const rb = new RingBuffer(4);
  rb.push(0, 1); rb.push(1, 2);
  rb.clear();
  assert.strictEqual(rb.toArray().length, 0);
  assert.strictEqual(rb.last(), null);
});

// ============================================================================
await test('ScopeModel.addProbe adds up to MAX_TRACES traces without eviction', () => {
  const sm = new ScopeModel();
  assert.strictEqual(MAX_TRACES, 4);
  const evictions = [];
  for (let i = 0; i < MAX_TRACES; i++) {
    const { evicted } = sm.addProbe(`C${i}`, 'v');
    evictions.push(evicted);
  }
  assert.strictEqual(sm.traces.length, 4);
  assert.deepStrictEqual(evictions, [null, null, null, null]);
});

await test('ScopeModel.addProbe evicts the oldest (FIFO) on a 5th probe', () => {
  const sm = new ScopeModel();
  for (let i = 0; i < 4; i++) sm.addProbe(`C${i}`, 'v');
  const { added, evicted } = sm.addProbe('C4', 'v');
  assert.strictEqual(evicted.compId, 'C0', 'oldest trace (C0) should be evicted');
  assert.strictEqual(added.compId, 'C4');
  assert.strictEqual(sm.traces.length, 4);
  assert.deepStrictEqual(sm.traces.map((t) => t.compId), ['C1', 'C2', 'C3', 'C4']);
});

await test('ScopeModel.addProbe re-adding an existing compId re-quantities it instead of duplicating', () => {
  const sm = new ScopeModel();
  sm.addProbe('B1', 'i');
  sm.getTrace('B1').buf.push(0, 42);
  const { added, evicted } = sm.addProbe('B1', 'v');
  assert.strictEqual(evicted, null);
  assert.strictEqual(sm.traces.length, 1);
  assert.strictEqual(added.quantity, 'v');
  assert.strictEqual(added.buf.toArray().length, 0, 'switching quantity should clear stale samples');
});

await test('ScopeModel.removeProbe removes only the matching trace', () => {
  const sm = new ScopeModel();
  sm.addProbe('A', 'v');
  sm.addProbe('B', 'i');
  const removed = sm.removeProbe('A');
  assert.strictEqual(removed.compId, 'A');
  assert.strictEqual(sm.traces.length, 1);
  assert.strictEqual(sm.traces[0].compId, 'B');
  assert.strictEqual(sm.removeProbe('nope'), null);
});

await test('ScopeModel.pruneMissing drops traces for deleted components', () => {
  const sm = new ScopeModel();
  sm.addProbe('A', 'v');
  sm.addProbe('B', 'i');
  sm.addProbe('C', 'v');
  const removed = sm.pruneMissing(new Set(['B']));
  assert.deepStrictEqual(removed.map((t) => t.compId).sort(), ['A', 'C']);
  assert.deepStrictEqual(sm.traces.map((t) => t.compId), ['B']);
});

await test('ScopeModel.sample records the requested quantity (v or i) per trace', () => {
  const sm = new ScopeModel();
  sm.addProbe('LED1', 'i');
  sm.addProbe('BAT1', 'v');
  const values = { LED1: { v: 1.8, i: 0.02 }, BAT1: { v: 9, i: 0.5 } };
  sm.sample(0.1, (id) => values[id]);
  assert.strictEqual(sm.getTrace('LED1').buf.last().v, 0.02);
  assert.strictEqual(sm.getTrace('BAT1').buf.last().v, 9);
});

await test('ScopeModel.windowedData filters samples outside the trailing time window', () => {
  const sm = new ScopeModel({ windowSec: 2 });
  const { added: tr } = sm.addProbe('X', 'v');
  for (let t = 0; t <= 5; t += 1) tr.buf.push(t, t);
  const win = sm.windowedData(tr, 5);
  assert.deepStrictEqual(win.map((p) => p.t), [3, 4, 5]);
});

await test('ScopeModel.sample clamps non-finite and wildly-out-of-range values instead of blowing out the axis', () => {
  const sm = new ScopeModel();
  sm.addProbe('X', 'i');
  const values = { X: { v: 0, i: NaN } };
  sm.sample(0, (id) => values[id]);
  assert.strictEqual(sm.getTrace('X').buf.last().v, 0, 'non-finite samples fall back to 0');

  values.X.i = 5.5e14; // observed solver glitch magnitude
  sm.sample(1, (id) => values[id]);
  assert.strictEqual(sm.getTrace('X').buf.last().v, MAX_SAMPLE_MAGNITUDE);

  values.X.i = -5.5e14;
  sm.sample(2, (id) => values[id]);
  assert.strictEqual(sm.getTrace('X').buf.last().v, -MAX_SAMPLE_MAGNITUDE);

  values.X.i = 0.031; // a normal in-range value is untouched
  sm.sample(3, (id) => values[id]);
  assert.strictEqual(sm.getTrace('X').buf.last().v, 0.031);
});

// ============================================================================
await test('autoscale pads a varying series and widens a flat/zero series', () => {
  const varying = autoscale([{ v: 0 }, { v: 10 }]);
  assert(varying.min < 0 && varying.max > 10, 'should pad beyond observed extremes');

  const flatZero = autoscale([{ v: 0 }, { v: 0 }]);
  assert(flatZero.min < 0 && flatZero.max > 0, 'a flat-zero series must not collapse to a zero-height line');

  const empty = autoscale([]);
  assert(empty.min < empty.max, 'empty input still yields a usable, non-degenerate range');
});

// ============================================================================
await test('shouldSample gates on elapsed sim time since the last recorded sample', () => {
  assert.strictEqual(shouldSample(null, 0, 0.016), true, 'first sample always allowed');
  assert.strictEqual(shouldSample(1.0, 1.005, 0.016), false, 'too soon — should be gated out');
  assert.strictEqual(shouldSample(1.0, 1.02, 0.016), true, 'enough sim time elapsed — allowed');
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(60));
console.log(`Tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  process.exit(1);
}
process.exit(0);
