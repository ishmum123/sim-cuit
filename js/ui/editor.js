/*
 * Sim-cuit — js/ui/editor.js
 * ---------------------------------------------------------------------------
 * Canvas editor: place / drag / wire / rotate / delete / properties panel /
 * toasts. Owns the live circuit data (components + wires) and all pointer /
 * keyboard interaction. Contains NO drawing code (see js/ui/render.js) and
 * NO simulation code (see js/engine/*, driven by main.js).
 *
 * Depends only on the documented engine contract from js/engine/components.js:
 *   ComponentRegistry            — { [type]: { label, prefix, terminals,
 *                                    defaultParams, defaultRatings, paramSchema,
 *                                    ratingSchema? , ... } }
 *   createComponent(type, x, y)  — returns a fully-formed ComponentInstance
 *                                   { id, type, x, y, rot, params, ratings, state:{} }
 *   terminalOffsets(comp)        — returns [{x,y}, ...] ROTATED but
 *                                   component-RELATIVE {dx,dy} terminal
 *                                   offsets (length == registry entry's
 *                                   `terminals`); add comp.x/comp.y for a
 *                                   world-space point. This file's internal
 *                                   terminalWorldPoints(comp) helper does that.
 *   repair(comp)                 — clears comp.state.failed/failureMsg/temp etc.
 *
 * -----------------------------------------------------------------------
 * PUBLIC API (this is what js/main.js drives):
 *
 *   new Editor(canvas, registry)
 *
 *   editor.getCircuit()            -> { components: ComponentInstance[], wires: Wire[] }
 *                                      (LIVE references — main.js/engine may
 *                                      attach `.nodes` and overwrite `.state`
 *                                      on these exact objects every sim step)
 *   editor.onChange(cb)             -> void   // cb() fires after any structural
 *                                                change (add/move/rotate/delete/
 *                                                wire/param edit/selection)
 *   editor.markDirty()              -> void   // force an onChange notification
 *   editor.getSelected()            -> ComponentInstance | null
 *   editor.select(id | null)        -> void
 *   editor.loadCircuit(circuit)     -> void   // circuit: {components, wires}
 *                                                plain-object form (e.g. from
 *                                                io/export.js loadJson()); replaces
 *                                                the live circuit
 *   editor.registerImportedPart(type) -> void // add a palette entry (under the
 *                                                "Imported" group) for a type key
 *                                                that main.js has already added
 *                                                to `registry` (e.g. after
 *                                                io/import.js resolves a PartDef)
 *   editor.showToast(message, kind) -> void   // kind: 'info'|'ok'|'warn'|'error'
 *   editor.tick()                   -> void   // call once per animation frame
 *                                                (or per sim step) to refresh the
 *                                                live V/I/P/temp/failure readout
 *                                                in the properties panel and to
 *                                                surface failure toasts. Cheap
 *                                                no-op work when nothing selected.
 *   editor.resize()                 -> void   // call on window/container resize
 *
 * Interaction-state fields render.js reads (read-only from render's side):
 *   editor.camera            { x, y, scale }   // world->screen: sx = wx*scale + x
 *   editor.selection          Set<string>       // selected component ids
 *   editor.hover              { compId, terminalIndex } | null
 *   editor.wiring             { points:[{x,y}], previewPoint:{x,y},
 *                                previewSegments:[{x,y}],
 *                                snapTerminal:{compId,terminalIndex}|null,
 *                                fromComp, fromTerminal, valid } | null
 *                                // valid === true iff previewPoint is
 *                                // currently snapped onto a legal (non-start)
 *                                // destination terminal — render.js colors
 *                                // the rubber-band preview green in that case.
 *   editor.placingType        string | null
 *   editor.placingPreviewPos  {x,y} | null
 *   editor.marquee            {x0,y0,x1,y1} | null
 *   editor.mouseWorld         {x,y} | null
 *   editor.spacePan           boolean
 *   editor.dpr / editor.cssWidth / editor.cssHeight
 * ---------------------------------------------------------------------------
 */

