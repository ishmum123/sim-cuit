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
import { Scope, defaultQuantityForType } from './ui/scope.js';
import { MAX_TRACES } from './ui/scopebuf.js';
import { checkShortCircuit } from './sim/shortcircuit.js';
import { importFromUrl, importFromText } from './io/import.js';
import {
  toSpiceNetlist, toKicadNetlist, saveJson, loadJson, downloadText,
} from './io/export.js';
import { encodeCircuit, decodeCircuit } from './io/share.js';

const canvas = document.getElementById('canvas');
const editor = new Editor(canvas, ComponentRegistry);
const renderer = new Renderer(canvas, editor);
const sim = new Simulation();

// ---------------------------------------------------------------------------
// Oscilloscope — see js/ui/scope.js (drawing/DOM) + js/ui/scopebuf.js (pure
// buffering/trace logic, unit tested). Editor owns the "📈 Plot" toggle UI in
// the properties panel but knows nothing about traces; this `probeApi` object
// is the only thing connecting the two, via editor.setProbeApi().
// ---------------------------------------------------------------------------

const scope = new Scope(document.getElementById('canvas-wrap'), {
  onRemove: () => editor.markDirty(), // re-render the properties panel's Plot row after an × click
});

const probeApi = {
  isProbed: (compId) => scope.getQuantity(compId),
  toggle: (comp) => {
    const { action, evicted } = scope.toggle(comp, defaultQuantityForType(comp.type, ComponentRegistry));
    if (evicted) editor.showToast(`Scope: max ${MAX_TRACES} traces — dropped ${evicted.compId} to plot ${comp.id}.`, 'warn');
    else if (action === 'added') editor.showToast(`Plotting ${comp.id} on the scope.`, 'info');
  },
  setQuantity: (compId, q) => scope.setQuantity(compId, q),
};
editor.setProbeApi(probeApi);

// Keep the scope's traces in sync with the live component list — deleting a
// probed part (or loading a different circuit) removes its trace too.
editor.onChange(() => {
  const liveIds = new Set(editor.getCircuit().components.map((c) => c.id));
  scope.pruneMissing(liveIds);
});

// ---------------------------------------------------------------------------
// Simulation loop
// ---------------------------------------------------------------------------

let running = false;
let speed = 1;           // sim-time multiplier
let netlistDirty = true;
let lastWarning = null;

const PHYS_DT = 50e-6;   // 50 µs physics step
const MAX_STEPS_PER_FRAME = 2000;

// ---------------------------------------------------------------------------
// Autosave — every editor change (debounced) is persisted to localStorage so
// a reload/crash doesn't lose work. Wrapped defensively: private-mode /
// quota-exceeded localStorage failures must never break the app.
// ---------------------------------------------------------------------------

const AUTOSAVE_KEY = 'simcuit-autosave-v1';
const AUTOSAVE_DEBOUNCE_MS = 500;

// While true, the next onChange notification is treated as "we just
// programmatically loaded a circuit", not a user edit, and is not autosaved.
// Set/cleared synchronously around each editor.loadCircuit() call made by
// this file's startup/New/import code, so it never leaks across a real user
// action (loadCircuit's own change notification fires synchronously inside
// the call).
let suppressAutosave = false;

let autosaveTimer = null;
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    safeSetAutosave(saveJson(editor.getCircuit()));
  }, AUTOSAVE_DEBOUNCE_MS);
}

function safeSetAutosave(text) {
  try { localStorage.setItem(AUTOSAVE_KEY, text); } catch { /* quota / unavailable — ignore */ }
}

function safeGetAutosave() {
  try { return localStorage.getItem(AUTOSAVE_KEY); } catch { return null; }
}

function safeClearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
}

editor.onChange(() => {
  netlistDirty = true;
  if (suppressAutosave) return;
  scheduleAutosave();
});

// Run `editor.loadCircuit(circuit)` without triggering an autosave write for
// that programmatic load itself. Also records a snapshot of what was just
// loaded (see normalizeCircuit/lastLoadedSnapshot below) so later "is the
// canvas still what we loaded" checks — e.g. the Examples menu's replace
// confirm — have something to compare against besides just the starter demo.
function loadCircuitQuietly(circuit) {
  suppressAutosave = true;
  try { editor.loadCircuit(circuit); } finally { suppressAutosave = false; }
  lastLoadedSnapshot = normalizeCircuit(circuit);
}

