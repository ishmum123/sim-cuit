// test/engine.test.mjs — Node test script for the CircuitForge engine.
// Run: node test/engine.test.mjs
// No framework; uses assert + console.log; exits nonzero on failure.

import assert from 'node:assert/strict';
import { Simulation } from '../js/engine/solver.js';
import { ComponentRegistry, createComponent, resetIdCounters, repair } from '../js/engine/components.js';

let passCount = 0;
function pass(name) { passCount++; console.log(`  ok - ${name}`); }
function section(name) { console.log(`\n${name}`); }

function mk(type, x, y) {
  const c = createComponent(type, x, y);
  return c;
}

function runFor(sim, dt, steps) {
  for (let i = 0; i < steps; i++) sim.step(dt);
}

// ---------------------------------------------------------------------------
section('1. Voltage divider DC accuracy');
// 9V battery -- R1 1000 -- node1 -- R2 1000 -- ground; battery- also to ground
{
  resetIdCounters();
  const bat = mk('battery', 0, 0); bat.params.voltage = 9; bat.params.internalResistance = 0.01;
  const r1 = mk('resistor', 1, 0); r1.params.resistance = 1000;
  const r2 = mk('resistor', 2, 0); r2.params.resistance = 1000;
  // nodes: 0=ground, 1=bat+/r1, 2=r1/r2 midpoint
  bat.nodes = [1, 0];
  r1.nodes = [1, 2];
  r2.nodes = [2, 0];
  const sim = new Simulation();
  sim.setNetlist([bat, r1, r2]);
  runFor(sim, 1e-4, 200);
  const vMid = sim.nodeVoltages[2];
  assert.ok(Math.abs(vMid - 4.5) < 0.05, `expected ~4.5V at midpoint, got ${vMid}`);
  pass(`divider midpoint ${vMid.toFixed(3)}V ~= 4.5V`);
}