import { createComponent, terminalOffsets, repair } from '../engine/components.js';

// terminalOffsets(comp) returns ROTATED but component-RELATIVE {dx,dy} pairs
// (per js/engine/components.js: rotOffset() rotates the local offset but
// never adds comp.x/comp.y). Everything in this file that needs a world-space
// terminal position must go through this helper.
function terminalWorldPoints(comp) {
  const offs = terminalOffsets(comp);
  return offs.map(o => ({ x: comp.x + o.x, y: comp.y + o.y }));
}

const GRID = 20;
const TERMINAL_HIT_R = 9;      // screen px (pre-scale) tolerance for terminal picking
const WIRE_HINT_KEY = 'simcuit-wire-hint';
const BODY_SIZE = {
  battery: { w: 90, h: 50 }, resistor: { w: 90, h: 36 }, led: { w: 70, h: 60 },
  diode: { w: 80, h: 36 }, capacitor: { w: 70, h: 50 }, motor: { w: 74, h: 74 },
  bulb: { w: 64, h: 64 }, fuse: { w: 90, h: 34 }, switch: { w: 90, h: 44 },
  potentiometer: { w: 100, h: 60 }, ground: { w: 50, h: 84 },
  voltmeter: { w: 64, h: 64 }, ammeter: { w: 64, h: 64 },
};
const DEFAULT_BODY_SIZE = { w: 90, h: 50 };

const GROUP_MAP = {
  battery: 'sources', ground: 'sources',
  resistor: 'passive', capacitor: 'passive', fuse: 'passive', potentiometer: 'passive',
  diode: 'semiconductors', led: 'semiconductors',
  motor: 'electromechanical', bulb: 'electromechanical', switch: 'electromechanical',
  voltmeter: 'instruments', ammeter: 'instruments',
};

