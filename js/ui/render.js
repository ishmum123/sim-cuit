/*
 * Sim-cuit — js/ui/render.js
 * ---------------------------------------------------------------------------
 * Pure drawing + animation. Reads live ComponentInstance.state fields written
 * by the engine (v, i, p, temp, failed, failureMsg, justFailed, brightness,
 * rpm, spinning, charge) directly off the objects returned by
 * editor.getCircuit() — never mutates circuit data. Also reads editor's
 * interaction-state fields (camera/selection/hover/wiring/placing/marquee) to
 * draw previews, snap indicators, and selection halos. See the header comment
 * in js/ui/editor.js for the full list of fields this relies on.
 *
 * PUBLIC API:
 *   new Renderer(canvas, editor)
 *   renderer.draw(timeMs)        // call every requestAnimationFrame tick;
 *                                    timeMs should be a monotonically
 *                                    increasing millisecond timestamp (e.g.
 *                                    the value rAF passes to its callback)
 *   renderer.spawnSmoke(comp)    // manually trigger a ~2s smoke-wisp burst
 *                                    for a component; also invoked
 *                                    automatically, once per failure, when
 *                                    comp.state.justFailed is true
 *
 * Assumption (documented, since js/engine/* does not exist yet): wires
 * themselves carry no state, so "current through a wire" for glow/animated
 * dots is approximated by finding a component terminal coincident with one
 * end of the wire (via terminalOffsets) and using that component's
 * state.i/state.v. Wires with no resolvable endpoint component just render
 * as plain (non-animated) traces.
 * ---------------------------------------------------------------------------
 */

import { terminalOffsets } from '../engine/components.js';

// terminalOffsets(comp) returns ROTATED but component-RELATIVE {dx,dy} pairs
// (see js/engine/components.js: rotOffset() never adds comp.x/comp.y). Add
// the component position to get a world-space point.
function terminalWorldPoints(comp) {
  const offs = terminalOffsets(comp);
  return offs.map(o => ({ x: comp.x + o.x, y: comp.y + o.y }));
}

const GRID = 20;
const BODY_SIZE = {
  battery: { w: 90, h: 50 }, resistor: { w: 90, h: 36 }, led: { w: 70, h: 60 },
  diode: { w: 80, h: 36 }, capacitor: { w: 70, h: 50 }, motor: { w: 74, h: 74 },
  bulb: { w: 64, h: 64 }, fuse: { w: 90, h: 34 }, switch: { w: 90, h: 44 },
  potentiometer: { w: 100, h: 60 }, ground: { w: 50, h: 84 },
  voltmeter: { w: 64, h: 64 }, ammeter: { w: 64, h: 64 },
};
const DEFAULT_BODY_SIZE = { w: 90, h: 50 };
function bodySize(type) { return BODY_SIZE[type] || DEFAULT_BODY_SIZE; }

const COL = {
  bg: '#151a21',
  grid: 'rgba(255,255,255,0.045)',
  stroke: '#c9d3e0',
  strokeDim: '#5b6478',
  accent: '#4da3ff',
  warn: '#ffb454',
  danger: '#ff5c5c',
  ok: '#4dd68a',
  charred: '#4a3a30',
  label: '#8a93a6',
};

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbLerp(c1, c2, t) {
  const a = hexToRgb(c1), b = hexToRgb(c2);
  return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
}
// thermal tint: normal -> orange -> red as temp 0 -> 1
function thermalColor(temp, base = COL.stroke) {
  const t = clamp(temp || 0, 0, 1);
  if (t < 0.5) return rgbLerp(base, COL.warn, t / 0.5);
  return rgbLerp(COL.warn, COL.danger, (t - 0.5) / 0.5);
}
const LED_COLORS = {
  red: '#ff5c5c', green: '#4dd68a', blue: '#4da3ff', yellow: '#ffd24d',
  white: '#eef3ff', amber: '#ffb454', orange: '#ff9640',
};

export class Renderer {
  constructor(canvas, editor) {
    this.canvas = canvas;
    this.editor = editor;
    this.ctx = canvas.getContext('2d');
    this.smoke = new Map();      // compId -> particle[]
    this._smokeGuard = new WeakSet(); // state objects already smoked for current failure
    this._lastTime = 0;
    this._dotPhase = 0;
  }