// Structural (not live-sim-state) snapshot of a circuit, used both to detect
// "still the starter demo" (New button) and "still whatever was last loaded"
// (Examples menu) before silently discarding the user's canvas.
function normalizeCircuit(c) {
  return JSON.stringify({
    components: (c.components || []).map((x) => ({
      id: x.id, type: x.type, x: x.x, y: x.y, rot: x.rot || 0, params: x.params, ratings: x.ratings,
    })),
    wires: (c.wires || []).map((w) => ({ id: w.id, points: w.points })),
  });
}
let lastLoadedSnapshot = null;

function rebuildNetlist() {
  const { components, wires } = editor.getCircuit();
  const { warning } = assignNodes(components, wires);
  sim.setNetlist(components);
  if (warning && warning !== lastWarning) editor.showToast(warning, 'warn');
  lastWarning = warning;
  netlistDirty = false;
}

// A netlist rebuild (any structural edit, including the layout-driven canvas
// resize that fires when the properties panel opens/closes) resets sim.time
// to 0 (see js/engine/solver.js Simulation#setNetlist). If that happens while
// the scope already holds samples at higher timestamps, guard against a
// corrupted/broken-looking trace (new low-t samples mixed with stale high-t
// ones) by starting the scope over — a "the clock rewound" edge case, not a
// steady-state thing, so simply clearing is the right, simple behavior.
// `qaAutoRefill`, set only by the ?qa=scope hook (see qaHook() below), lets a
// headless QA screenshot re-fill the trace deterministically if that same
// reset happens to land between the hook's own fast-forward and the first
// paint — real interactive usage doesn't need this (it just keeps recording
// forward from t=0, same as any other structural edit while running).
let lastSampleSimTime = 0;
let qaAutoRefill = null;

let lastT = null;
function frame(t) {
  if (running) {
    if (netlistDirty) rebuildNetlist();
    const wall = lastT === null ? 16 : Math.min(t - lastT, 50);
    const simTime = (wall / 1000) * speed;
    const steps = Math.min(Math.round(simTime / PHYS_DT), MAX_STEPS_PER_FRAME);
    for (let i = 0; i < steps; i++) sim.step(PHYS_DT);
    if (steps > 0) {
      const { components } = editor.getCircuit();
      if (sim.time < lastSampleSimTime) {
        scope.clear();
        if (qaAutoRefill) qaAutoRefill();
      }
      lastSampleSimTime = sim.time;
      // Scope: one decimated sample per rendered frame (see js/ui/scopebuf.js).
      scope.sample(sim.time, (id) => {
        const c = components.find((cc) => cc.id === id);
        return c && c.state;
      });
      checkShortCircuits(components);
    }
  }
  lastT = t;
  editor.tick(sim.time);
  renderer.draw(t);
  scope.render(sim.time);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Short-circuit advisory — see js/sim/shortcircuit.js (pure, unit tested).
// Fires once per "episode" (re-arms once current drops back under threshold
// or the part fails/repairs) so a sustained short doesn't spam toasts.
// `_scEpisodes` persists across frames/resets by design: Reset already zeros
// state.i (see btn-reset handler), which itself re-arms every episode.
// ---------------------------------------------------------------------------

const _scEpisodes = new Map(); // compId -> armed boolean

function checkShortCircuits(components) {
  for (const c of components) {
    const def = ComponentRegistry[c.type] || {};
    const isBattery = c.type === 'battery' || def.visualBase === 'battery';
    if (!isBattery) continue;
    const advisory = checkShortCircuit(c, _scEpisodes);
    if (advisory) {
      editor.showToast(
        `Short circuit: ${advisory.id} sourcing ${advisory.current.toFixed(1)} A — look for a direct path across it (note: all ground symbols are the same node).`,
        'warn',
      );
    }
  }
}

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
  scope.clear();
  _scEpisodes.clear();
  editor.markDirty();
  editor.showToast('Simulation reset — all parts repaired.', 'info');
});

$('btn-new').addEventListener('click', () => {
  const current = editor.getCircuit();
  if (!circuitMatchesStarter(current)) {
    const ok = confirm('Start a new circuit? Your current circuit will be discarded and will no longer be auto-restored.');
    if (!ok) return;
  }
  safeClearAutosave();
  running = false;
  btnRun.textContent = '▶ Run';
  btnRun.classList.remove('active');
  sim.setNetlist([]);
  loadCircuitQuietly(starterCircuit());
  centerCameraOnCircuit();
  netlistDirty = true;
  editor.showToast('New circuit.', 'info');
});

