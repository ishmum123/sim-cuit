/*
 * Sim-cuit — js/main.js
 * ---------------------------------------------------------------------------
 * Integration glue. Owns:
 *   - electrical node extraction (union-find over terminals + wire vertices,
 *     including terminals landing on the middle of an orthogonal wire segment)
 *   - the simulation loop (fixed physics dt, speed multiplier, rAF-driven)
 *   - top-bar wiring: Run/Pause, Reset, speed, Import modal, Export menu,
 *     Repair All
 *   - registering imported PartDefs as new ComponentRegistry entries
 */

import { Simulation } from './engine/solver.js';
import {
  ComponentRegistry, createComponent, repair,
} from './engine/components.js';
import { assignNodes } from './engine/netlist.js';
import { Editor } from './ui/editor.js';
import { Renderer } from './ui/render.js';
import { importFromUrl, importFromText } from './io/import.js';
import {
  toSpiceNetlist, toKicadNetlist, saveJson, loadJson, downloadText,
} from './io/export.js';

const canvas = document.getElementById('canvas');
const editor = new Editor(canvas, ComponentRegistry);
const renderer = new Renderer(canvas, editor);
const sim = new Simulation();

// ---------------------------------------------------------------------------
// Simulation loop
// ---------------------------------------------------------------------------

let running = false;
let speed = 1;           // sim-time multiplier
let netlistDirty = true;
let lastWarning = null;

const PHYS_DT = 50e-6;   // 50 µs physics step
const MAX_STEPS_PER_FRAME = 2000;

editor.onChange(() => { netlistDirty = true; });

function rebuildNetlist() {
  const { components, wires } = editor.getCircuit();
  const { warning } = assignNodes(components, wires);
  sim.setNetlist(components);
  if (warning && warning !== lastWarning) editor.showToast(warning, 'warn');
  lastWarning = warning;
  netlistDirty = false;
}

