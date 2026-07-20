// Sim-cuit end-to-end test: the starter circuit (battery → switch → 220Ω →
// LED → ground) through node extraction + solver, including the "remove the
// resistor and the LED dies" scenario. Run: node test/integration.test.mjs
import assert from 'node:assert';
import { Simulation } from '../js/engine/solver.js';
import { createComponent, resetIdCounters } from '../js/engine/components.js';
import { assignNodes } from '../js/engine/netlist.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failures++; console.error(`  FAIL - ${name}: ${e.message}`); }
}

function starter() {
  resetIdCounters();
  const bat = createComponent('battery', 200, 300);
  const sw = createComponent('switch', 340, 200);
  const res = createComponent('resistor', 480, 200);
  const led = createComponent('led', 620, 300);
  const gnd = createComponent('ground', 420, 440);
  bat.rot = 90; led.rot = 90;
  res.params.resistance = 220;
  const wires = [
    { id: 'w1', points: [{ x: 200, y: 260 }, { x: 200, y: 200 }, { x: 300, y: 200 }] },
    { id: 'w2', points: [{ x: 380, y: 200 }, { x: 440, y: 200 }] },
    { id: 'w3', points: [{ x: 520, y: 200 }, { x: 620, y: 200 }, { x: 620, y: 260 }] },
    { id: 'w4', points: [{ x: 620, y: 340 }, { x: 620, y: 400 }, { x: 420, y: 400 }] },
    { id: 'w5', points: [{ x: 200, y: 340 }, { x: 200, y: 400 }, { x: 420, y: 400 }] },
  ];
  return { components: [bat, sw, res, led, gnd], wires, bat, sw, res, led, gnd };
}

function run(sim, seconds, dt = 50e-6) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) sim.step(dt);
}

console.log('Sim-cuit integration tests');

check('node extraction: ground pinned, terminals share nets through wires', () => {
  const c = starter();
  const { ok, warning } = assignNodes(c.components, c.wires);
  assert.ok(ok);
  assert.strictEqual(warning, null);
  assert.strictEqual(c.gnd.nodes[0], 0);
  assert.strictEqual(c.bat.nodes[1], 0, 'battery − on ground net');
  assert.strictEqual(c.led.nodes[1], 0, 'LED cathode on ground net');
  assert.strictEqual(c.bat.nodes[0], c.sw.nodes[0], 'battery + wired to switch');
  assert.strictEqual(c.sw.nodes[1], c.res.nodes[0], 'switch wired to resistor');
  assert.strictEqual(c.res.nodes[1], c.led.nodes[0], 'resistor wired to LED anode');
});

check('switch open: no current; closed: LED lights at ~28–32 mA and survives', () => {
  const c = starter();
  assignNodes(c.components, c.wires);
  const sim = new Simulation();
  sim.setNetlist(c.components);
  run(sim, 0.05);
  assert.ok(Math.abs(c.led.state.i) < 1e-6, `open switch leaks ${c.led.state.i} A`);
  c.sw.params.closed = true;
  run(sim, 0.3);
  assert.ok(c.led.state.i > 0.028 && c.led.state.i < 0.032,
    `LED current ${(c.led.state.i * 1e3).toFixed(1)} mA`);
  assert.strictEqual(c.led.state.failed, null);
  assert.ok(c.led.state.brightness > 0.8, `brightness ${c.led.state.brightness}`);
});

check('resistor removed: LED fuses open with a failure message', () => {
  const c = starter();
  c.sw.params.closed = true;
  // replace resistor with a wire (as a user would by deleting it and bridging)
  const comps = c.components.filter((x) => x.id !== c.res.id);
  c.wires.push({ id: 'w6', points: [{ x: 440, y: 200 }, { x: 520, y: 200 }] });
  assignNodes(comps, c.wires);
  const sim = new Simulation();
  sim.setNetlist(comps);
  run(sim, 0.5);
  assert.strictEqual(c.led.state.failed, 'open', 'LED should fuse');
  assert.ok(/fus|max|mA|current/i.test(c.led.state.failureMsg || ''), `msg: ${c.led.state.failureMsg}`);
  assert.ok(Math.abs(c.led.state.i) < 1e-6, 'no current after fusing');
});

check('no-ground fallback: battery negative becomes reference with warning', () => {
  const c = starter();
  const comps = c.components.filter((x) => x.type !== 'ground');
  const { warning } = assignNodes(comps, c.wires);
  assert.ok(warning && /ground/i.test(warning));
  assert.strictEqual(c.bat.nodes[1], 0);
});

check('mid-segment terminal connection: tap onto a wire segment joins the net', () => {
  resetIdCounters();
  const bat = createComponent('battery', 100, 100);      // terminals (60,100),(140,100)
  const r1 = createComponent('resistor', 300, 100);      // terminals (260,100),(340,100)
  const gnd = createComponent('ground', 200, 140);       // terminal (200,100) — mid-segment
  const wires = [
    { id: 'w1', points: [{ x: 140, y: 100 }, { x: 260, y: 100 }] },
    { id: 'w2', points: [{ x: 340, y: 100 }, { x: 340, y: 160 }, { x: 60, y: 160 }, { x: 60, y: 100 }] },
  ];
  assignNodes([bat, r1, gnd], wires);
  assert.strictEqual(bat.nodes[1], 0, 'wire through mid-segment ground tap is node 0');
  assert.strictEqual(r1.nodes[0], 0);
});

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('All integration checks passed.');