$('btn-share').addEventListener('click', async () => {
  try {
    const payload = await encodeCircuit(editor.getCircuit());
    const url = `${location.origin}${location.pathname}${location.search}#c=${payload}`;
    const copied = await copyToClipboard(url);
    editor.showToast(
      copied ? 'Link copied — anyone can open this circuit' : `Copy this link: ${url}`,
      copied ? 'ok' : 'warn',
    );
  } catch (e) {
    editor.showToast(`Couldn't create share link: ${e.message}`, 'error');
  }
});

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to execCommand fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

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
document.addEventListener('click', () => {
  exportMenu.classList.remove('open');
  examplesMenu.classList.remove('open');
});

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
// Examples menu — pre-built demo circuits under examples/*.json, fetched
// with a relative URL (this app is deployed at a GitHub Pages subpath, so
// no leading slash). Loading one goes through the same loadCircuitQuietly
// path as a shared link: it does NOT clear autosave immediately (unlike
// New), so a reload before the user touches anything still restores their
// previous session — only their next real edit overwrites the autosave.
// ---------------------------------------------------------------------------

const EXAMPLES = [
  { id: 'led-basics', file: 'examples/led-basics.json', title: 'LED basics', blurb: 'a properly protected LED' },
  { id: 'led-killer', file: 'examples/led-killer.json', title: 'LED killer', blurb: 'no resistor — watch it die' },
  { id: 'motor-stall', file: 'examples/motor-stall.json', title: 'Motor stall', blurb: "6V motor on 1.5V won't spin" },
  { id: 'fuse-protects', file: 'examples/fuse-protects.json', title: 'Fuse protects', blurb: "the fuse dies so the circuit doesn't" },
  { id: 'esp32-blink', file: 'examples/esp32-blink.json', title: 'ESP32 blink', blurb: 'a JS sketch blinking an LED' },
];

const examplesMenu = $('examples-menu');
$('btn-examples').addEventListener('click', (e) => {
  e.stopPropagation();
  examplesMenu.classList.toggle('open');
});

async function loadExample(ex) {
  examplesMenu.classList.remove('open');
  const current = editor.getCircuit();
  if (!circuitMatchesStarter(current) && !circuitUnchangedSinceLoad(current)) {
    const ok = confirm(`Load "${ex.title}"? Your current circuit will be discarded.`);
    if (!ok) return;
  }

  let circuit;
  try {
    const res = await fetch(ex.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    circuit = loadJson(await res.text());
  } catch (e) {
    editor.showToast(`Couldn't load "${ex.title}": ${e.message}`, 'error');
    return;
  }

  running = false;
  btnRun.textContent = '▶ Run';
  btnRun.classList.remove('active');
  sim.setNetlist([]);
  loadCircuitQuietly(circuit);
  centerCameraOnCircuit();
  netlistDirty = true;
  editor.showToast(`Loaded "${ex.title}" — press ▶ Run to simulate.`, 'ok');
}

for (const ex of EXAMPLES) {
  const btn = $(`example-${ex.id}`);
  if (btn) btn.addEventListener('click', () => loadExample(ex));
}

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
// Returns the plain-object {components, wires} shape (does NOT load it) so
// it can be used both to load the starter and to compare against the
// current circuit (see circuitMatchesStarter, used by the "New" button).
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
  return { components: [bat, sw, res, led, gnd], wires };
}

// Structural comparison used by the "New" button's confirm() gate — ignores
// live simulation fields (state/nodes) that editor.getCircuit() components
// carry once the sim has run, so an untouched starter circuit still compares
// equal even mid-run.
function circuitMatchesStarter(circuit) {
  return normalizeCircuit(circuit) === normalizeCircuit(starterCircuit());
}

// True if `circuit` is unchanged since the last programmatic load (New,
// share link, autosave restore, Load JSON, or an Examples menu pick) — i.e.
// there's nothing of the user's to lose by silently replacing it.
function circuitUnchangedSinceLoad(circuit) {
  return lastLoadedSnapshot !== null && normalizeCircuit(circuit) === lastLoadedSnapshot;
}

// ---------------------------------------------------------------------------
// Startup — priority order:
//   1. #c=<payload> share link in the URL hash
//   2. ?qa= hooks (deterministic starter circuit, so QA screenshots stay
//      reproducible — see qaHook() below)
//   3. autosave restored from localStorage
//   4. default starter circuit
// decodeCircuit() is async (Web Streams-based decompression), so the whole
// sequence is wrapped in an async function and everything downstream
// (qaHook, the render loop already started above via requestAnimationFrame)
// tolerates running before or after this resolves.
// ---------------------------------------------------------------------------

