// Sim-cuit end-to-end test: the starter circuit (battery → switch → 220Ω →
// LED → ground) through node extraction + solver, including the "remove the
// resistor and the LED dies" scenario. Run: node test/integration.test.mjs
import assert from 'node:assert';
import { Simulation } from '../js/engine/solver.js';
import { createComponent, resetIdCounters } from '../js/engine/components.js';
import { assignNodes } from '../js/engine/netlist.js';
import { moveComponentsWithWires } from '../js/ui/dragwires.js';

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

check('wire tapping: a wire ending mid-segment on another wire is one net', () => {
  // Mirrors what Editor._spliceTapIntoWire()+_completeWire() actually do:
  // splice the tap point into the tapped wire's `points` array at the
  // segment's index, and use that exact same point as the new wire's own
  // endpoint. Two independent wires with no coincident vertex would NOT be
  // connected (documented "crossing wires" behavior in netlist.js) — the
  // splice is what turns a tap into a real shared vertex.
  resetIdCounters();
  // Unrotated battery: terminalOffsets = [(-40,0), (40,0)] i.e. terminal 0
  // (positive) sits at world (60,100) and terminal 1 (negative) at (140,100).
  const bat = createComponent('battery', 100, 100);  // terminals (60,100)+, (140,100)-
  const r1 = createComponent('resistor', 300, 100);  // terminals (260,100),(340,100)
  const gnd = createComponent('ground', 460, 340);   // terminal (460,300)

  // wireA runs straight from battery− to the resistor's left terminal — the
  // tap point (200,100) sits mid-segment, not at either endpoint.
  const wireA = { id: 'w1', points: [{ x: 140, y: 100 }, { x: 260, y: 100 }] };
  const tapPoint = { x: 200, y: 100 };
  const segIndex = 0; // wireA's only segment: (140,100)->(260,100)
  wireA.points.splice(segIndex + 1, 0, { x: tapPoint.x, y: tapPoint.y });

  // splice kept the polyline in valid order: original endpoints intact, tap
  // point inserted strictly between them
  assert.deepStrictEqual(wireA.points, [{ x: 140, y: 100 }, { x: 200, y: 100 }, { x: 260, y: 100 }]);

  // wireB is the "new wire" a user draws from the tap down and across to
  // ground, using the exact same tapPoint as its own endpoint — this is what
  // gives union-find a shared vertex key with wireA.
  const wireB = { id: 'w2', points: [{ x: 200, y: 100 }, { x: 200, y: 300 }, { x: 460, y: 300 }] };

  const { ok } = assignNodes([bat, r1, gnd], [wireA, wireB]);
  assert.ok(ok);
  assert.strictEqual(bat.nodes[1], r1.nodes[0], 'battery− and resistor share the tapped net');
  assert.strictEqual(bat.nodes[1], gnd.nodes[0], 'the tap also joins that net to ground -> node 0');
  assert.strictEqual(bat.nodes[1], 0, 'ground pins the shared/tapped net to node 0');
});

check('splice preserves polyline validity for a multi-bend tapped wire', () => {
  // Tapping into the middle segment of a 3-segment (4-point) wire must only
  // insert the new vertex between that segment's own endpoints, leaving the
  // rest of the polyline's order untouched.
  const wire = { id: 'w', points: [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }] };
  const segIndex = 1; // the (0,100)->(100,100) segment
  const tap = { x: 50, y: 100 };
  wire.points.splice(segIndex + 1, 0, { x: tap.x, y: tap.y });
  assert.deepStrictEqual(wire.points, [
    { x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 },
  ]);
  // every consecutive pair still forms a valid axis-aligned segment
  for (let i = 1; i < wire.points.length; i++) {
    const a = wire.points[i - 1], b = wire.points[i];
    assert.ok(a.x === b.x || a.y === b.y, `segment ${i} is not axis-aligned`);
  }
});

check('drag: moving one component keeps its wires connected and axis-aligned', () => {
  const c = starter();
  const compsIn = c.components.map(x => ({ id: x.id, x: x.x, y: x.y, type: x.type, rot: x.rot }));

  const { components: movedComps, wires: movedWires } =
    moveComponentsWithWires(compsIn, c.wires, [c.res.id], 0, 80);

  for (const mc of movedComps) {
    const comp = c.components.find(x => x.id === mc.id);
    comp.x = mc.x; comp.y = mc.y;
  }
  const { ok } = assignNodes(c.components, movedWires);
  assert.ok(ok);
  assert.strictEqual(c.sw.nodes[1], c.res.nodes[0], 'switch still wired to resistor after drag');
  assert.strictEqual(c.res.nodes[1], c.led.nodes[0], 'resistor still wired to LED anode after drag');
  for (const w of movedWires) {
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1], b = w.points[i];
      assert.ok(a.x === b.x || a.y === b.y, `wire ${w.id} segment ${i} not axis-aligned`);
    }
  }
});

check('drag: a vertex tapped from a non-dragged wire stays put; only the moving end reroutes', () => {
  resetIdCounters();
  const bat = createComponent('battery', 100, 100);   // terminals (60,100), (140,100)
  const res = createComponent('resistor', 260, 200);  // terminals (220,200), (300,200)
  // wireH is an independent run with a tap already spliced in at (220,100);
  // none of its vertices sit on a dragged terminal, so it must not change.
  const wireH = { id: 'h', points: [{ x: 140, y: 100 }, { x: 220, y: 100 }, { x: 300, y: 100 }] };
  // wireW taps off wireH's spliced vertex down to the resistor's left terminal.
  const wireW = { id: 'w', points: [{ x: 220, y: 100 }, { x: 220, y: 200 }] };
  const wireHBefore = JSON.parse(JSON.stringify(wireH.points));

  const compsIn = [bat, res].map(x => ({ id: x.id, x: x.x, y: x.y, type: x.type, rot: x.rot }));
  const { wires: movedWires } = moveComponentsWithWires(compsIn, [wireH, wireW], [res.id], 40, 0);

  const newH = movedWires.find(w => w.id === 'h');
  const newW = movedWires.find(w => w.id === 'w');
  assert.deepStrictEqual(newH.points, wireHBefore, 'untouched wire must stay exactly put');
  // wireW's tap end (shared with wireH) stays; its resistor end follows the drag
  assert.deepStrictEqual(newW.points[0], { x: 220, y: 100 }, 'tap end anchored to the untouched wire stays put');
  assert.deepStrictEqual(newW.points[newW.points.length - 1], { x: 260, y: 200 }, 'moving end follows the resistor');
  for (let i = 1; i < newW.points.length; i++) {
    const a = newW.points[i - 1], b = newW.points[i];
    assert.ok(a.x === b.x || a.y === b.y, `wireW segment ${i} not axis-aligned`);
  }
});

check('drag: dragging both endpoints\' components translates the connecting wire rigidly', () => {
  resetIdCounters();
  const res = createComponent('resistor', 200, 100); // terminals (160,100),(240,100)
  const led = createComponent('led', 380, 100);       // terminals (340,100),(420,100)
  const wire = { id: 'w1', points: [{ x: 240, y: 100 }, { x: 340, y: 100 }] };

  const compsIn = [res, led].map(x => ({ id: x.id, x: x.x, y: x.y, type: x.type, rot: x.rot }));
  const { wires: movedWires } = moveComponentsWithWires(compsIn, [wire], [res.id, led.id], 0, 60);

  assert.deepStrictEqual(movedWires[0].points, [{ x: 240, y: 160 }, { x: 340, y: 160 }],
    'wire between two dragged components translates rigidly, unchanged shape');
});

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('All integration checks passed.');