  spawnSmoke(comp) {
    const parts = [];
    const n = 14;
    for (let i = 0; i < n; i++) {
      parts.push({
        x: (Math.random() - 0.5) * 14,
        y: (Math.random() - 0.5) * 8,
        vx: (Math.random() - 0.5) * 10,
        vy: -18 - Math.random() * 22,
        life: 0,
        maxLife: 1.4 + Math.random() * 0.8,
        size: 3 + Math.random() * 4,
      });
    }
    this.smoke.set(comp.id, { born: performance.now(), parts });
  }

  draw(timeMs) {
    const ctx = this.ctx;
    const editor = this.editor;
    const dt = this._lastTime ? Math.min(0.05, (timeMs - this._lastTime) / 1000) : 0;
    this._lastTime = timeMs;
    const t = timeMs / 1000;
    const { components, wires } = editor.getCircuit();

    const W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const dpr = editor.dpr || 1;
    const cam = editor.camera;
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);

    this._drawGrid(ctx, editor);

    for (const w of wires) this._drawWire(ctx, w, components, t);

    for (const comp of components) {
      this._updateSmoke(comp, dt);
      this._drawComponent(ctx, comp, editor, t);
    }

    this._drawJunctions(ctx, wires, components);

    this._drawWirePreview(ctx, editor);
    this._drawPlacingPreview(ctx, editor);
    this._drawMarquee(ctx, editor);