async function boot() {
  let loaded = false;

  const hashMatch = /^#c=(.+)$/.exec(location.hash);
  if (hashMatch) {
    try {
      const circuit = await decodeCircuit(hashMatch[1]);
      loadCircuitQuietly(circuit);
      centerCameraOnCircuit();
      editor.showToast('Loaded shared circuit', 'ok');
      loaded = true;
    } catch (e) {
      editor.showToast(`Couldn't load shared link: ${e.message}`, 'error');
    }
  }

  const qaFlags = (new URLSearchParams(location.search).get('qa') || '')
    .split(',').map((s) => s.trim());
  const qaActive = qaFlags.includes('run') || qaFlags.includes('blow') || qaFlags.includes('t2000')
    || qaFlags.includes('scope') || qaFlags.includes('examplesmenu')
    || qaFlags.includes('sketch') || qaFlags.includes('sketcherror');

  if (!loaded && !qaActive) {
    const saved = safeGetAutosave();
    if (saved) {
      try {
        loadCircuitQuietly(loadJson(saved));
        centerCameraOnCircuit();
        editor.showToast('Restored your last session', 'info');
        loaded = true;
      } catch (e) {
        console.warn('autosave restore failed:', e);
      }
    }
  }

  if (!loaded) {
    try { loadCircuitQuietly(starterCircuit()); centerCameraOnCircuit(); } catch (e) { console.warn('starter circuit failed:', e); }
  }

  editor.showToast('Welcome! Press ▶ Run, then click the switch. Try removing the resistor…', 'info');

  qaHook();
}
boot();

// ---------------------------------------------------------------------------
// DEV-ONLY: ?qa= visual-QA hook. Not part of the product — lets a headless
// screenshot script reach interaction states (running, failed, mid-smoke) it
// can't drive with real mouse events. Comma-separated flags, e.g.
// "?qa=run" (close S1 and press Run), "?qa=blow" (also short R1 so the LED
// overcurrents and fuses open, and select it so the properties panel shows
// the failure banner), "?qa=t2000" (also fast-forward ~2s of sim time
// synchronously so the screenshot lands inside the ~2s smoke-wisp window
// instead of racing real wall-clock timing), "?qa=scope" (probe the LED's
// current and the battery's current on the oscilloscope, then run — can be
// combined with t2000, e.g. "?qa=scope,t2000", to see the LED's death spike
// on the trace). "?qa=examplesmenu" opens the Examples dropdown so a
// screenshot can capture it without simulating a real click; combine with
// "&pick=<example-id>" (e.g. "&pick=led-killer") to also drive an example
// load headlessly, for dump-dom verification. "?qa=sketch" loads the
// esp32-blink example, selects the ESP32 (U1) so the properties panel's
// sketch section is visible, and runs the sim; add "&overlay=1" to also
// open the ⤢ Expand overlay editor headlessly. "?qa=sketcherror" does the
// same but replaces U1's sketch with one that throws a runtime error on a
// known line (5) and fast-forwards a little sim time so the engine has
// actually hit it — for screenshotting the gutter error-line highlight;
// also respects "&overlay=1". Harmless no-op without ?qa=.
// ---------------------------------------------------------------------------
// Shared fast-forward core for the qa hooks below: steps the sim
// synchronously (bypassing rAF/wall-clock) by `seconds` of sim time,
// decimating scope samples at roughly the same ~16ms cadence frame() uses so
// a fast-forwarded trace looks like one recorded in real time — EXCEPT under
// `stopOnFailure`, where a severe short (see 'blow'/'t2000' below) can push
// a part like the LED from healthy to fused in as little as ~3ms (a few tens
// of physics steps): sampling only every ~16ms would land just one sample
// before the break and lose the death-spike ramp entirely, so that mode
// samples every single physics step instead — still bounded (it only runs
// until failure, at most `seconds` of sim time) so it stays cheap.
// Returns true if it stopped early on a component failure (only relevant
// when stopOnFailure is set).
function qaFastForward(components, seconds, { stopOnFailure = false } = {}) {
  rebuildNetlist();
  const STEPS = Math.round(seconds / PHYS_DT);
  const SAMPLE_EVERY = stopOnFailure ? 1 : Math.max(1, Math.round(0.016 / PHYS_DT));
  let failed = false;
  for (let i = 0; i < STEPS; i++) {
    sim.step(PHYS_DT);
    if (i % SAMPLE_EVERY === 0) {
      scope.sample(sim.time, (id) => {
        const c = components.find((cc) => cc.id === id);
        return c && c.state;
      });
    }
    if (stopOnFailure && components.some(c => c.state && c.state.failed)) { failed = true; break; }
  }
  lastSampleSimTime = sim.time;
  return failed;
}

