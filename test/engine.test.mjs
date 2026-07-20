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
section('11. NPN transistor as a switch: base drive turns on a collector load');
{
  resetIdCounters();
  // Vcc=9V -- Rc=220 -- collector; base driven via Rb=1000 from a 5V rail;
  // emitter grounded. With no base drive the load resistor should see ~0
  // current; with 5V base drive the transistor should conduct and pull the
  // collector down from Vcc.
  const vcc = mk('battery', 0, 0); vcc.params.voltage = 9; vcc.params.internalResistance = 0.01;
  const rc = mk('resistor', 1, 0); rc.params.resistance = 220;
  const vbb = mk('battery', 2, 0); vbb.params.voltage = 5; vbb.params.internalResistance = 0.01;
  const rb = mk('resistor', 3, 0); rb.params.resistance = 1000;
  const q = mk('npn', 4, 0);
  vcc.nodes = [1, 0];
  rc.nodes = [1, 2];
  vbb.nodes = [3, 0];
  rb.nodes = [3, 4];
  q.nodes = [2, 4, 0]; // collector, base, emitter
  const sim = new Simulation();
  sim.setNetlist([vcc, rc, vbb, rb, q]);
  runFor(sim, 1e-5, 3000);
  const vc = sim.nodeVoltages[2];
  assert.ok(!q.state.failed, `transistor should survive normal switching, failed=${q.state.failed}`);
  assert.ok(q.state.ib > 0.001, `base current should be flowing with 5V base drive, got ${q.state.ib}`);
  assert.ok(q.state.i > 0.0005, `collector current should be flowing (load turned on), got ${q.state.i}`);
  assert.ok(vc < 8, `collector voltage should sag well below Vcc=9V when driven on, got ${vc.toFixed(2)}V`);
  pass(`NPN switch: Ib=${(q.state.ib * 1000).toFixed(2)}mA, Ic=${(q.state.i * 1000).toFixed(2)}mA, Vc=${vc.toFixed(2)}V`);
}

// ---------------------------------------------------------------------------
section('12. NPN transistor burns out past its power/current ratings');
{
  resetIdCounters();
  const vcc = mk('battery', 0, 0); vcc.params.voltage = 40; vcc.params.internalResistance = 0.01;
  const rc = mk('resistor', 1, 0); rc.params.resistance = 50;
  const vbb = mk('battery', 2, 0); vbb.params.voltage = 5; vbb.params.internalResistance = 0.01;
  const rb = mk('resistor', 3, 0); rb.params.resistance = 1000;
  const q = mk('npn', 4, 0);
  vcc.nodes = [1, 0]; rc.nodes = [1, 2]; vbb.nodes = [3, 0]; rb.nodes = [3, 4]; q.nodes = [2, 4, 0];
  const sim = new Simulation();
  sim.setNetlist([vcc, rc, vbb, rb, q]);
  const dt = 1e-4;
  let failedAt = -1;
  for (let i = 0; i < 5000; i++) {
    sim.step(dt);
    if (q.state.failed && failedAt < 0) { failedAt = i; break; }
  }
  assert.equal(q.state.failed, 'short', `transistor should burn out shorted C-E, failed=${q.state.failed}`);
  assert.ok(q.state.failureMsg && /mW|max/i.test(q.state.failureMsg), `failureMsg should describe the overage: ${q.state.failureMsg}`);
  assert.ok(failedAt > 0, 'burnout should not be instantaneous');
  pass(`NPN burned out at t=${(failedAt * dt).toFixed(3)}s: "${q.state.failureMsg}"`);
}

// ---------------------------------------------------------------------------
section('13. MOSFET gate oxide punch-through on overvoltage Vgs');
{
  resetIdCounters();
  const vgg = mk('battery', 0, 0); vgg.params.voltage = 25; vgg.params.internalResistance = 1;
  const m = mk('nmos', 1, 0);
  const vdd = mk('battery', 2, 0); vdd.params.voltage = 5; vdd.params.internalResistance = 1;
  const rd = mk('resistor', 3, 0); rd.params.resistance = 1000;
  vgg.nodes = [1, 0];
  vdd.nodes = [4, 0];
  rd.nodes = [4, 5];
  m.nodes = [5, 1, 0]; // drain, gate, source
  const sim = new Simulation();
  sim.setNetlist([vgg, vdd, rd, m]);
  runFor(sim, 1e-4, 50);
  assert.equal(m.state.failed, 'short', `MOSFET should fail short from gate punch-through, failed=${m.state.failed}`);
  assert.ok(m.state.failureMsg && /punch|Vgs/i.test(m.state.failureMsg), `failureMsg should mention Vgs punch-through: ${m.state.failureMsg}`);
  pass(`MOSFET punch-through: "${m.state.failureMsg}"`);
}

// ---------------------------------------------------------------------------
section('14. MOSFET as a switch (normal Vgs, survives and conducts)');
{
  resetIdCounters();
  const vgg = mk('battery', 0, 0); vgg.params.voltage = 5; vgg.params.internalResistance = 1;
  const m = mk('nmos', 1, 0);
  const vdd = mk('battery', 2, 0); vdd.params.voltage = 9; vdd.params.internalResistance = 0.1;
  const rd = mk('resistor', 3, 0); rd.params.resistance = 220;
  vgg.nodes = [1, 0];
  vdd.nodes = [4, 0];
  rd.nodes = [4, 5];
  m.nodes = [5, 1, 0];
  const sim = new Simulation();
  sim.setNetlist([vgg, vdd, rd, m]);
  runFor(sim, 1e-5, 3000);
  assert.ok(!m.state.failed, `MOSFET should survive normal switching, failed=${m.state.failed}`);
  assert.ok(m.state.i > 0.01, `drain current should flow when gate is driven on, got ${m.state.i}`);
  pass(`MOSFET switch: Id=${(m.state.i * 1000).toFixed(2)}mA, Vd=${sim.nodeVoltages[5].toFixed(3)}V`);
}