let lastT = null;
function frame(t) {
  if (running) {
    if (netlistDirty) rebuildNetlist();
    const wall = lastT === null ? 16 : Math.min(t - lastT, 50);
    const simTime = (wall / 1000) * speed;
    const steps = Math.min(Math.round(simTime / PHYS_DT), MAX_STEPS_PER_FRAME);
    for (let i = 0; i < steps; i++) sim.step(PHYS_DT);
  }
  lastT = t;
  editor.tick();
  renderer.draw(t);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const btnRun = $('btn-run');
btnRun.addEventListener('click', () => {
  running = !running;
  btnRun.textContent = running ? '⏸ Pause' : '▶ Run';
  btnRun.classList.toggle('active', running);
});

$('btn-reset').addEventListener('click', () => {
  running = false;
  btnRun.textContent = '▶ Run';
  btnRun.classList.remove('active');
  const { components } = editor.getCircuit();
  for (const c of components) {
    repair(c);
    Object.assign(c.state, { v: 0, i: 0, p: 0 });
    if ('rpm' in c.state) { c.state.rpm = 0; c.state.spinning = false; }
    if ('brightness' in c.state) c.state.brightness = 0;
  }
  sim.setNetlist([]);
  netlistDirty = true;
  editor.markDirty();
  editor.showToast('Simulation reset — all parts repaired.', 'info');
});

$('btn-repair-all').addEventListener('click', () => {
  const { components } = editor.getCircuit();
  let n = 0;
  for (const c of components) if (c.state.failed) { repair(c); n++; }
  editor.markDirty();
  editor.showToast(n ? `Repaired ${n} part${n > 1 ? 's' : ''}.` : 'Nothing to repair.', n ? 'ok' : 'info');
});

const speedSlider = $('sim-speed');
const speedValue = $('sim-speed-value');
if (speedSlider) {
  speedSlider.addEventListener('input', () => {
    speed = Number(speedSlider.value);
    if (speedValue) speedValue.textContent = `${speed}×`;
  });
  speed = Number(speedSlider.value) || 1;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const BASE_ALLOWLIST = ['led', 'diode', 'resistor', 'capacitor', 'motor', 'bulb', 'fuse'];

function registerParts(defs) {
  let added = 0;
  for (const def of defs) {
    const base = ComponentRegistry[def.base];
    if (!base) { editor.showToast(`Unknown base type "${def.base}" for ${def.name}`, 'error'); continue; }
    const typeKey = `imported_${def.name.replace(/[^A-Za-z0-9]+/g, '_')}`;
    ComponentRegistry[typeKey] = {
      ...base,
      label: def.name,
      imported: true,
      visualBase: def.base,
      defaultParams: { ...base.defaultParams, ...(def.params || {}) },
      defaultRatings: { ...base.defaultRatings, ...(def.ratings || {}) },
    };
    editor.registerImportedPart(typeKey);
    added++;
  }
  if (added) editor.showToast(`Imported ${added} part${added > 1 ? 's' : ''}.`, 'ok');
  return added;
}

const importModal = $('import-modal');
const importError = $('import-error');
const openImport = () => { importModal.hidden = false; importError.textContent = ''; };
const closeImport = () => { importModal.hidden = true; };

$('btn-import').addEventListener('click', openImport);
$('import-cancel').addEventListener('click', closeImport);
$('import-modal-close').addEventListener('click', closeImport);

$('import-url-btn').addEventListener('click', async () => {
  importError.textContent = '';
  const url = $('import-url').value.trim();
  if (!url) return;
  try {
    const defs = await importFromUrl(url);
    if (registerParts(defs)) closeImport();
  } catch (e) {
    importError.textContent = e.message;
  }
});

$('import-submit').addEventListener('click', () => {
  importError.textContent = '';
  const text = $('import-paste').value.trim();
  if (!text) return;
  try {
    const defs = importFromText(text);
    if (registerParts(defs)) closeImport();
  } catch (e) {
    importError.textContent = e.message;
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exportMenu = $('export-menu');
$('btn-export').addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.classList.toggle('open');
});
document.addEventListener('click', () => exportMenu.classList.remove('open'));

function exportPrep() {
  const { components, wires } = editor.getCircuit();
  const comps = components.filter((c) => c.type !== 'ground');
  assignNodes(components, wires);
  return comps;
}

$('export-kicad').addEventListener('click', () => {
  const comps = exportPrep();
  if (!comps.length) return editor.showToast('Nothing to export.', 'warn');
  downloadText('sim-cuit.net', toKicadNetlist(comps, (c) => c.nodes, ComponentRegistry));
  editor.showToast('KiCad netlist exported — import it in KiCad PCB editor (File → Import Netlist).', 'ok');
});

$('export-spice').addEventListener('click', () => {
  const comps = exportPrep();
  if (!comps.length) return editor.showToast('Nothing to export.', 'warn');
  downloadText('sim-cuit.cir', toSpiceNetlist(comps, (c) => c.nodes, ComponentRegistry));
  editor.showToast('SPICE netlist exported.', 'ok');
});

$('export-save-json').addEventListener('click', () => {
  downloadText('circuit.json', saveJson(editor.getCircuit()));
});

$('export-load-json').addEventListener('click', () => $('load-json-file').click());
$('load-json-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    editor.loadCircuit(loadJson(await file.text()));
    centerCameraOnCircuit();
    editor.showToast(`Loaded ${file.name}.`, 'ok');
  } catch (err) {
    editor.showToast(`Load failed: ${err.message}`, 'error');
  }
  e.target.value = '';
});

// ---------------------------------------------------------------------------
// Camera framing — center the loaded circuit's content in the viewport.
// editor._doResize() seeds camera.x/y so world-origin (0,0) lands at the
// canvas center, but circuits (e.g. the starter demo) are laid out at
// arbitrary world coordinates — so after loading a circuit we recompute the
// camera from the actual content bounding box instead of assuming it's near
// the origin. Scale is left at 1 (never touched by loadCircuit) so this
// doesn't fight the user's own pan/zoom once they start interacting.
// ---------------------------------------------------------------------------

function centerCameraOnCircuit() {
  const { components, wires } = editor.getCircuit();
  if (!components.length && !wires.length) return;
  const PAD = 60; // ~ half a component body, so symbols aren't flush to the edge
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of components) {
    minX = Math.min(minX, c.x - PAD); maxX = Math.max(maxX, c.x + PAD);
    minY = Math.min(minY, c.y - PAD); maxY = Math.max(maxY, c.y + PAD);
  }
  for (const w of wires) {
    for (const p of w.points || []) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const scale = editor.camera.scale || 1;
  editor.camera.x = editor.cssWidth / 2 - cx * scale;
  editor.camera.y = editor.cssHeight / 2 - cy * scale;
  editor.markDirty();
}

// ---------------------------------------------------------------------------
// Starter circuit — 9V battery, switch, 220Ω, red LED, ground
// ---------------------------------------------------------------------------

function starterCircuit() {
  const bat = createComponent('battery', 200, 300);
  const sw = createComponent('switch', 340, 200);
  const res = createComponent('resistor', 480, 200);
  const led = createComponent('led', 620, 300);
  const gnd = createComponent('ground', 420, 440);
  bat.rot = 90; led.rot = 90;
  const wires = [
    { id: 'w1', points: [{ x: 200, y: 260 }, { x: 200, y: 200 }, { x: 300, y: 200 }] },
    { id: 'w2', points: [{ x: 380, y: 200 }, { x: 440, y: 200 }] },
    { id: 'w3', points: [{ x: 520, y: 200 }, { x: 620, y: 200 }, { x: 620, y: 260 }] },
    { id: 'w4', points: [{ x: 620, y: 340 }, { x: 620, y: 400 }, { x: 420, y: 400 }] },
    { id: 'w5', points: [{ x: 200, y: 340 }, { x: 200, y: 400 }, { x: 420, y: 400 }] },
  ];
  editor.loadCircuit({ components: [bat, sw, res, led, gnd], wires });
}

try { starterCircuit(); centerCameraOnCircuit(); } catch (e) { console.warn('starter circuit failed:', e); }
editor.showToast('Welcome! Press ▶ Run, then click the switch. Try removing the resistor…', 'info');

// ---------------------------------------------------------------------------
// DEV-ONLY: ?qa= visual-QA hook. Not part of the product — lets a headless
// screenshot script reach interaction states (running, failed, mid-smoke) it
// can't drive with real mouse events. Comma-separated flags, e.g.
// "?qa=run" (close S1 and press Run), "?qa=blow" (also short R1 so the LED
// overcurrents and fuses open, and select it so the properties panel shows
// the failure banner), "?qa=t2000" (also fast-forward ~2s of sim time
// synchronously so the screenshot lands inside the ~2s smoke-wisp window
// instead of racing real wall-clock timing). Harmless no-op without ?qa=.
// ---------------------------------------------------------------------------
(function qaHook() {
  const qa = new URLSearchParams(location.search).get('qa') || '';
  if (!qa) return;
  const flags = qa.split(',').map(s => s.trim());
  const has = (f) => flags.includes(f);
  if (!(has('run') || has('blow') || has('t2000'))) return;

  const { components } = editor.getCircuit();
  const sw = components.find(c => c.id === 'S1');
  if (sw) sw.params.closed = true;

  if (has('blow') || has('t2000')) {
    const res = components.find(c => c.id === 'R1');
    if (res) res.params.resistance = 0.001; // ~short the current-limit resistor
    const led = components.find(c => c.type === 'led');
    if (led) editor.select(led.id);
  }

  editor.markDirty();
  running = true;
  btnRun.textContent = '⏸ Pause';
  btnRun.classList.add('active');

  if (has('t2000')) {
    // Fast-forward synchronously (bypassing rAF/wall-clock) until the LED
    // fails, then stop stepping exactly on the failure step so `justFailed`
    // is still true for the renderer's next draw() — which spawns the smoke
    // burst — before handing back to the normal rAF loop for real-time smoke
    // animation.
    rebuildNetlist();
    const MAX_FF_STEPS = Math.round(2 / PHYS_DT);
    for (let i = 0; i < MAX_FF_STEPS; i++) {
      sim.step(PHYS_DT);
      if (components.some(c => c.state && c.state.failed)) break;
    }
    // Freeze the sim right here: the next frame()'s rAF tick would otherwise
    // immediately burn through hundreds more physics steps (real/virtual
    // wall-clock dt is much bigger than PHYS_DT) and clear `justFailed`
    // before the renderer ever draws it. Pausing lets that first draw() spawn
    // the smoke burst, which then animates on its own via renderer dt.
    running = false;
    btnRun.textContent = '▶ Run';
    btnRun.classList.remove('active');
  }
})();