    // smoke drawn last (on top), in world space
    for (const comp of components) this._drawSmoke(ctx, comp);
  }

  // --------------------------------------------------------------- helpers

  _updateSmoke(comp, dt) {
    const s = comp.state;
    if (s && s.justFailed && !this._smokeGuard.has(s)) {
      this._smokeGuard.add(s);
      this.spawnSmoke(comp);
    }
    if (s && !s.failed) this._smokeGuard.delete(s);

    const entry = this.smoke.get(comp.id);
    if (!entry) return;
    let alive = false;
    for (const p of entry.parts) {
      p.life += dt;
      if (p.life < p.maxLife) alive = true;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy *= 0.98;
      p.vx *= 0.98;
    }
    if (!alive) this.smoke.delete(comp.id);
  }

  _drawSmoke(ctx, comp) {
    const entry = this.smoke.get(comp.id);
    if (!entry) return;
    ctx.save();
    ctx.translate(comp.x, comp.y);
    for (const p of entry.parts) {
      const lt = clamp(p.life / p.maxLife, 0, 1);
      if (lt >= 1) continue;
      const alpha = (1 - lt) * 0.35;
      const r = p.size * (1 + lt * 1.8);
      ctx.beginPath();
      ctx.fillStyle = `rgba(150,155,165,${alpha})`;
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _visibleWorldRect(editor) {
    const tl = editor.screenToWorld(0, 0);
    const br = editor.screenToWorld(editor.cssWidth, editor.cssHeight);
    return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
  }

  _drawGrid(ctx, editor) {
    if (!editor.cssWidth) return;
    const r = this._visibleWorldRect(editor);
    const startX = Math.floor(r.x0 / GRID) * GRID;
    const startY = Math.floor(r.y0 / GRID) * GRID;
    ctx.fillStyle = COL.grid;
    const rad = 1.1 / editor.camera.scale;
    for (let x = startX; x <= r.x1; x += GRID) {
      for (let y = startY; y <= r.y1; y += GRID) {
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ------------------------------------------------------------ wire logic

  _wireEndpointCurrent(point, components) {
    for (const comp of components) {
      let pts;
      try { pts = terminalWorldPoints(comp); } catch { pts = null; }
      if (!pts) continue;
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - point.x, pts[i].y - point.y) < 2.5) {
          return { comp, terminalIndex: i, i: (comp.state && comp.state.i) || 0 };
        }
      }
    }
    return null;
  }

  _drawWire(ctx, wire, components, t) {
    const pts = wire.points;
    if (!pts || pts.length < 2) return;

    const startHit = this._wireEndpointCurrent(pts[0], components);
    const endHit = this._wireEndpointCurrent(pts[pts.length - 1], components);
    const source = startHit || endHit;
    const mag = source ? Math.abs(source.i) : 0;
    const forward = !!startHit; // flow drawn start->end if we anchored current at start

    const glow = clamp(mag / 0.5, 0, 1);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (glow > 0.02) {
      ctx.save();
      ctx.shadowColor = COL.accent;
      ctx.shadowBlur = 8 * glow;
      ctx.strokeStyle = `rgba(77,163,255,${0.25 + glow * 0.3})`;
      ctx.lineWidth = 4;
      this._strokePoly(ctx, pts);
      ctx.restore();
    }

    ctx.strokeStyle = mag > 0.01 ? '#7fb8f5' : '#3a4356';
    ctx.lineWidth = 2;
    this._strokePoly(ctx, pts);
    ctx.restore();

    if (mag > 0.005) this._drawCurrentDots(ctx, pts, mag, forward, t);
  }

  _strokePoly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  _drawCurrentDots(ctx, pts, mag, forward, t) {
    const segLens = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      segLens.push(l);
      total += l;
    }
    if (total < 1) return;
    const speed = 40 + clamp(mag, 0, 3) * 90; // px/s
    const spacing = clamp(36 - mag * 20, 14, 36);
    const count = Math.max(1, Math.floor(total / spacing));
    const phase = (t * speed) % spacing;

    ctx.fillStyle = '#bfe0ff';
    ctx.shadowColor = COL.accent;
    ctx.shadowBlur = 4;
    for (let n = 0; n < count; n++) {
      let d = (n * spacing + phase) % total;
      if (!forward) d = total - d;
      const p = this._pointAtDistance(pts, segLens, total, d);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  _pointAtDistance(pts, segLens, total, d) {
    d = ((d % total) + total) % total;
    let acc = 0;
    for (let i = 0; i < segLens.length; i++) {
      if (d <= acc + segLens[i] || i === segLens.length - 1) {
        const segT = segLens[i] > 0 ? (d - acc) / segLens[i] : 0;
        const a = pts[i], b = pts[i + 1];
        return { x: lerp(a.x, b.x, clamp(segT, 0, 1)), y: lerp(a.y, b.y, clamp(segT, 0, 1)) };
      }
      acc += segLens[i];
    }
    return null;
  }

  // ------------------------------------------------------------ junctions

  // Draw a filled dot anywhere two or more things meet at the same point:
  // a terminal sitting mid-wire, two wires joined end-to-end, or a wire
  // ending on a terminal. Makes electrical connectivity visible at a glance.
  _drawJunctions(ctx, wires, components) {
    const tally = new Map();
    const bump = (p) => {
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    };
    for (const w of wires) {
      if (!w.points) continue;
      for (const p of w.points) bump(p);
    }
    for (const comp of components) {
      let pts;
      try { pts = terminalWorldPoints(comp); } catch { pts = null; }
      if (!pts) continue;
      for (const p of pts) bump(p);
    }
    ctx.save();
    ctx.fillStyle = COL.stroke;
    for (const [key, count] of tally) {
      if (count < 2) continue;
      const [x, y] = key.split(',').map(Number);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // -------------------------------------------------------- wiring preview

  _drawWirePreview(ctx, editor) {
    const w = editor.wiring;
    if (!w) return;
    const pts = [...w.points, ...(w.previewSegments || [])];
    if (pts.length < 2) return;
    const snapped = !!w.snapTerminal;
    const dotColor = snapped ? COL.ok : COL.accent;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = snapped ? 'rgba(77,214,138,0.9)' : 'rgba(77,163,255,0.8)';
    ctx.lineWidth = 2;
    this._strokePoly(ctx, pts);
    ctx.setLineDash([]);
    for (const p of pts) {
      ctx.beginPath();
      ctx.fillStyle = dotColor;
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (snapped) {
      // strong halo on the destination terminal we're snapped to
      const last = pts[pts.length - 1];
      ctx.beginPath();
      ctx.strokeStyle = COL.ok;
      ctx.lineWidth = 2;
      ctx.arc(last.x, last.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawPlacingPreview(ctx, editor) {
    if (!editor.placingType || !editor.placingPreviewPos) return;
    const { w, h } = bodySize(editor.placingType);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.translate(editor.placingPreviewPos.x, editor.placingPreviewPos.y);
    ctx.strokeStyle = COL.accent;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  _drawMarquee(ctx, editor) {
    const m = editor.marquee;
    if (!m) return;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    ctx.save();
    ctx.fillStyle = 'rgba(77,163,255,0.10)';
    ctx.strokeStyle = 'rgba(77,163,255,0.6)';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // --------------------------------------------------------- component draw

  _drawComponent(ctx, comp, editor, t) {
    const s = comp.state || {};
    const { w, h } = bodySize(comp.type);
    const selected = editor.selection.has(comp.id);
    const hovered = editor.hover && editor.hover.compId === comp.id;

    ctx.save();
    ctx.translate(comp.x, comp.y);
    ctx.rotate((comp.rot || 0) * Math.PI / 180);

    if (selected) {
      ctx.save();
      ctx.strokeStyle = COL.accent;
      ctx.fillStyle = 'rgba(77,163,255,0.08)';
      ctx.lineWidth = 1.5;
      this._roundRect(ctx, -w / 2 - 8, -h / 2 - 8, w + 16, h + 16, 8);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else if (hovered) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      this._roundRect(ctx, -w / 2 - 6, -h / 2 - 6, w + 12, h + 12, 7);
      ctx.stroke();
      ctx.restore();
    }

    const strokeColor = s.failed ? COL.charred : thermalColor(s.temp);
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Imported parts register as NEW registry keys cloned from a base type
    // (spec: "register as NEW registry entries cloned from a base type").
    // If main.js preserved that lineage as registry[type].base / .visualBase,
    // reuse the base type's symbol so imported parts still look right;
    // otherwise fall back to a generic labeled box.
    const regDef = (editor.registry && editor.registry[comp.type]) || null;
    const baseType = regDef && (regDef.base || regDef.visualBase);
    const drawFn = DRAWERS[comp.type] || (baseType && DRAWERS[baseType]) || drawGeneric;
    drawFn(ctx, comp, s, t, strokeColor);

    if (s.failed) this._drawCharredOverlay(ctx, w, h, t);

    // terminals: hollow circle affordance normally; while wiring, candidate
    // destinations get a soft highlight and the snapped-to terminal gets a
    // strong one; hovering (not wiring) enlarges/fills the single terminal
    // under the cursor.
    let pts;
    try { pts = terminalWorldPoints(comp); } catch { pts = null; }
    if (pts) {
      const wiring = editor.wiring;
      for (let i = 0; i < pts.length; i++) {
        const local = this._toLocal(comp, pts[i]);
        const isHoverTerm = hovered && editor.hover.terminalIndex === i;
        const isWireStart = !!wiring && wiring.fromComp === comp.id && wiring.fromTerminal === i;
        const isSnapTarget = !!wiring && !!wiring.snapTerminal &&
          wiring.snapTerminal.compId === comp.id && wiring.snapTerminal.terminalIndex === i;
        const isCandidate = !!wiring && !isWireStart && !isSnapTarget;

        if (isSnapTarget) {
          ctx.beginPath();
          ctx.fillStyle = COL.ok;
          ctx.arc(local.x, local.y, 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.strokeStyle = COL.ok;
          ctx.lineWidth = 1.6;
          ctx.arc(local.x, local.y, 9, 0, Math.PI * 2);
          ctx.stroke();
        } else if (isWireStart) {
          ctx.beginPath();
          ctx.fillStyle = COL.accent;
          ctx.arc(local.x, local.y, 5, 0, Math.PI * 2);
          ctx.fill();
        } else if (isCandidate) {
          ctx.beginPath();
          ctx.fillStyle = 'rgba(77,163,255,0.20)';
          ctx.arc(local.x, local.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1.3;
          ctx.strokeStyle = 'rgba(77,163,255,0.7)';
          ctx.stroke();
        } else if (isHoverTerm) {
          ctx.beginPath();
          ctx.fillStyle = COL.accent;
          ctx.arc(local.x, local.y, 4.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.lineWidth = 1.3;
          ctx.strokeStyle = '#5b6478';
          ctx.arc(local.x, local.y, 3.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // id label
    ctx.save();
    ctx.rotate(-(comp.rot || 0) * Math.PI / 180); // keep label upright
    ctx.fillStyle = COL.label;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(comp.id, 0, h / 2 + 16);
    ctx.restore();

    ctx.restore();
  }

  _toLocal(comp, worldPt) {
    // undo comp translate+rotate to get point in the component's local frame
    const rad = -(comp.rot || 0) * Math.PI / 180;
    const dx = worldPt.x - comp.x, dy = worldPt.y - comp.y;
    return { x: dx * Math.cos(rad) - dy * Math.sin(rad), y: dx * Math.sin(rad) + dy * Math.cos(rad) };
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _drawCharredOverlay(ctx, w, h, t) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    const cracks = 4;
    for (let i = 0; i < cracks; i++) {
      const ang = (i / cracks) * Math.PI * 2 + i;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(ang) * w * 0.3, Math.sin(ang) * h * 0.3);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ============================================================ symbol drawers
// Each drawer receives (ctx, comp, state, t, color) with ctx already
// translated to the component center and rotated by comp.rot. Draw in a
// local frame where 2-terminal parts run left(-40,0) to right(40,0).

function leadLines(ctx, x0, x1) {
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(x0, 0);
  ctx.moveTo(x1, 0); ctx.lineTo(40, 0);
  ctx.stroke();
}

function drawGeneric(ctx, comp, s) {
  ctx.strokeRect(-30, -18, 60, 36);
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(comp.type.slice(0, 8), 0, 4);
}

function drawBattery(ctx, comp, s) {
  leadLines(ctx, -10, 10);
  ctx.beginPath();
  ctx.moveTo(-8, -16); ctx.lineTo(-8, 16);
  ctx.moveTo(-2, -9); ctx.lineTo(-2, 9);
  ctx.moveTo(4, -16); ctx.lineTo(4, 16);
  ctx.moveTo(10, -9); ctx.lineTo(10, 9);
  ctx.stroke();
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${(comp.params.voltage ?? 9)}V`, 0, -24);
  if (s.charge !== undefined) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(-14, 20, 28, 4);
    ctx.fillStyle = COL.ok;
    ctx.fillRect(-14, 20, 28 * clamp(s.charge, 0, 1), 4);
  }
}

function drawResistor(ctx, comp, s) {
  leadLines(ctx, -24, 24);
  ctx.beginPath();
  ctx.moveTo(-24, 0);
  const seg = 8, amp = 9;
  for (let i = 0; i < 6; i++) {
    const x = -24 + seg * (i + 1);
    ctx.lineTo(x, i % 2 === 0 ? -amp : amp);
  }
  ctx.lineTo(24, 0);
  ctx.stroke();
}

function drawDiodeShape(ctx, comp, color, cathodeX = 6) {
  ctx.beginPath();
  ctx.moveTo(-cathodeX, -12);
  ctx.lineTo(-cathodeX, 12);
  ctx.lineTo(cathodeX, 0);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cathodeX, -12);
  ctx.lineTo(cathodeX, 12);
  ctx.stroke();
}

function drawDiode(ctx, comp, s, t, color) {
  leadLines(ctx, -12, 6);
  drawDiodeShape(ctx, comp, color, 6);
}

function drawLed(ctx, comp, s, t, color) {
  const bright = clamp(s.brightness || 0, 0, 1.2);
  const glowColor = LED_COLORS[comp.params.color] || LED_COLORS.red;
  if (bright > 0.02 && !s.failed) {
    ctx.save();
    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 34);
    grad.addColorStop(0, glowColor);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = clamp(bright, 0, 1) * 0.75;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  leadLines(ctx, -12, 6);
  drawDiodeShape(ctx, comp, s.failed ? color : (bright > 0.02 ? glowColor : color), 6);
  // little emitted-light arrows above the LED triangle
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  for (const ox of [-3, 4]) {
    ctx.beginPath();
    ctx.moveTo(ox - 6, -16); ctx.lineTo(ox, -24);
    ctx.moveTo(ox - 3, -24); ctx.lineTo(ox, -24); ctx.lineTo(ox, -21);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCapacitor(ctx, comp, s, t, color) {
  leadLines(ctx, -4, 4);
  ctx.beginPath();
  ctx.moveTo(-4, -16); ctx.lineTo(-4, 16);
  ctx.stroke();
  if (comp.params.polarized) {
    ctx.beginPath();
    ctx.moveTo(4, -14); ctx.quadraticCurveTo(9, 0, 4, 14);
    ctx.stroke();
    ctx.font = '11px sans-serif';
    ctx.fillText('+', -12, -18);
  } else {
    ctx.beginPath();
    ctx.moveTo(4, -16); ctx.lineTo(4, 16);
    ctx.stroke();
  }
}

function drawMotor(ctx, comp, s, t, color) {
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-26, 0);
  ctx.moveTo(26, 0); ctx.lineTo(40, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 26, 0, Math.PI * 2);
  ctx.stroke();
  const spinning = s.spinning && !s.failed;
  const ang = spinning ? t * clamp(s.rpm || 0, 0, 8000) * 0.02 : 0;
  ctx.save();
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(-16, 0); ctx.lineTo(16, 0);
  ctx.moveTo(0, -16); ctx.lineTo(0, 16);
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('M', 0, 4);
}

function drawBulb(ctx, comp, s, t, color) {
  const bright = clamp(s.brightness || 0, 0, 1.2);
  if (bright > 0.02 && !s.failed) {
    ctx.save();
    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 34);
    grad.addColorStop(0, 'rgba(255,214,140,0.9)');
    grad.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.globalAlpha = clamp(bright, 0, 1) * 0.8;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, -2, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-18, 0);
  ctx.moveTo(18, 0); ctx.lineTo(40, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -4, 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-18, 0); ctx.lineTo(-6, 6); ctx.lineTo(0, -8); ctx.lineTo(6, 6); ctx.lineTo(18, 0);
  ctx.stroke();
}

function drawFuse(ctx, comp, s, t) {
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-24, 0);
  ctx.moveTo(24, 0); ctx.lineTo(40, 0);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-24, -10); ctx.lineTo(24, -10);
  ctx.lineTo(24, 10); ctx.lineTo(-24, 10);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
  if (s.failed) {
    ctx.beginPath();
    ctx.moveTo(-20, 0); ctx.lineTo(-4, -4);
    ctx.moveTo(4, 5); ctx.lineTo(20, 0);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-20, 0);
    ctx.bezierCurveTo(-8, -10, 8, 10, 20, 0);
    ctx.stroke();
  }
}

function drawSwitch(ctx, comp, s) {
  const closed = !!comp.params.closed;
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-24, 0);
  ctx.moveTo(24, 0); ctx.lineTo(40, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-24, 0, 3, 0, Math.PI * 2);
  ctx.arc(24, 0, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-24, 0);
  if (closed) ctx.lineTo(24, 0); else ctx.lineTo(18, -16);
  ctx.stroke();
}

function drawPotentiometer(ctx, comp, s) {
  // Terminals per js/engine/components.js terminalOffsets(): A(-40,0), B(40,0),
  // wiper(0,+30) — the wiper lead must run DOWNWARD from the body.
  drawResistor(ctx, comp, s);
  const wiper = clamp(comp.params.wiper ?? 0.5, 0, 1);
  const wx = lerp(-24, 24, wiper);
  ctx.beginPath();
  ctx.moveTo(0, 16); ctx.lineTo(0, 30);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(wx, 9);
  ctx.lineTo(0, 16);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(wx - 3, 11); ctx.lineTo(wx, 9); ctx.lineTo(wx + 3, 11);
  ctx.stroke();
}

function drawGround(ctx) {
  // Terminal per terminalOffsets(): (0,-40) — lead must reach all the way up.
  ctx.beginPath();
  ctx.moveTo(0, -40); ctx.lineTo(0, 0);
  ctx.moveTo(-16, 0); ctx.lineTo(16, 0);
  ctx.moveTo(-10, 7); ctx.lineTo(10, 7);
  ctx.moveTo(-4, 14); ctx.lineTo(4, 14);
  ctx.stroke();
}

function drawMeter(ctx, comp, s, label, unit, valueFn) {
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-26, 0);
  ctx.moveTo(26, 0); ctx.lineTo(40, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 26, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, 0, 5);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = COL.label;
  ctx.fillText(valueFn(s), 0, 40);
}

const DRAWERS = {
  battery: drawBattery,
  resistor: drawResistor,
  led: drawLed,
  diode: drawDiode,
  capacitor: drawCapacitor,
  motor: drawMotor,
  bulb: drawBulb,
  fuse: drawFuse,
  switch: drawSwitch,
  potentiometer: drawPotentiometer,
  ground: drawGround,
  voltmeter: (ctx, comp, s) => drawMeter(ctx, comp, s, 'V', 'V', st => `${(st.v ?? 0).toFixed(2)}V`),
  ammeter: (ctx, comp, s) => drawMeter(ctx, comp, s, 'A', 'A', st => `${((st.i ?? 0) * 1000).toFixed(1)}mA`),
};