function snap(v) { return Math.round(v / GRID) * GRID; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function bodySize(type) { return BODY_SIZE[type] || DEFAULT_BODY_SIZE; }

function fmt(v, unit, digits = 3) {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  const av = Math.abs(v);
  let s;
  if (av !== 0 && (av < 1e-3 || av >= 1e4)) s = v.toExponential(2);
  else s = v.toFixed(digits > 0 ? Math.max(0, digits - (av >= 10 ? 1 : av >= 100 ? 2 : 0)) : 0);
  return `${s} ${unit}`;
}

// ---- tiny inline icon set (schematic-flavored, mirrors render.js shapes) ----
const ICONS = {
  battery: '<path d="M2 6v8M6 3v14M12 6v8M16 3v14" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  resistor: '<path d="M0 10h4l2-5 4 10 4-10 4 10 2-5h4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round" stroke-linecap="round"/>',
  led: '<path d="M2 10h4M10 4l6 6-6 6z M16 4v12M20 10h4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
  diode: '<path d="M2 10h6l6-6v12l-6-6M14 4v12M20 10h4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
  capacitor: '<path d="M2 10h8M12 3v14M15 3v14M17 10h7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  motor: '<circle cx="12" cy="10" r="7" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M2 10h3M19 10h3" stroke="currentColor" stroke-width="1.6"/><text x="12" y="13" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">M</text>',
  bulb: '<circle cx="12" cy="9" r="6" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M9 7l6 4M15 7l-6 4M9 15h6" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  fuse: '<rect x="6" y="6" width="12" height="8" rx="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M0 10h6M18 10h6M8 10h8" stroke="currentColor" stroke-width="1.4"/>',
  switch: '<circle cx="4" cy="10" r="1.6" fill="currentColor"/><circle cx="20" cy="10" r="1.6" fill="currentColor"/><path d="M0 10h4M20 10h4M5 9.2l13-5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  potentiometer: '<path d="M0 10h4l2-5 4 10 4-10 4 10 2-5h4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/><path d="M12 2l0 4" stroke="currentColor" stroke-width="1.5"/><path d="M12 2l-3 2" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  ground: '<path d="M12 2v6M6 8h12M8 12h8M10 16h4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  voltmeter: '<circle cx="12" cy="10" r="8" stroke="currentColor" stroke-width="1.6" fill="none"/><text x="12" y="13" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">V</text>',
  ammeter: '<circle cx="12" cy="10" r="8" stroke="currentColor" stroke-width="1.6" fill="none"/><text x="12" y="13" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">A</text>',
};
const DEFAULT_ICON = '<rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/>';

export class Editor {
  constructor(canvas, registry) {
    this.canvas = canvas;
    this.registry = registry;
    this.components = [];
    this.wires = [];
    this._counter = {};
    this._changeListeners = [];

    this.camera = { x: 0, y: 0, scale: 1 };
    this.selection = new Set();
    this.hover = null;
    this.wiring = null;
    this.placingType = null;
    this.placingPreviewPos = null;
    this.marquee = null;
    this.mouseWorld = null;
    this.spacePan = false;

    this.dpr = window.devicePixelRatio || 1;
    this.cssWidth = 0;
    this.cssHeight = 0;

    this._drag = null;   // { ids, offsets:Map, moved }
    this._pan = null;    // { startScreen, startCamera }
    this._toastedFailures = new WeakSet();
    this._wireHintDismissed = this._readWireHintDismissed();
    this._wireHintEl = null;

    this._bindDom();
    this._bindCanvas();
    this._buildPalette();
    this._setupResize();
    this._bindWireHint();
  }

  // ---------------------------------------------------------------- public

  getCircuit() { return { components: this.components, wires: this.wires }; }

  onChange(cb) { this._changeListeners.push(cb); }

  markDirty() { this._notify(); }

  getSelected() {
    if (this.selection.size !== 1) return null;
    const id = [...this.selection][0];
    return this.components.find(c => c.id === id) || null;
  }

  select(id) {
    this.selection.clear();
    if (id) this.selection.add(id);
    this._renderProperties();
    this._notify();
  }

  loadCircuit(circuit) {
    this.components = (circuit.components || []).map(saved => {
      const c = createComponent(saved.type, saved.x, saved.y);
      c.id = saved.id || c.id;
      c.rot = saved.rot || 0;
      c.params = Object.assign({}, c.params, saved.params || {});
      c.ratings = Object.assign({}, c.ratings, saved.ratings || {});
      return c;
    });
    this.wires = (circuit.wires || []).map(w => ({ id: w.id || this._nextWireId(), points: w.points.map(p => ({ x: p.x, y: p.y })) }));
    this.selection.clear();
    this._syncCounters();
    this._renderProperties();
    this._updateWireHintVisibility();
    this._notify();
  }

  registerImportedPart(type) {
    this._addPaletteItem(type, 'imported');
    const group = document.getElementById('palette-group-imported');
    if (group) group.hidden = false;
  }

  showToast(message, kind = 'info') {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-fade');
      setTimeout(() => el.remove(), 260);
    }, 4200);
  }

  tick() {
    const sel = this.getSelected();
    if (sel) this._updateReadings(sel);
    for (const c of this.components) {
      if (c.state && c.state.justFailed && !this._toastedFailures.has(c.state)) {
        this._toastedFailures.add(c.state);
        this.showToast(c.state.failureMsg || `${c.id} failed`, 'error');
      }
      if (c.state && !c.state.justFailed) {
        // allow future justFailed pulses on the same state object to toast again
        // (engine sets justFailed only for one step then clears it; once cleared
        // we drop the guard so a later re-failure after repair toasts again)
        this._toastedFailures.delete(c.state);
      }
    }
  }

  resize() { this._doResize(); }

  // --------------------------------------------------------------- camera

  worldToScreen(wx, wy) {
    return { x: wx * this.camera.scale + this.camera.x, y: wy * this.camera.scale + this.camera.y };
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.camera.x) / this.camera.scale, y: (sy - this.camera.y) / this.camera.scale };
  }

  // -------------------------------------------------------------- private

  _notify() { for (const cb of this._changeListeners) cb(); }

  _nextId(type) {
    const def = this.registry[type];
    const prefix = (def && def.prefix) || type.slice(0, 1).toUpperCase();
    this._counter[prefix] = (this._counter[prefix] || 0) + 1;
    return `${prefix}${this._counter[prefix]}`;
  }

  _nextWireId() {
    this._counter.W = (this._counter.W || 0) + 1;
    return `W${this._counter.W}`;
  }

  _syncCounters() {
    this._counter = {};
    for (const c of this.components) {
      const m = /^([A-Za-z]+)(\d+)$/.exec(c.id);
      if (m) this._counter[m[1]] = Math.max(this._counter[m[1]] || 0, parseInt(m[2], 10));
    }
    for (const w of this.wires) {
      const m = /^W(\d+)$/.exec(w.id);
      if (m) this._counter.W = Math.max(this._counter.W || 0, parseInt(m[1], 10));
    }
  }

  // ---- DOM: topbar-adjacent bits owned by editor (palette + properties) ---

  _bindDom() {
    document.getElementById('btn-repair-part')?.addEventListener('click', () => {
      const c = this.getSelected();
      if (!c) return;
      repair(c);
      this.showToast(`${c.id} repaired`, 'ok');
      this._renderProperties();
      this._notify();
    });
  }

  // ---- first-run wiring hint (dismissible, persisted in localStorage) ----

  _readWireHintDismissed() {
    try { return localStorage.getItem(WIRE_HINT_KEY) === 'dismissed'; } catch { return false; }
  }

  _writeWireHintDismissed() {
    try { localStorage.setItem(WIRE_HINT_KEY, 'dismissed'); } catch { /* private mode etc: ignore */ }
  }

  _bindWireHint() {
    this._wireHintEl = document.getElementById('wire-hint');
    document.getElementById('wire-hint-dismiss')?.addEventListener('click', () => {
      this._wireHintDismissed = true;
      this._writeWireHintDismissed();
      this._updateWireHintVisibility();
    });
    this._updateWireHintVisibility();
  }

  _updateWireHintVisibility() {
    if (!this._wireHintEl) return;
    this._wireHintEl.hidden = this._wireHintDismissed || this.wires.length > 0;
  }

  _buildPalette() {
    for (const type of Object.keys(this.registry)) {
      this._addPaletteItem(type, GROUP_MAP[type] || 'imported');
    }
    const importedGroup = document.getElementById('palette-group-imported');
    if (importedGroup) {
      const hasImported = [...importedGroup.querySelectorAll('.palette-item')].length > 0;
      importedGroup.hidden = !hasImported;
    }
  }

  _addPaletteItem(type, group) {
    const container = document.querySelector(`[data-group-items="${group}"]`) ||
      document.querySelector('[data-group-items="imported"]');
    if (!container) return;
    const def = this.registry[type] || {};
    const el = document.createElement('div');
    el.className = 'palette-item';
    el.dataset.type = type;
    el.title = def.label || type;
    el.innerHTML = `<span class="palette-item-icon"><svg viewBox="0 0 24 20">${ICONS[type] || DEFAULT_ICON}</svg></span><span class="palette-item-name">${def.label || type}</span>`;
    el.addEventListener('click', () => this._setPlacingType(type, el));
    container.appendChild(el);
  }

  _setPlacingType(type, el) {
    if (this.placingType === type) {
      this.placingType = null;
      this.placingPreviewPos = null;
      document.querySelectorAll('.palette-item.active').forEach(n => n.classList.remove('active'));
      this._notify();
      return;
    }
    this.placingType = type;
    this._cancelWiring();
    document.querySelectorAll('.palette-item.active').forEach(n => n.classList.remove('active'));
    if (el) el.classList.add('active');
    this._notify();
  }

  // -------------------------------------------------------- canvas events

  _bindCanvas() {
    const c = this.canvas;
    c.addEventListener('mousedown', e => this._onMouseDown(e));
    window.addEventListener('mousemove', e => this._onMouseMove(e));
    window.addEventListener('mouseup', e => this._onMouseUp(e));
    c.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    c.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', e => this._onKeyDown(e));
    window.addEventListener('keyup', e => this._onKeyUp(e));
    c.addEventListener('mouseleave', () => { this.hover = null; if (!this.wiring) this.canvas.style.cursor = 'default'; this._notify(); });
  }

  _eventPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _hitTerminal(worldPos) {
    const tol = TERMINAL_HIT_R / this.camera.scale;
    for (let i = this.components.length - 1; i >= 0; i--) {
      const comp = this.components[i];
      let pts;
      try { pts = terminalWorldPoints(comp); } catch { pts = null; }
      if (!pts) continue;
      for (let t = 0; t < pts.length; t++) {
        if (dist(pts[t], worldPos) <= tol) return { comp, terminalIndex: t, point: { x: snap(pts[t].x), y: snap(pts[t].y) } };
      }
    }
    return null;
  }

  _hitComponent(worldPos) {
    for (let i = this.components.length - 1; i >= 0; i--) {
      const comp = this.components[i];
      const { w, h } = bodySize(comp.type);
      const hw = (comp.rot === 90 || comp.rot === 270) ? h / 2 : w / 2;
      const hh = (comp.rot === 90 || comp.rot === 270) ? w / 2 : h / 2;
      if (Math.abs(worldPos.x - comp.x) <= hw && Math.abs(worldPos.y - comp.y) <= hh) return comp;
    }
    return null;
  }

  _hitWire(worldPos) {
    const tol = 6 / this.camera.scale;
    for (let i = this.wires.length - 1; i >= 0; i--) {
      const pts = this.wires[i].points;
      for (let s = 0; s < pts.length - 1; s++) {
        if (this._distToSeg(worldPos, pts[s], pts[s + 1]) <= tol) return this.wires[i];
      }
    }
    return null;
  }

  _distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  _orthoBend(from, to) {
    if (from.x === to.x || from.y === to.y) return [];
    return [{ x: to.x, y: from.y }];
  }

  _onMouseDown(e) {
    const pos = this._eventPos(e);
    const world = this.screenToWorld(pos.x, pos.y);
    this.mouseWorld = world;

    // middle-mouse or space-drag => pan
    if (e.button === 1 || (this.spacePan && e.button === 0)) {
      this._pan = { startScreen: pos, startCamera: { ...this.camera } };
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      // right-click while wiring cancels it (contextmenu is globally
      // suppressed below, so this is the only place we need to react)
      if (this.wiring) { this._cancelWiring(); this._notify(); }
      return;
    }

    // placing a new component
    if (this.placingType) {
      const sx = snap(world.x), sy = snap(world.y);
      const comp = createComponent(this.placingType, sx, sy);
      // createComponent() is expected to assign a unique id per the engine
      // contract; guard against collisions (e.g. re-creation after delete)
      // by minting a fresh one if the id is missing or already taken.
      if (!comp.id || this.components.some(c => c.id === comp.id)) {
        comp.id = this._nextId(this.placingType);
      }
      this.components.push(comp);
      this.select(comp.id);
      this._notify();
      return;
    }

    // continuing / starting a wire
    const termHit = this._hitTerminal(world);
    if (this.wiring) {
      if (termHit) {
        if (this._isWireStart(termHit)) {
          // clicked back on the origin terminal: never create a zero-length
          // wire — just ignore the click, wiring stays active
          return;
        }
        this._completeWire(termHit);
        return;
      }
      // click on empty space: drop an optional manual bend point and keep
      // routing (most users will just click the destination terminal
      // directly and never hit this branch)
      const last = this.wiring.points[this.wiring.points.length - 1];
      const sp = { x: snap(world.x), y: snap(world.y) };
      const bend = this._orthoBend(last, sp);
      this.wiring.points.push(...bend, sp);
      this._notify();
      return;
    }
    if (termHit) {
      this.wiring = {
        points: [termHit.point], fromComp: termHit.comp.id, fromTerminal: termHit.terminalIndex,
        previewPoint: termHit.point, previewSegments: [], snapTerminal: null, valid: false,
      };
      this._notify();
      return;
    }

    // component interactions: switch toggle / drag / select
    const comp = this._hitComponent(world);
    if (comp) {
      if (!this.selection.has(comp.id)) {
        if (!e.shiftKey) this.selection.clear();
        this.selection.add(comp.id);
      }
      this._renderProperties();
      this._drag = { ids: [...this.selection], offsets: new Map(), moved: false, downPos: pos, toggled: comp };
      for (const id of this._drag.ids) {
        const c = this.components.find(cc => cc.id === id);
        this._drag.offsets.set(id, { dx: world.x - c.x, dy: world.y - c.y });
      }
      this._notify();
      return;
    }

    // empty canvas: start box-select, clear selection first (unless shift)
    if (!e.shiftKey) this.selection.clear();
    this.marquee = { x0: world.x, y0: world.y, x1: world.x, y1: world.y };
    this._renderProperties();
    this._notify();
  }

  _onMouseMove(e) {
    const pos = this._eventPos(e);
    const world = this.screenToWorld(pos.x, pos.y);
    this.mouseWorld = world;

    if (this._pan) {
      this.camera.x = this._pan.startCamera.x + (pos.x - this._pan.startScreen.x);
      this.camera.y = this._pan.startCamera.y + (pos.y - this._pan.startScreen.y);
      this._notify();
      return;
    }

    if (this.placingType) {
      this.placingPreviewPos = { x: snap(world.x), y: snap(world.y) };
      this.canvas.style.cursor = 'crosshair';
      this._notify();
      return;
    }

    if (this.wiring) {
      const last = this.wiring.points[this.wiring.points.length - 1];
      const termHit = this._hitTerminal(world);
      const snapHit = (termHit && !this._isWireStart(termHit)) ? termHit : null;
      const sp = snapHit ? snapHit.point : { x: snap(world.x), y: snap(world.y) };
      const bend = this._orthoBend(last, sp);
      this.wiring.previewSegments = [...bend, sp];
      this.wiring.previewPoint = sp;
      this.wiring.snapTerminal = snapHit ? { compId: snapHit.comp.id, terminalIndex: snapHit.terminalIndex } : null;
      this.wiring.valid = !!snapHit;
      this.canvas.style.cursor = 'crosshair';
      this._notify();
      return;
    }

    if (this._drag) {
      const dxMoved = Math.abs(pos.x - this._drag.downPos.x);
      const dyMoved = Math.abs(pos.y - this._drag.downPos.y);
      if (dxMoved > 3 || dyMoved > 3) this._drag.moved = true;
      if (this._drag.moved) {
        this.canvas.style.cursor = 'move';
        for (const id of this._drag.ids) {
          const c = this.components.find(cc => cc.id === id);
          const off = this._drag.offsets.get(id);
          c.x = snap(world.x - off.dx);
          c.y = snap(world.y - off.dy);
        }
        this._notify();
      }
      return;
    }

    if (this.marquee) {
      this.marquee.x1 = world.x;
      this.marquee.y1 = world.y;
      this._notify();
      return;
    }

    // idle hover
    const termHit = this._hitTerminal(world);
    if (termHit) {
      this.hover = { compId: termHit.comp.id, terminalIndex: termHit.terminalIndex };
      this.canvas.style.cursor = 'crosshair';
    } else {
      const comp = this._hitComponent(world);
      this.hover = comp ? { compId: comp.id, terminalIndex: -1 } : null;
      this.canvas.style.cursor = comp ? 'move' : 'default';
    }
    this._notify();
  }

  _onMouseUp(e) {
    if (this._pan) { this._pan = null; return; }

    if (this.wiring) {
      // drag-to-wire: mousedown on a terminal, drag, release on another
      // terminal completes the wire. Releasing on the start terminal (i.e.
      // a plain click with no drag) or on empty space just leaves wiring
      // active in click-mode — it never cancels, so drag degrades
      // gracefully into the click/click flow.
      const pos = this._eventPos(e);
      const world = this.screenToWorld(pos.x, pos.y);
      const termHit = this._hitTerminal(world);
      if (termHit && !this._isWireStart(termHit)) this._completeWire(termHit);
      return;
    }

    if (this._drag) {
      if (!this._drag.moved && this._drag.toggled && this._drag.toggled.type === 'switch') {
        const c = this._drag.toggled;
        c.params.closed = !c.params.closed;
        this.showToast(`${c.id} ${c.params.closed ? 'closed' : 'open'}`, 'info');
      }
      this._drag = null;
      this._renderProperties();
      this._notify();
      return;
    }

    if (this.marquee) {
      const { x0, y0, x1, y1 } = this.marquee;
      const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
      const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
      if (Math.abs(x1 - x0) > 4 || Math.abs(y1 - y0) > 4) {
        for (const c of this.components) {
          if (c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY) this.selection.add(c.id);
        }
      }
      this.marquee = null;
      this._renderProperties();
      this._notify();
    }
  }

  _onWheel(e) {
    const world = this.mouseWorld;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const pos = this._eventPos(e);
      const before = this.screenToWorld(pos.x, pos.y);
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.camera.scale = Math.min(3, Math.max(0.25, this.camera.scale * factor));
      const after = this.worldToScreen(before.x, before.y);
      this.camera.x += pos.x - after.x;
      this.camera.y += pos.y - after.y;
      this._notify();
      return;
    }
    // scroll on a potentiometer adjusts wiper
    if (world) {
      const comp = this._hitComponent(world);
      if (comp && comp.type === 'potentiometer') {
        e.preventDefault();
        const cur = comp.params.wiper ?? 0.5;
        comp.params.wiper = Math.min(1, Math.max(0, cur - Math.sign(e.deltaY) * 0.02));
        this._renderProperties();
        this._notify();
      }
    }
  }

  _onKeyDown(e) {
    if (e.code === 'Space') { this.spacePan = true; return; }
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      if (this.wiring) { this._cancelWiring(); this._notify(); return; }
      if (this.placingType) {
        this.placingType = null; this.placingPreviewPos = null;
        document.querySelectorAll('.palette-item.active').forEach(n => n.classList.remove('active'));
        this._notify();
        return;
      }
      this.selection.clear();
      this._renderProperties();
      this._notify();
      return;
    }

    if ((e.key === 'r' || e.key === 'R') && this.selection.size) {
      for (const id of this.selection) {
        const c = this.components.find(cc => cc.id === id);
        if (c) c.rot = (c.rot + 90) % 360;
      }
      this._notify();
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
      e.preventDefault();
      this.components = this.components.filter(c => !this.selection.has(c.id));
      this.selection.clear();
      this._renderProperties();
      this._notify();
    }
  }

  _onKeyUp(e) {
    if (e.code === 'Space') this.spacePan = false;
  }

  _cancelWiring() { this.wiring = null; this.canvas.style.cursor = 'default'; }

  _isWireStart(termHit) {
    return !!this.wiring && termHit.comp.id === this.wiring.fromComp && termHit.terminalIndex === this.wiring.fromTerminal;
  }

  _completeWire(termHit) {
    const last = this.wiring.points[this.wiring.points.length - 1];
    const bend = this._orthoBend(last, termHit.point);
    this.wiring.points.push(...bend, termHit.point);
    const isFirstWire = this.wires.length === 0;
    this.wires.push({ id: this._nextWireId(), points: this.wiring.points });
    this.wiring = null;
    if (isFirstWire) {
      this._wireHintDismissed = true;
      this._writeWireHintDismissed();
      this._updateWireHintVisibility();
    }
    this._notify();
  }

  // ------------------------------------------------------------ properties

  _renderProperties() {
    const empty = document.getElementById('properties-empty');
    const content = document.getElementById('properties-content');
    const comp = this.getSelected();
    if (!comp) {
      if (empty) empty.hidden = false;
      if (content) content.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;

    document.getElementById('prop-id').textContent = comp.id;
    const def = this.registry[comp.type] || {};
    document.getElementById('prop-label').textContent = def.label || comp.type;

    const paramFields = document.getElementById('param-fields');
    const ratingFields = document.getElementById('rating-fields');
    paramFields.innerHTML = '';
    ratingFields.innerHTML = '';

    const paramTitle = document.createElement('div');
    paramTitle.className = 'field-group-title';
    paramTitle.textContent = 'Parameters';
    paramFields.appendChild(paramTitle);

    const schema = def.paramSchema || Object.keys(comp.params || {}).map(k => ({ key: k, label: k, type: typeof comp.params[k] === 'boolean' ? 'checkbox' : 'number' }));
    for (const field of schema) this._buildField(paramFields, comp, 'params', field);

    if (comp.ratings && Object.keys(comp.ratings).length) {
      const ratingTitle = document.createElement('div');
      ratingTitle.className = 'field-group-title';
      ratingTitle.textContent = 'Ratings';
      ratingFields.appendChild(ratingTitle);
      const ratingSchema = def.ratingSchema || Object.keys(comp.ratings).map(k => ({ key: k, label: k, type: 'number' }));
      for (const field of ratingSchema) this._buildField(ratingFields, comp, 'ratings', field);
    }

    this._updateReadings(comp);
  }

  _buildField(container, comp, bucket, field) {
    const isBool = field.type === 'checkbox' || field.type === 'boolean';
    const wrap = document.createElement('div');
    wrap.className = 'field' + (isBool ? ' field-checkbox-row' : '');
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = field.label || field.key;
    let input;
    if (isBool) {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!comp[bucket][field.key];
      input.addEventListener('change', () => { comp[bucket][field.key] = input.checked; this._notify(); });
    } else if (field.type === 'select' && field.options) {
      input = document.createElement('select');
      for (const opt of field.options) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (comp[bucket][field.key] === opt) o.selected = true;
        input.appendChild(o);
      }
      input.addEventListener('change', () => { comp[bucket][field.key] = input.value; this._notify(); });
    } else {
      input = document.createElement('input');
      input.type = field.type === 'text' ? 'text' : 'number';
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
      if (field.step !== undefined) input.step = field.step; else input.step = 'any';
      input.value = comp[bucket][field.key];
      input.addEventListener('change', () => {
        const n = field.type === 'text' ? input.value : parseFloat(input.value);
        comp[bucket][field.key] = Number.isNaN(n) ? input.value : n;
        this._notify();
      });
    }
    wrap.appendChild(label);
    wrap.appendChild(input);
    container.appendChild(wrap);
  }

  _updateReadings(comp) {
    const s = comp.state || {};
    document.getElementById('reading-v').textContent = fmt(s.v, 'V');
    document.getElementById('reading-i').textContent = fmt((s.i || 0) * 1000, 'mA');
    document.getElementById('reading-p').textContent = fmt(s.p, 'W');
    const bar = document.getElementById('temp-bar-fill');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, (s.temp || 0) * 100))}%`;

    const banner = document.getElementById('failure-banner');
    const msg = document.getElementById('failure-msg');
    if (s.failed) {
      banner.hidden = false;
      msg.textContent = s.failureMsg || `${comp.id} failed (${s.failed})`;
    } else {
      banner.hidden = true;
    }
  }

  // --------------------------------------------------------------- resize

  _setupResize() {
    const wrap = this.canvas.parentElement;
    this._doResize();
    if (window.ResizeObserver && wrap) {
      const ro = new ResizeObserver(() => this._doResize());
      ro.observe(wrap);
    } else {
      window.addEventListener('resize', () => this._doResize());
    }
  }

  _doResize() {
    const wrap = this.canvas.parentElement;
    const w = wrap ? wrap.clientWidth : window.innerWidth;
    const h = wrap ? wrap.clientHeight : window.innerHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.cssWidth = w;
    this.cssHeight = h;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    if (this.camera.x === 0 && this.camera.y === 0) {
      this.camera.x = w / 2;
      this.camera.y = h / 2;
    }
    this._notify();
  }
}
