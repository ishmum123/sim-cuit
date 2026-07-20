// test/sketch.test.mjs — Node test script for the JS "sketch" runtime
// (js/engine/sketch.js) and its ESP32 integration (js/engine/components.js).
// Run: node test/sketch.test.mjs
// No framework; uses assert + console.log; exits nonzero on failure.

import assert from 'node:assert/strict';
import { SketchRuntime } from '../js/engine/sketch.js';
import { Simulation } from '../js/engine/solver.js';
import { createComponent, resetIdCounters } from '../js/engine/components.js';

let passCount = 0;
function pass(name) { passCount++; console.log(`  ok - ${name}`); }
function section(name) { console.log(`\n${name}`); }

const BLINK = `function setup() { pinMode(4, OUTPUT); }
function loop() {
  digitalWrite(4, HIGH); delay(500);
  digitalWrite(4, LOW);  delay(500);
}
`;

// ---------------------------------------------------------------------------
section('1. Compile errors surface cleanly');
{
  const rt = new SketchRuntime('function loop() { this is not valid js (((');
  assert.equal(rt.status, 'error');
  assert.ok(/Compile error/.test(rt.error), `expected a compile error message, got: ${rt.error}`);
  pass(`compile error surfaced: "${rt.error}"`);
}

// ---------------------------------------------------------------------------
section('2. Missing loop() is a compile error');
{
  const rt = new SketchRuntime('function setup() { pinMode(4, OUTPUT); }');
  assert.equal(rt.status, 'error');
  assert.ok(/loop/.test(rt.error), `expected error to mention loop(), got: ${rt.error}`);
  pass('missing loop() rejected at compile time');
}

// ---------------------------------------------------------------------------
section('3. Blink sketch toggles GPIO4 with correct 500ms timing across simulated time');
{
  const rt = new SketchRuntime(BLINK);
  assert.equal(rt.status, 'stopped');
  let t = 0;
  const dt = 0.01; // 10ms ticks
  const samples = [];
  for (let i = 0; i < 400; i++) { // 4 simulated seconds
    rt.tick(t);
    const pin = rt.getPinState()[4];
    samples.push({ t, v: pin ? pin.value : undefined });
    t += dt;
  }
  assert.equal(rt.status, 'running');
  // just after boot (setup ran pinMode only, no digitalWrite yet until loop
  // runs its first statement) pin should end up HIGH almost immediately
  const at50ms = samples.find((s) => s.t >= 0.05).v;
  assert.equal(at50ms, 1, `expected HIGH shortly after boot, got ${at50ms}`);
  // just after 500ms it should have flipped LOW
  const at600ms = samples.find((s) => s.t >= 0.6).v;
  assert.equal(at600ms, 0, `expected LOW just after 500ms, got ${at600ms}`);
  // just after 1000ms (one full period) it should be HIGH again
  const at1100ms = samples.find((s) => s.t >= 1.1).v;
  assert.equal(at1100ms, 1, `expected HIGH again after one full period, got ${at1100ms}`);
  // just after 1500ms it should be LOW again
  const at1600ms = samples.find((s) => s.t >= 1.6).v;
  assert.equal(at1600ms, 0, `expected LOW again at 1.6s, got ${at1600ms}`);
  pass('GPIO4 blinks HIGH/LOW on ~500ms boundaries across simulated time');
}

// ---------------------------------------------------------------------------
section('4. digitalRead/analogRead reflect node voltages');
{
  const rt = new SketchRuntime(`
    function setup() { pinMode(2, INPUT); }
    function loop() { print(digitalRead(2), analogRead(2)); delay(10); }
  `);
  rt.setPinReader((pin) => (pin === 2 ? 3.3 : 0));
  rt.tick(0);
  assert.equal(rt.status, 'running');
  assert.deepEqual(rt.log[rt.log.length - 1].split(' ').map(Number), [1, 4095]);

  const rt2 = new SketchRuntime(`
    function setup() { pinMode(2, INPUT); }
    function loop() { print(digitalRead(2), analogRead(2)); delay(10); }
  `);
  rt2.setPinReader((pin) => (pin === 2 ? 1.0 : 0)); // below 1.65V threshold, ~1240/4095
  rt2.tick(0);
  const [d, a] = rt2.log[rt2.log.length - 1].split(' ').map(Number);
  assert.equal(d, 0, 'digitalRead should read LOW below 1.65V threshold');
  assert.ok(Math.abs(a - Math.round((1.0 / 3.3) * 4095)) <= 1, `analogRead ${a} should map 1.0V proportionally`);
  pass('digitalRead thresholds at 1.65V, analogRead maps 0-3.3V to 0-4095');
}

// ---------------------------------------------------------------------------
section('5. Runaway while(true){} in loop() halts instead of hanging');
{
  const rt = new SketchRuntime('function loop() { while (true) { } }');
  const start = Date.now();
  rt.tick(0);
  const elapsed = Date.now() - start;
  assert.equal(rt.status, 'error');
  assert.ok(/too long/.test(rt.error), `expected the "too long" halt message, got: ${rt.error}`);
  assert.ok(elapsed < 5000, `should halt quickly via the iteration budget, took ${elapsed}ms`);
  pass(`runaway loop halted: "${rt.error}" (in ${elapsed}ms)`);
}