// ---------------------------------------------------------------------------
section('2. 9V battery + 220R + red LED: current in range, LED survives');
{
  resetIdCounters();
  const bat = mk('battery', 0, 0); bat.params.voltage = 9; bat.params.internalResistance = 0.1;
  const r1 = mk('resistor', 1, 0); r1.params.resistance = 220;
  const led = mk('led', 2, 0); led.params.color = 'red'; led.params.vf = 2.0; led.params.rs = 2;
  bat.nodes = [1, 0];
  r1.nodes = [1, 2];
  led.nodes = [2, 0];
  const sim = new Simulation();
  sim.setNetlist([bat, r1, led]);
  runFor(sim, 1e-5, 500);
  const iMa = Math.abs(led.state.i) * 1000;
  assert.ok(iMa >= 28 && iMa <= 32, `expected 28-32mA through LED, got ${iMa.toFixed(2)}mA`);
  assert.ok(!led.state.failed, `LED should survive at rated current, failed=${led.state.failed}`);
  assert.ok(led.state.brightness > 0.9, `LED should be near full brightness (at its limit), got ${led.state.brightness}`);
  pass(`LED current ${iMa.toFixed(2)}mA in range, survives, brightness=${led.state.brightness.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('3. 9V direct to LED (no series resistor besides rs=2) fuses open fast');
{
  resetIdCounters();
  const bat = mk('battery', 0, 0); bat.params.voltage = 9; bat.params.internalResistance = 0.1;
  const led = mk('led', 1, 0); led.params.color = 'red'; led.params.vf = 2.0; led.params.rs = 2;
  bat.nodes = [1, 0];
  led.nodes = [1, 0];
  const sim = new Simulation();
  sim.setNetlist([bat, led]);
  const dt = 1e-5;
  let failedAtStep = -1;
  for (let i = 0; i < 2000; i++) {
    sim.step(dt);
    if (led.state.failed && failedAtStep < 0) failedAtStep = i;
  }
  assert.ok(led.state.failed === 'open', `LED should fail open under direct 9V, failed=${led.state.failed}`);
  assert.ok(failedAtStep >= 0 && failedAtStep * dt <= 0.05, `LED should fuse within a few ms, failed at step ${failedAtStep} (${(failedAtStep*dt*1000).toFixed(2)}ms)`);
  const iAfter = Math.abs(led.state.i);
  assert.ok(iAfter < 1e-6, `current should be ~0 after fusing open, got ${iAfter}`);
  pass(`LED fused open at t=${(failedAtStep*dt*1000).toFixed(3)}ms, current after = ${iAfter.toExponential(2)}A`);
}

// ---------------------------------------------------------------------------
section('4. RC charging curve ~63% at t=RC');
{
  resetIdCounters();
  const bat = mk('battery', 0, 0); bat.params.voltage = 10; bat.params.internalResistance = 0.001;
  const r1 = mk('resistor', 1, 0); r1.params.resistance = 1000;
  const cap = mk('capacitor', 2, 0); cap.params.capacitance = 100e-6; cap.params.polarized = false;
  bat.nodes = [1, 0];
  r1.nodes = [1, 2];
  cap.nodes = [2, 0];
  const sim = new Simulation();
  sim.setNetlist([bat, r1, cap]);
  const RC = 1000 * 100e-6; // 0.1s
  const dt = RC / 2000;
  const steps = Math.round(RC / dt);
  runFor(sim, dt, steps);
  const vCap = sim.nodeVoltages[2];
  const expected = 10 * (1 - Math.exp(-1)); // 63.2%
  assert.ok(Math.abs(vCap - expected) < 0.3, `expected ~${expected.toFixed(2)}V at t=RC, got ${vCap.toFixed(2)}V`);
  pass(`cap voltage at t=RC: ${vCap.toFixed(3)}V (expected ~${expected.toFixed(3)}V)`);
}

// ---------------------------------------------------------------------------
section('5. Motor below start voltage stalls; above rated spins up');
{
  resetIdCounters();
  // motor: R=3, ke=kt=0.01, friction=5e-3 (see components.js note on deviation)
  const bat = mk('battery', 0, 0); bat.params.voltage = 1.5; bat.params.internalResistance = 0.05;
  const mot = mk('motor', 1, 0);
  bat.nodes = [1, 0];
  mot.nodes = [1, 0];
  const sim = new Simulation();
  sim.setNetlist([bat, mot]);
  runFor(sim, 1e-3, 500); // 0.5s simulated
  assert.equal(mot.state.rpm, 0, `motor should not spin at 1.5V, rpm=${mot.state.rpm}`);
  const expectedStall = 1.5 / mot.params.resistance;
  assert.ok(Math.abs(Math.abs(mot.state.i) - expectedStall) < 0.02, `expected stall current ~${expectedStall.toFixed(3)}A, got ${Math.abs(mot.state.i).toFixed(3)}A`);
  pass(`motor at 1.5V: rpm=${mot.state.rpm}, stall current=${Math.abs(mot.state.i).toFixed(3)}A ~= ${expectedStall.toFixed(3)}A`);

  resetIdCounters();
  const bat2 = mk('battery', 0, 0); bat2.params.voltage = 9; bat2.params.internalResistance = 0.05;
  const mot2 = mk('motor', 1, 0);
  bat2.nodes = [1, 0];
  mot2.nodes = [1, 0];
  const sim2 = new Simulation();
  sim2.setNetlist([bat2, mot2]);
  runFor(sim2, 1e-3, 500);
  assert.ok(mot2.state.rpm > 0, `motor should spin up at 9V, rpm=${mot2.state.rpm}`);
  assert.ok(mot2.state.spinning === true, `motor state.spinning should be true`);
  pass(`motor at 9V spun up: rpm=${mot2.state.rpm.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('6. Resistor over power rating fails open with failureMsg');
{
  resetIdCounters();
  // 0.25W-rated resistor, drive ~1W through it (4x rated)
  // P = V^2/R -> choose R=10, V = sqrt(1*10) = ~3.16V across resistor.
  const bat = mk('battery', 0, 0); bat.params.voltage = 3.16; bat.params.internalResistance = 0.001;
  const r1 = mk('resistor', 1, 0); r1.params.resistance = 10; r1.ratings.maxPower = 0.25;
  bat.nodes = [1, 0];
  r1.nodes = [1, 0];
  const sim = new Simulation();
  sim.setNetlist([bat, r1]);
  const dt = 1e-3;
  let failedAtStep = -1;
  for (let i = 0; i < 3000; i++) { // up to 3s simulated
    sim.step(dt);
    if (r1.state.failed && failedAtStep < 0) { failedAtStep = i; break; }
  }
  assert.equal(r1.state.failed, 'open', `resistor should fail open, failed=${r1.state.failed}`);
  assert.ok(r1.state.failureMsg && r1.state.failureMsg.length > 0, 'failureMsg should be set');
  const failTime = failedAtStep * dt;
  assert.ok(failTime >= 0.5 && failTime <= 2.5, `expected burn-open in ~1-2s, got ${failTime.toFixed(2)}s`);
  pass(`resistor failed open at t=${failTime.toFixed(2)}s: "${r1.state.failureMsg}"`);
}

// ---------------------------------------------------------------------------
section('7. Fuse blows past rating');
{
  resetIdCounters();
  const bat = mk('battery', 0, 0); bat.params.voltage = 5; bat.params.internalResistance = 0.001;
  const fuse = mk('fuse', 1, 0); fuse.params.ratedCurrent = 1;
  const r1 = mk('resistor', 2, 0); r1.params.resistance = 2; // ~2.5A through fuse, 2.5x rated
  r1.ratings.maxPower = 100; // don't let the load resistor itself burn out mid-test
  bat.nodes = [1, 0];
  fuse.nodes = [1, 2];
  r1.nodes = [2, 0];
  const sim = new Simulation();
  sim.setNetlist([bat, fuse, r1]);
  const dt = 1e-3;
  let failedAtStep = -1;
  for (let i = 0; i < 5000; i++) {
    sim.step(dt);
    if (fuse.state.failed && failedAtStep < 0) { failedAtStep = i; break; }
  }
  assert.equal(fuse.state.failed, 'open', `fuse should blow open, failed=${fuse.state.failed}`);
  assert.ok(failedAtStep > 0, 'fuse should not blow instantly');
  pass(`fuse blown at t=${(failedAtStep*dt).toFixed(3)}s`);
}

// ---------------------------------------------------------------------------
section('8. Polarized capacitor on reverse voltage fails short');
{
  resetIdCounters();
  const bat = mk('battery', 0, 0); bat.params.voltage = 9; bat.params.internalResistance = 1;
  const cap = mk('capacitor', 1, 0); cap.params.capacitance = 100e-6; cap.params.polarized = true;
  // wire battery reversed relative to cap's node order so cap sees negative V
  bat.nodes = [0, 1]; // battery + at ground node, - at node1 -> node1 is negative relative to 0
  cap.nodes = [1, 0]; // cap.v = V(1)-V(0) will be negative
  const sim = new Simulation();
  sim.setNetlist([bat, cap]);
  runFor(sim, 1e-3, 500);
  assert.equal(cap.state.failed, 'short', `cap should fail short on reverse voltage, failed=${cap.state.failed}`);
  assert.ok(cap.state.failureMsg && /revers/i.test(cap.state.failureMsg), `failureMsg should mention reverse: "${cap.state.failureMsg}"`);
  pass(`cap failed short: "${cap.state.failureMsg}"`);
}

// ---------------------------------------------------------------------------
section('9. Robustness: floating node / no ground does not throw or NaN');
{
  resetIdCounters();
  const r1 = mk('resistor', 0, 0); r1.params.resistance = 100;
  r1.nodes = [1, 2]; // both nodes floating, no ground reference at all
  const sim = new Simulation();
  sim.setNetlist([r1]);
  assert.doesNotThrow(() => runFor(sim, 1e-3, 50), 'floating netlist must not throw');
  for (const v of sim.nodeVoltages) assert.ok(isFinite(v), 'node voltages must stay finite');
  pass('floating-node circuit ran without throwing or NaN');
}

// ---------------------------------------------------------------------------
section('10. Repair clears failure state');
{
  resetIdCounters();
  const r1 = mk('resistor', 0, 0);
  r1.state.failed = 'open';
  r1.state.failureMsg = 'test';
  r1.state.temp = 1;
  repair(r1);
  assert.equal(r1.state.failed, null, 'repair should clear failed');
  assert.equal(r1.state.temp, 0, 'repair should clear temp');
  pass('repair() clears failure/thermal state');
}

// ---------------------------------------------------------------------------
console.log(`\n${passCount} checks passed.`);
process.exit(0);
