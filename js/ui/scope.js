/*
 * Sim-cuit — js/ui/scope.js
 * ---------------------------------------------------------------------------
 * Oscilloscope panel: DOM/canvas owner, thin wrapper around the DOM-free
 * ScopeModel (js/ui/scopebuf.js) which holds the actual ring buffers and
 * trace add/evict/remove logic. This file only does: DOM creation, DPR-aware
 * canvas drawing, legend chips, and the show/hide slide animation.
 *
 * Design decisions (see SPEC/task notes for the "why"):
 *   - Invisible until used: the panel is built once (appended to
 *     #canvas-wrap) but stays translated off-screen (`.scope-panel` without
 *     `.open`) until the first probe is added, and slides back out at 0
 *     traces — #main-layout never reflows, this is purely an overlay.
 *   - Per-trace autoscale: each trace is independently autoscaled to fill
 *     the plot height. A shared absolute scale would flatten a millivolt/
 *     milliamp trace next to a several-volt trace into an invisible line;
 *     per-trace scaling keeps every probe readable regardless of unit, and
 *     each legend chip already carries the live absolute value + min/max
 *     span so the reader isn't misled about magnitude.
 *   - Bottom hints (#wire-hint / #canvas-hint) are hidden outright (not
 *     nudged up) while the scope is open — with the panel already claiming
 *     ~180px of the canvas's bottom edge, moving the hints up would put them
 *     in the middle of the drawing area, competing with the circuit itself.
 *     Hiding is the cleaner read: the hints are onboarding copy the user has
 *     almost certainly already dismissed mentally by the time they've wired
 *     up a probe.
 *
 * PUBLIC API:
 *   new Scope(container)                  // container: #canvas-wrap element
 *   scope.toggle(comp, defaultQuantity)    -> { action:'added'|'removed', evicted }
 *   scope.getQuantity(compId)              -> 'v' | 'i' | null
 *   scope.setQuantity(compId, quantity)    -> void  // no-op if not probed
 *   scope.pruneMissing(liveIds:Set)        -> trace[] // removed traces
 *   scope.sample(simTime, readValue)       -> void   // readValue(compId)->{v,i}
 *   scope.render(simTime)                  -> void   // call every rAF frame
 *   scope.clear()                          -> void   // Reset: wipe all buffers
 *   scope.resize()                         -> void   // force a canvas resync
 *   defaultQuantityForType(type, registry) -> 'v' | 'i'
 * ---------------------------------------------------------------------------
 */

import { ScopeModel, autoscale, MAX_TRACES } from './scopebuf.js';
import { THEME } from './render.js';

const WINDOW_SEC = 2;
const SAMPLE_CAPACITY = 900; // generous headroom above 2s @ 60fps (~120 samples)
const PANEL_HEIGHT = 180;
const LEGEND_HEIGHT = 30;

function readMagenta() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--vb-magenta').trim();
    if (v) return v;
  } catch { /* no DOM / stylesheet — fall through */ }
  return '#88507D';
}

// TRACE_ROLES order from scopebuf.js is ['blue','red','green','magenta'] —
// resolve those roles to actual vimbones hexes here (the only place that
// needs a live DOM/stylesheet).
function roleColors() {
  return { blue: THEME.accent, red: THEME.danger, green: THEME.ok, magenta: readMagenta() };
}

export function defaultQuantityForType(type, registry) {
  const def = (registry && registry[type]) || {};
  const base = def.visualBase || type;
  return (base === 'ammeter' || base === 'fuse' || base === 'battery') ? 'i' : 'v';
}

function formatValue(quantity, v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  if (quantity === 'i') {
    const av = Math.abs(v);
    if (av < 1) return `${(v * 1000).toFixed(1)} mA`;
    return `${v.toFixed(3)} A`;
  }
  return `${v.toFixed(2)} V`;
}