function qaHook() {
  const qa = new URLSearchParams(location.search).get('qa') || '';
  if (!qa) return;
  const flags = qa.split(',').map(s => s.trim());
  const has = (f) => flags.includes(f);
  if (!(has('run') || has('blow') || has('t2000') || has('scope') || has('examplesmenu')
    || has('sketch') || has('sketcherror'))) return;

  if (has('examplesmenu')) {
    examplesMenu.classList.add('open');
    const pickId = new URLSearchParams(location.search).get('pick');
    if (pickId) {
      const ex = EXAMPLES.find((e) => e.id === pickId);
      if (ex) loadExample(ex);
    }
    return;
  }

  if (has('sketch') || has('sketcherror')) {
    const wantOverlay = new URLSearchParams(location.search).get('overlay') === '1';
    const ex = EXAMPLES.find((e) => e.id === 'esp32-blink');
    loadExample(ex).then(() => {
      const esp = editor.getCircuit().components.find((c) => c.type === 'esp32');
      if (!esp) return;
      if (has('sketcherror')) {
        // Line 5 (undefinedThing.explode()) throws at runtime — a compile
        // SyntaxError would report no line at all (see extractSourceLine in
        // js/engine/sketch.js), which isn't useful for a gutter-highlight
        // screenshot, so this is a deliberate RUNTIME error on a known line.
        esp.params.sketch = 'function setup() { pinMode(2, OUTPUT); }\n'
          + 'function loop() {\n'
          + '  digitalWrite(2, HIGH); delay(500);\n'
          + '  digitalWrite(2, LOW);  delay(500);\n'
          + '  undefinedThing.explode();\n'
          + '}\n';
        esp.params.sketchEnabled = true;
      }
      editor.select(esp.id);
      running = true;
      btnRun.textContent = '⏸ Pause';
      btnRun.classList.add('active');
      // A couple hundred ms of sim time is plenty to hit the failing line
      // (loop() runs immediately after setup(), well before the first
      // delay() even elapses) so the engine has already computed
      // state.sketchStatus / state.sketchErrorLine by the time of the
      // screenshot, instead of racing real rAF timing.
      qaFastForward(editor.getCircuit().components, 0.2);
      editor.markDirty();
      if (wantOverlay) editor.openSketchOverlay();
    });
    return;
  }

  const { components } = editor.getCircuit();
  const sw = components.find(c => c.id === 'S1');
  if (sw) sw.params.closed = true;

  if (has('scope')) {
    const led = components.find(c => c.type === 'led');
    const bat = components.find(c => c.type === 'battery');
    if (led) probeApi.toggle(led); // default quantity for LED is 'v'; scope wants I here per spec
    if (led) scope.setQuantity(led.id, 'i');
    if (bat) probeApi.toggle(bat); // battery default quantity is already 'i'
  }

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
    // Fast-forward until the LED fails, then stop stepping exactly on the
    // failure step so `justFailed` is still true for the renderer's next
    // draw() — which spawns the smoke burst — before handing back to the
    // normal rAF loop for real-time smoke animation.
    qaFastForward(components, 2, { stopOnFailure: true });
    // Freeze the sim right here: the next frame()'s rAF tick would otherwise
    // immediately burn through hundreds more physics steps (real/virtual
    // wall-clock dt is much bigger than PHYS_DT) and clear `justFailed`
    // before the renderer ever draws it. Pausing lets that first draw() spawn
    // the smoke burst, which then animates on its own via renderer dt.
    running = false;
    btnRun.textContent = '▶ Run';
    btnRun.classList.remove('active');
  } else if (has('scope')) {
    // Scope-only (no t2000): fast-forward past a full scope window's worth
    // of sim time so the trace is already filling the whole canvas at first
    // paint, rather than depending on however many real rAF ticks happen to
    // land before a screenshot is taken. Left running=true (Pause button
    // active) so the screenshot reads as a live scope mid-session rather
    // than a paused one.
    //
    // qaAutoRefill: a netlist rebuild (e.g. the canvas-wrap ResizeObserver's
    // unavoidable one-time initial callback, which fires shortly after page
    // load regardless of any real layout change) resets sim.time to 0 — see
    // the comment above `lastSampleSimTime` near frame(). If that lands
    // between this fast-forward and the first paint, frame()'s regression
    // guard detects it and calls this again to deterministically re-fill the
    // window rather than leaving a screenshot with a half-empty trace.
    qaAutoRefill = () => qaFastForward(components, 2.2);
    qaAutoRefill();
  }
}
