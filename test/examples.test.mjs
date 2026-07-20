// Sim-cuit example validation tests
// Validates that all example JSON circuits load and behave as expected
// Run: node test/examples.test.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Simulation } from '../js/engine/solver.js';
import { assignNodes } from '../js/engine/netlist.js';

const examplesDir = path.join(process.cwd(), 'examples');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failures++; console.error(`  FAIL - ${name}: ${e.message}`); }
}

function loadExample(filename) {
  const text = fs.readFileSync(path.join(examplesDir, filename), 'utf8');
  const data = JSON.parse(text);
  if (!data.circuit) throw new Error(`Missing 'circuit' field in ${filename}`);
  const { components, wires } = data.circuit;
  if (!Array.isArray(components) || !Array.isArray(wires)) {
    throw new Error(`components and wires must be arrays in ${filename}`);
  }
  return { components, wires };
}

function runSim(components, wires, seconds = 1.0, dt = 50e-6) {
  assignNodes(components, wires);
  const sim = new Simulation();
  sim.setNetlist(components);
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    sim.step(dt);
  }
  return sim;
}

console.log('Sim-cuit example validation tests\n');

// Test 1: led-basics
check('led-basics: circuit loads', () => {
  const ex = loadExample('led-basics.json');
  assert.strictEqual(ex.components.length, 5);
  assert.strictEqual(ex.wires.length, 5);
  const battery = ex.components.find(c => c.type === 'battery');
  assert.strictEqual(battery.params.voltage, 9);
  const resistor = ex.components.find(c => c.type === 'resistor');
  assert.strictEqual(resistor.params.resistance, 220);
  const led = ex.components.find(c => c.type === 'led');
  assert.ok(led);
});

check('led-basics: LED lights with switch closed', () => {
  const ex = loadExample('led-basics.json');
  const sw = ex.components.find(c => c.type === 'switch');
  sw.params.closed = true;
  const led = ex.components.find(c => c.type === 'led');
  runSim(ex.components, ex.wires, 0.3);
  // LED should light up: brightness > 0.5, current in safe range
  assert.ok(led.state.brightness > 0.5, `brightness ${led.state.brightness} should be > 0.5`);
  assert.ok(led.state.i > 0.025 && led.state.i < 0.035, `current ${(led.state.i * 1e3).toFixed(1)} mA out of range`);
  assert.strictEqual(led.state.failed, null, `LED should not have failed, but: ${led.state.failureMsg}`);
});

// Test 2: led-killer
check('led-killer: circuit loads without resistor', () => {
  const ex = loadExample('led-killer.json');
  assert.strictEqual(ex.components.length, 4);
  const resistor = ex.components.find(c => c.type === 'resistor');
  assert.strictEqual(resistor, undefined, 'led-killer should have no resistor');
  const led = ex.components.find(c => c.type === 'led');
  assert.ok(led);
});

check('led-killer: LED fuses when switch closed', () => {
  const ex = loadExample('led-killer.json');
  const sw = ex.components.find(c => c.type === 'switch');
  sw.params.closed = true;
  const led = ex.components.find(c => c.type === 'led');
  runSim(ex.components, ex.wires, 0.5);
  // LED should fuse open
  assert.strictEqual(led.state.failed, 'open', `LED should have failed open, but state: ${led.state.failureMsg}`);
  assert.ok(led.state.failureMsg && /fus|mA|max/i.test(led.state.failureMsg),
    `failure message should mention fuse/current: ${led.state.failureMsg}`);
  // Current should drop to nearly zero
  assert.ok(Math.abs(led.state.i) < 1e-5, `current after fusing should be near zero, got ${led.state.i}`);
});

// Test 3: motor-stall
check('motor-stall: circuit loads', () => {
  const ex = loadExample('motor-stall.json');
  assert.strictEqual(ex.components.length, 5);
  const battery = ex.components.find(c => c.type === 'battery' && c.id === 'B1');
  assert.strictEqual(battery.params.voltage, 1.5, 'main battery should be 1.5V');
  const spare = ex.components.find(c => c.type === 'battery' && c.id === 'B2');
  assert.strictEqual(spare.params.voltage, 9, 'spare battery should be 9V');
  const motor = ex.components.find(c => c.type === 'motor');
  assert.ok(motor);
});

check('motor-stall: motor does not spin at 1.5V', () => {
  const ex = loadExample('motor-stall.json');
  const sw = ex.components.find(c => c.type === 'switch');
  sw.params.closed = true;
  const motor = ex.components.find(c => c.type === 'motor');
  runSim(ex.components, ex.wires, 0.5);
  // Motor should draw stall current but not spin
  assert.strictEqual(motor.state.spinning, false, 'motor should not be spinning at 1.5V');
  assert.ok(motor.state.rpm === 0 || motor.state.rpm < 1, `rpm should be ~0, got ${motor.state.rpm}`);
  // But it should draw significant current
  assert.ok(motor.state.i > 0.1, `stall current should be substantial, got ${motor.state.i} A`);
  assert.strictEqual(motor.state.failed, null, 'motor should not fail in 0.5s at 1.5V');
});