export class Scope {
  constructor(container, { onRemove } = {}) {
    this.container = container;
    this.model = new ScopeModel({ windowSec: WINDOW_SEC, sampleCapacity: SAMPLE_CAPACITY, maxTraces: MAX_TRACES });
    this._onRemove = onRemove || (() => {});
    this._colors = roleColors();
    this._chips = new Map(); // compId -> { root, valueEl }
    this._open = false;
    this._lastSimTime = 0;
    this._buildDom();
    this._syncCanvasSize();
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => { this._syncCanvasSize(); this.render(this._lastSimTime); });
      this._ro.observe(this.panel);
    } else {
      window.addEventListener('resize', () => { this._syncCanvasSize(); this.render(this._lastSimTime); });
    }
  }

  _buildDom() {
    this.panel = document.createElement('div');
    this.panel.id = 'scope-panel';
    this.panel.className = 'scope-panel';
    this.panel.setAttribute('aria-label', 'Oscilloscope');

    this.legend = document.createElement('div');
    this.legend.id = 'scope-legend';
    this.legend.className = 'scope-legend';

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'scope-canvas';
    this.canvas.className = 'scope-canvas';
    this.ctx = this.canvas.getContext('2d');

    this.panel.appendChild(this.legend);
    this.panel.appendChild(this.canvas);
    this.container.appendChild(this.panel);
  }

  _syncCanvasSize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.panel.clientWidth || this.container.clientWidth;
    const h = Math.max(1, PANEL_HEIGHT - LEGEND_HEIGHT);
    this._cssW = w;
    this._cssH = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this._dpr = dpr;
  }

  // -------------------------------------------------------------- probing

  toggle(comp, defaultQuantity) {
    const existing = this.model.getTrace(comp.id);
    if (existing) {
      this.model.removeProbe(comp.id);
      this._syncOpenState();
      return { action: 'removed', evicted: null };
    }
    const { evicted } = this.model.addProbe(comp.id, defaultQuantity);
    this._syncOpenState();
    return { action: 'added', evicted };
  }

  getQuantity(compId) {
    const tr = this.model.getTrace(compId);
    return tr ? tr.quantity : null;
  }

  setQuantity(compId, quantity) {
    if (!this.model.getTrace(compId)) return;
    this.model.addProbe(compId, quantity); // re-quantities in place (see scopebuf.js)
  }

  pruneMissing(liveIds) {
    const removed = this.model.pruneMissing(liveIds);
    if (removed.length) this._syncOpenState();
    return removed;
  }

  clear() { this.model.clearAll(); }

  resize() { this._syncCanvasSize(); this.render(this._lastSimTime); }

  // ------------------------------------------------------------- sampling

  sample(simTime, readValue) { this.model.sample(simTime, readValue); }

  // -------------------------------------------------------------- drawing

  _syncOpenState() {
    const shouldOpen = this.model.traces.length > 0;
    if (shouldOpen === this._open) return;
    this._open = shouldOpen;
    this.panel.classList.toggle('open', this._open);
    this.container.classList.toggle('scope-open', this._open);
  }

  render(simTime) {
    this._lastSimTime = simTime || 0;
    if (!this._open) return; // nothing to draw while collapsed
    this._renderLegend();
    this._renderCanvas(this._lastSimTime);
  }

  _renderLegend() {
    const liveIds = new Set(this.model.traces.map((t) => t.compId));
    for (const [id, chip] of this._chips) {
      if (!liveIds.has(id)) { chip.root.remove(); this._chips.delete(id); }
    }
    for (const tr of this.model.traces) {
      let chip = this._chips.get(tr.compId);
      if (!chip) {
        const root = document.createElement('div');
        root.className = 'scope-chip';
        const swatch = document.createElement('span');
        swatch.className = 'scope-chip-swatch';
        swatch.style.background = this._colors[tr.color] || THEME.accent;
        const label = document.createElement('span');
        label.className = 'scope-chip-label';
        const valueEl = document.createElement('span');
        valueEl.className = 'scope-chip-value';
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'scope-chip-x';
        x.setAttribute('aria-label', `Remove ${tr.compId} trace`);
        x.textContent = '×';
        x.addEventListener('click', () => {
          this.model.removeProbe(tr.compId);
          this._syncOpenState();
          this._onRemove(tr.compId);
          this._renderLegend();
        });
        root.appendChild(swatch);
        root.appendChild(label);
        root.appendChild(valueEl);
        root.appendChild(x);
        this.legend.appendChild(root);
        chip = { root, label, valueEl };
        this._chips.set(tr.compId, chip);
      }
      const last = tr.buf.last();
      chip.label.textContent = `${tr.compId} · ${tr.quantity.toUpperCase()} =`;
      chip.valueEl.textContent = formatValue(tr.quantity, last ? last.v : 0);
    }
  }

  _renderCanvas(nowT) {
    const ctx = this.ctx;
    const dpr = this._dpr || 1;
    const w = this._cssW, h = this._cssH;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, w, h);

    // time gridlines (quarters of the window) + center baseline
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      const x = Math.round((w * k) / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    // Distinct dash pattern per trace slot (on top of its color) — two
    // traces that happen to coincide exactly (e.g. mirrored currents on
    // either side of a simple series loop both reading as flat DC) stay
    // visually distinguishable instead of one fully hiding the other.
    const DASH_PATTERNS = [[], [7, 4], [1.5, 3], [7, 3, 1.5, 3]];
    const margin = 6;
    this.model.traces.forEach((tr, idx) => {
      const points = this.model.windowedData(tr, nowT);
      if (!points.length) return;
      const { min, max } = autoscale(points);
      const span = (max - min) || 1;
      const color = this._colors[tr.color] || THEME.accent;
      const toXY = (p) => {
        const x = w * (1 - (nowT - p.t) / WINDOW_SEC);
        const norm = (p.v - min) / span; // 0..1
        return { x, y: margin + (1 - norm) * (h - margin * 2) };
      };
      if (points.length === 1) {
        // A single sample (e.g. a part that failed on its very first
        // recorded step) has no line to draw — mark it with a dot instead
        // of leaving that trace invisible.
        const { x, y } = toXY(points[0]);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.setLineDash(DASH_PATTERNS[idx % DASH_PATTERNS.length]);
      ctx.beginPath();
      points.forEach((p, i) => {
        const { x, y } = toXY(p);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.restore();
  }
}
