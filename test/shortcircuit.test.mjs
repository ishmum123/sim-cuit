// test/shortcircuit.test.mjs
// Node.js test suite for js/sim/shortcircuit.js — pure short-circuit advisory
// threshold logic (fires once per episode, re-arms when current drops or the
// part fails).
// Run: node test/shortcircuit.test.mjs
// Exit nonzero on failure.

import assert from 'assert';
import { thresholdAmps, checkShortCircuit, FALLBACK_THRESHOLD_A, RATING_MULTIPLE } from '../js/sim/shortcircuit.js';

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

function battery({ i = 0, failed = false, maxCurrent } = {}) {
  return {
    id: 'B1',
    type: 'battery',
    state: { i, failed },
    ratings: maxCurrent === undefined ? {} : { maxCurrent },
  };
}

// ============================================================================
await test('thresholdAmps falls back to a flat 5A when the part has no current rating', () => {
  assert.strictEqual(thresholdAmps(battery()), FALLBACK_THRESHOLD_A);
});

await test('thresholdAmps is 20x the rated maxCurrent when a rating exists', () => {
  assert.strictEqual(thresholdAmps(battery({ maxCurrent: 2 })), 2 * RATING_MULTIPLE);
  assert.strictEqual(RATING_MULTIPLE, 20);
});

await test('checkShortCircuit does not fire while under threshold', () => {
  const episodes = new Map();
  const result = checkShortCircuit(battery({ i: 3 }), episodes);
  assert.strictEqual(result, null);
});

await test('checkShortCircuit fires exactly once on the rising edge above threshold', () => {
  const episodes = new Map();
  const over = battery({ i: 42, maxCurrent: undefined }); // over the 5A fallback
  const first = checkShortCircuit(over, episodes);
  assert(first, 'should fire on first frame over threshold');
  assert.strictEqual(first.id, 'B1');
  assert.strictEqual(first.current, 42);
  assert.strictEqual(first.threshold, FALLBACK_THRESHOLD_A);

  // still over threshold next frame — must NOT fire again (no spam)
  const second = checkShortCircuit(over, episodes);
  assert.strictEqual(second, null, 'must not spam while still in the same episode');
  const third = checkShortCircuit(over, episodes);
  assert.strictEqual(third, null);
});

await test('checkShortCircuit re-arms once current drops back under threshold, then fires again', () => {
  const episodes = new Map();
  const comp = battery({ i: 42 });
  assert(checkShortCircuit(comp, episodes), 'first over-threshold frame fires');
  assert.strictEqual(checkShortCircuit(comp, episodes), null, 'still over threshold — suppressed');

  comp.state.i = 1; // current drops back
  assert.strictEqual(checkShortCircuit(comp, episodes), null, 'dropping back under threshold does not itself fire');

  comp.state.i = 42; // spikes again — new episode
  const again = checkShortCircuit(comp, episodes);
  assert(again, 're-armed episode should fire again after a genuine drop-and-reprise');
});

await test('checkShortCircuit does not fire (and re-arms) once the part has failed', () => {
  const episodes = new Map();
  const comp = battery({ i: 42 });
  checkShortCircuit(comp, episodes); // arm the episode
  comp.state.failed = 'open';
  const result = checkShortCircuit(comp, episodes);
  assert.strictEqual(result, null, 'a failed part should not raise a fresh advisory');
  assert.strictEqual(episodes.get('B1'), false, 'failing should re-arm for a future episode');
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