// ---------------------------------------------------------------------------
section('15. Zener diode clamps at ~5.1V in reverse breakdown');
{
  resetIdCounters();
  const bat = mk('battery', 0, 0); bat.params.voltage = 12; bat.params.internalResistance = 0.1;
  const r1 = mk('resistor', 1, 0); r1.params.resistance = 1000;
  const z = mk('zener', 2, 0); z.params.vz = 5.1;
  bat.nodes = [3, 0];
  r1.nodes = [3, 1];
  z.nodes = [0, 1]; // anode=gnd, cathode=node1 (reverse biased -> breakdown)
  const sim = new Simulation();
  sim.setNetlist([bat, r1, z]);
  runFor(sim, 1e-4, 2000);
  const vCathode = sim.nodeVoltages[1];
  assert.ok(Math.abs(vCathode - 5.1) < 0.6, `zener should clamp near 5.1V, got ${vCathode.toFixed(2)}V`);
  assert.ok(!z.state.failed, `zener should survive within rating, failed=${z.state.failed}`);
  pass(`Zener clamps at ${vCathode.toFixed(2)}V (rated 5.1V)`);
}

// ---------------------------------------------------------------------------
section('16. ESP32 GPIO high through a resistor lights an LED at 3.3V logic level');
{
  resetIdCounters();
  const esp = mk('esp32', 0, 0);
  esp.params.gpio2Mode = 'high';
  const vin = mk('battery', 1, 0); vin.params.voltage = 5; vin.params.internalResistance = 0.1;
  const r1 = mk('resistor', 2, 0); r1.params.resistance = 150;
  const led = mk('led', 3, 0); led.params.color = 'green';
  vin.nodes = [10, 0];
  esp.nodes = [10, 0, 11, 12, 13, 14]; // VIN,GND,3V3,GPIO2,GPIO4,GPIO5
  r1.nodes = [12, 20];
  led.nodes = [20, 0];
  const sim = new Simulation();
  sim.setNetlist([vin, r1, led, esp]);
  runFor(sim, 1e-5, 3000);
  assert.ok(!esp.state.brownout, `board should be powered via VIN, brownout=${esp.state.brownout}`);
  assert.ok(!esp.state.failed, `board should survive normal use, failed=${esp.state.failed}`);
  assert.ok(led.state.brightness > 0.1, `LED should light from GPIO2 high, brightness=${led.state.brightness}`);
  assert.ok(!led.state.failed, `LED should not fuse at logic-level current, failed=${led.state.failed}`);
  pass(`ESP32 GPIO2 high lights LED: I=${(led.state.i * 1000).toFixed(2)}mA, brightness=${led.state.brightness.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('17. ESP32 GPIO pin fuses open when shorted to GND (overcurrent)');
{
  resetIdCounters();
  const esp = mk('esp32', 0, 0);
  esp.params.gpio4Mode = 'high';
  const vin = mk('battery', 1, 0); vin.params.voltage = 5; vin.params.internalResistance = 0.1;
  const short = mk('resistor', 2, 0); short.params.resistance = 0.5; // near dead short to GND
  vin.nodes = [10, 0];
  esp.nodes = [10, 0, 11, 12, 13, 14];
  short.nodes = [13, 0]; // GPIO4 to gnd
  const sim = new Simulation();
  sim.setNetlist([vin, short, esp]);
  runFor(sim, 1e-5, 3000);
  assert.ok(!esp.state.failed, `board itself should stay alive (only the pin fuses), failed=${esp.state.failed}`);
  assert.ok(esp.state.pinFailed && esp.state.pinFailed.GPIO4, `GPIO4 should be marked pin-failed, pinFailed=${JSON.stringify(esp.state.pinFailed)}`);
  assert.ok(esp.state.failureMsg && /GPIO4/.test(esp.state.failureMsg), `failureMsg should mention GPIO4: ${esp.state.failureMsg}`);
  pass(`ESP32 GPIO4 fused: "${esp.state.failureMsg}"`);
}

// ---------------------------------------------------------------------------
section('18. ESP32 dies when a GPIO pin is driven past its absolute max voltage');
{
  resetIdCounters();
  const esp = mk('esp32', 0, 0);
  esp.params.gpio5Mode = 'input';
  const vin = mk('battery', 1, 0); vin.params.voltage = 5; vin.params.internalResistance = 0.1;
  const vext = mk('battery', 2, 0); vext.params.voltage = 5; vext.params.internalResistance = 100;
  vin.nodes = [10, 0];
  esp.nodes = [10, 0, 11, 12, 13, 14];
  vext.nodes = [14, 0]; // drives GPIO5 toward 5V through 100 ohm
  const sim = new Simulation();
  sim.setNetlist([vin, vext, esp]);
  runFor(sim, 1e-5, 3000);
  assert.equal(esp.state.failed, 'open', `board should die from GPIO overvoltage, failed=${esp.state.failed}`);
  assert.ok(esp.state.failureMsg && /GPIO5|3\.6/.test(esp.state.failureMsg), `failureMsg should mention the offending pin/limit: ${esp.state.failureMsg}`);
  pass(`ESP32 killed: "${esp.state.failureMsg}"`);
}

// ---------------------------------------------------------------------------
console.log(`\n${passCount} checks passed.`);
process.exit(0);