// Test 4: fuse-protects
check('fuse-protects: circuit loads with 1A fuse and 2Ω resistor', () => {
  const ex = loadExample('fuse-protects.json');
  assert.strictEqual(ex.components.length, 4);
  const fuse = ex.components.find(c => c.type === 'fuse');
  assert.strictEqual(fuse.params.ratedCurrent, 1, 'fuse should be rated 1A');
  const resistor = ex.components.find(c => c.type === 'resistor');
  assert.strictEqual(resistor.params.resistance, 2, 'resistor should be 2Ω');
});

check('fuse-protects: fuse I²t accumulates under overcurrent', () => {
  const ex = loadExample('fuse-protects.json');
  // With 9V battery and 2Ω load (plus ~0.5Ω internal R), current ≈ 9/(2+0.5) ≈ 4A
  // This is way over 1A, should cause I²t accumulation
  const fuse = ex.components.find(c => c.type === 'fuse');
  runSim(ex.components, ex.wires, 0.15);
  // Fuse should accumulate I²t (even if not fully blown yet, which can be solver-dependent)
  assert.ok(fuse.state.i2t > 0.3, `fuse I²t should accumulate to >0.3, got ${fuse.state.i2t}`);
});

// Test 5: esp32-blink
check('esp32-blink: circuit loads with an ESP32 board', () => {
  const ex = loadExample('esp32-blink.json');
  const esp = ex.components.find(c => c.type === 'esp32');
  assert.ok(esp, 'esp32-blink should contain an esp32 component');
  assert.strictEqual(esp.params.sketchEnabled, true, 'sketch should be enabled');
  assert.ok(/pinMode\(2, OUTPUT\)/.test(esp.params.sketch), 'sketch should pinMode GPIO2 as OUTPUT');
  assert.ok(/digitalWrite\(2, HIGH\)/.test(esp.params.sketch), 'sketch should drive GPIO2 high');
  const led = ex.components.find(c => c.type === 'led');
  assert.ok(led, 'esp32-blink should contain an LED');
  const resistor = ex.components.find(c => c.type === 'resistor');
  assert.ok(resistor, 'esp32-blink should contain a series resistor');
});

check('esp32-blink: board powers up and GPIO2 blinks the LED', () => {
  const ex = loadExample('esp32-blink.json');
  const esp = ex.components.find(c => c.type === 'esp32');
  const led = ex.components.find(c => c.type === 'led');
  let sawHigh = false, sawLow = false;
  assignNodes(ex.components, ex.wires);
  const sim = new Simulation();
  sim.setNetlist(ex.components);
  const dt = 50e-6;
  const steps = Math.round(2.0 / dt); // cover a full 1Hz blink cycle
  for (let i = 0; i < steps; i++) {
    sim.step(dt);
    if (led.state.brightness > 0.3) sawHigh = true;
    if (led.state.brightness < 0.05) sawLow = true;
  }
  assert.ok(!esp.state.brownout, `board should be powered, brownout=${esp.state.brownout}`);
  assert.ok(!esp.state.failed, `board should survive, failed=${esp.state.failed}`);
  assert.ok(!led.state.failed, `LED should survive, failed=${led.state.failureMsg}`);
  assert.ok(sawHigh, 'LED should light up during the blink high phase');
  assert.ok(sawLow, 'LED should go dark during the blink low phase');
});

// Verify that all example files exist and have required structure
check('all example files exist and are valid JSON', () => {
  const examples = ['led-basics.json', 'led-killer.json', 'motor-stall.json', 'fuse-protects.json', 'esp32-blink.json'];
  for (const name of examples) {
    assert.ok(fs.existsSync(path.join(examplesDir, name)), `${name} should exist`);
    const data = JSON.parse(fs.readFileSync(path.join(examplesDir, name), 'utf8'));
    assert.ok(data.version, `${name} should have version field`);
    assert.ok(data.circuit, `${name} should have circuit field`);
    assert.ok(Array.isArray(data.circuit.components), `${name} components should be array`);
    assert.ok(Array.isArray(data.circuit.wires), `${name} wires should be array`);
    // Check all components have required fields
    for (const comp of data.circuit.components) {
      assert.ok(comp.id, `component missing id in ${name}`);
      assert.ok(comp.type, `component missing type in ${name}`);
      assert.ok(typeof comp.x === 'number', `component missing x in ${name}`);
      assert.ok(typeof comp.y === 'number', `component missing y in ${name}`);
      assert.ok(typeof comp.rot === 'number', `component missing rot in ${name}`);
      assert.ok(typeof comp.params === 'object', `component missing params in ${name}`);
      assert.ok(typeof comp.ratings === 'object', `component missing ratings in ${name}`);
      assert.ok(typeof comp.state === 'object', `component missing state in ${name}`);
    }
    // Check all wires have required fields
    for (const wire of data.circuit.wires) {
      assert.ok(wire.id, `wire missing id in ${name}`);
      assert.ok(Array.isArray(wire.points), `wire missing points array in ${name}`);
    }
  }
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll example validation checks passed.');