// ---------------------------------------------------------------------------
section('6. print() lines captured without duplicates across delay() resumes');
{
  const rt = new SketchRuntime(`
    function setup() { print('booted'); }
    function loop() {
      print('a');
      delay(100);
      print('b');
      delay(100);
    }
  `);
  let t = 0;
  const dt = 0.02;
  for (let i = 0; i < 40; i++) { rt.tick(t); t += dt; } // ~0.8s, should cover ~4 full a/b cycles
  const aCount = rt.log.filter((l) => l === 'a').length;
  const bCount = rt.log.filter((l) => l === 'b').length;
  const bootCount = rt.log.filter((l) => l === 'booted').length;
  assert.equal(bootCount, 1, `setup() should print 'booted' exactly once, got ${bootCount}`);
  assert.ok(aCount >= 3 && aCount <= 5, `expected ~4 'a' prints (no dupes from replay), got ${aCount}: ${JSON.stringify(rt.log)}`);
  assert.equal(aCount, bCount, `'a' and 'b' counts should match (each loop iteration prints one of each), got a=${aCount} b=${bCount}`);
  pass(`print() deduplicated across resumes: booted=1, a=${aCount}, b=${bCount}`);
}

// ---------------------------------------------------------------------------
section('7. Runtime error inside loop() halts cleanly with a message');
{
  const rt = new SketchRuntime('function loop() { undefinedFunctionCall(); }');
  rt.tick(0);
  assert.equal(rt.status, 'error');
  assert.ok(/Runtime error/.test(rt.error), `expected a runtime error message, got: ${rt.error}`);
  pass(`runtime error surfaced: "${rt.error}"`);
}

// ---------------------------------------------------------------------------
section('8. Scrubbed globals are unreachable from sketch code');
{
  const rt = new SketchRuntime('function loop() { print(typeof window, typeof document, typeof fetch); delay(10); }');
  rt.tick(0);
  assert.equal(rt.status, 'running');
  assert.equal(rt.log[rt.log.length - 1], 'undefined undefined undefined');
  pass('window/document/fetch are all undefined inside a sketch');
}

// ---------------------------------------------------------------------------
section('9. ESP32 integration: blink sketch drives GPIO4 through the solver');
{
  resetIdCounters();
  const esp = createComponent('esp32', 0, 0);
  esp.params.sketchEnabled = true;
  esp.params.sketch = BLINK;
  const vin = createComponent('battery', 1, 0); vin.params.voltage = 5; vin.params.internalResistance = 0.1;
  const r1 = createComponent('resistor', 2, 0); r1.params.resistance = 150;
  const led = createComponent('led', 3, 0); led.params.color = 'green';
  vin.nodes = [10, 0];
  esp.nodes = [10, 0, 11, 12, 13, 14]; // VIN,GND,3V3,GPIO2,GPIO4,GPIO5
  r1.nodes = [13, 20];
  led.nodes = [20, 0];
  const sim = new Simulation();
  sim.setNetlist([vin, r1, led, esp]);
  const dt = 50e-6;
  let sawHigh = false, sawLow = false;
  for (let i = 0; i < 44000; i++) { // ~2.2s sim time, > 2 full 1s periods
    sim.step(dt);
    if (led.state.brightness > 0.3) sawHigh = true;
    if (led.state.brightness < 0.05) sawLow = true;
  }
  assert.ok(!esp.state.failed, `board should survive, failed=${esp.state.failureMsg}`);
  assert.ok(!esp.state.brownout, `board should be powered, brownout=${esp.state.brownout}`);
  assert.ok(!led.state.failed, `LED should survive, failed=${led.state.failureMsg}`);
  assert.ok(sawHigh, 'LED should light during the sketch-driven HIGH phase');
  assert.ok(sawLow, 'LED should go dark during the sketch-driven LOW phase');
  assert.equal(esp.state.sketchStatus, 'Running', `sketch should report Running, got ${esp.state.sketchStatus}`);
  pass('ESP32 + solver: sketch-driven GPIO4 blinks the LED through the electrical model');
}

// ---------------------------------------------------------------------------
section('10. Power loss resets the runtime (setup() reruns on reboot)');
{
  resetIdCounters();
  const esp = createComponent('esp32', 0, 0);
  esp.params.sketchEnabled = true;
  esp.params.sketch = `
    function setup() { print('booted'); }
    function loop() { delay(100); }
  `;
  // Battery voltage is driven directly (rather than via a switch) so power
  // loss is unambiguous: the switch's "open" state is a large-but-finite
  // 1e9 ohm leak in this model, not a true disconnect, so a floating VIN
  // node fed only through an open switch settles near the battery voltage
  // rather than collapsing to 0V — setting the source to 0V is the clean
  // way to simulate a real power interruption here.
  const vin = createComponent('battery', 1, 0); vin.params.voltage = 5; vin.params.internalResistance = 0.1;
  vin.nodes = [10, 0];
  esp.nodes = [10, 0, 11, 12, 13, 14];
  const sim = new Simulation();
  sim.setNetlist([vin, esp]);
  const dt = 1e-3;
  for (let i = 0; i < 300; i++) sim.step(dt); // let it boot and settle
  assert.ok(!esp.state.brownout, 'board should be powered');
  assert.equal(esp.state.sketchLog.filter((l) => l === 'booted').length, 1, 'setup() should have run exactly once so far');

  // cut power
  vin.params.voltage = 0;
  for (let i = 0; i < 300; i++) sim.step(dt);
  assert.ok(esp.state.brownout, 'board should have lost power');

  // restore power
  vin.params.voltage = 5;
  for (let i = 0; i < 300; i++) sim.step(dt);
  assert.ok(!esp.state.brownout, 'board should be powered again');
  assert.equal(esp.state.sketchLog.filter((l) => l === 'booted').length, 2, 'setup() should have rerun once after reboot (2 total "booted" prints)');
  pass('losing and regaining power reruns setup() exactly once (real-reboot semantics)');
}

// ---------------------------------------------------------------------------
console.log(`\n${passCount} checks passed.`);
