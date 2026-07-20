/*
 * Sim-cuit — js/ui/scopebuf.js
 * ---------------------------------------------------------------------------
 * DOM-free oscilloscope buffering/trace-management logic. Kept separate from
 * js/ui/scope.js (which owns the <canvas>, legend DOM, and drawing) so the
 * core data structures — ring buffer, trace add/evict/remove, windowing,
 * autoscale math, sample-rate gating — can be unit tested with plain Node
 * (see test/scopebuf.test.mjs) with zero DOM/canvas mocking.
 *
 * PUBLIC API:
 *   new RingBuffer(capacity)
 *     .push(t, v)         -> void   // overwrites oldest sample once full
 *     .clear()             -> void
 *     .toArray()           -> {t,v}[]  // oldest -> newest
 *     .last()               -> {t,v} | null
 *
 *   new ScopeModel({ windowSec, sampleCapacity, maxTraces })
 *     .traces                        -> { compId, quantity:'v'|'i', buf, color }[]
 *     .getTrace(compId)              -> trace | undefined
 *     .addProbe(compId, quantity)    -> { added, evicted } // evicted is the
 *                                        trace bumped off when already at
 *                                        maxTraces, else null
 *     .removeProbe(compId)           -> trace | null
 *     .clearAll()                    -> void   // e.g. on Reset
 *     .sample(t, readValue)          -> void   // readValue(compId) -> {v,i}
 *     .windowedData(trace, tNow)     -> {t,v}[] within [tNow - windowSec, tNow]
 *     .pruneMissing(liveIds)         -> trace[] // removes+returns traces whose
 *                                        compId is no longer in liveIds (Set)
 *
 *   autoscale(points, padFrac=0.1)   -> { min, max } // sensible default scale
 *                                        (widens a flat/zero series so it
 *                                        doesn't render as a degenerate line)
 *   shouldSample(lastT, nowT, minDt) -> boolean // frame-decimation gate:
 *                                        record at most once per minDt of sim
 *                                        time (default one sample/frame is
 *                                        achieved by the caller passing its
 *                                        own per-frame cadence as minDt=0)
 * ---------------------------------------------------------------------------
 */

// A hard ceiling on any single recorded sample, applied in ScopeModel.sample.
// The MNA solver (js/engine/solver.js) guarantees finite output but, under
// an extreme near-singular stamp (e.g. a resistor set to ~0Ω right as a part
// is failing), a degraded/un-converged accepted iterate can occasionally be
// finite yet wildly non-physical (observed: ~1e14 on a circuit whose sane
// values are all single digits). One such glitch sample would otherwise
// dominate autoscale and flatten the entire rest of a trace to invisibility.
// 1e4 is far above anything this app's components actually produce (even a
// hard short of a 9V source), so a genuine large fault current/voltage spike
// still reads as a dramatic spike — it just can't blow out the whole axis.
export const MAX_SAMPLE_MAGNITUDE = 1e4;

function clampSample(val) {
  if (!Number.isFinite(val)) return 0;
  if (val > MAX_SAMPLE_MAGNITUDE) return MAX_SAMPLE_MAGNITUDE;
  if (val < -MAX_SAMPLE_MAGNITUDE) return -MAX_SAMPLE_MAGNITUDE;
  return val;
}

export const MAX_TRACES = 4;
// Vimbones trace order: blue, red, green, magenta — resolved to actual CSS
// custom-property hexes by the caller (js/ui/scope.js); this module only
// hands out a stable *role* string so tests don't need a DOM/stylesheet.
export const TRACE_ROLES = ['blue', 'red', 'green', 'magenta'];

export class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this.t = new Float64Array(this.capacity);
    this.v = new Float64Array(this.capacity);
    this.start = 0; // index of the oldest sample
    this.count = 0;
  }

  push(t, v) {
    const idx = (this.start + this.count) % this.capacity;
    this.t[idx] = t;
    this.v[idx] = v;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  clear() { this.start = 0; this.count = 0; }

  toArray() {
    const out = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const idx = (this.start + i) % this.capacity;
      out[i] = { t: this.t[idx], v: this.v[idx] };
    }
    return out;
  }

  last() {
    if (!this.count) return null;
    const idx = (this.start + this.count - 1) % this.capacity;
    return { t: this.t[idx], v: this.v[idx] };
  }
}

export class ScopeModel {
  constructor({ windowSec = 2, sampleCapacity = 4000, maxTraces = MAX_TRACES } = {}) {
    this.windowSec = windowSec;
    this.sampleCapacity = sampleCapacity;
    this.maxTraces = maxTraces;
    this.traces = [];
  }

  getTrace(compId) { return this.traces.find((tr) => tr.compId === compId); }

  // Adds (or re-quantities) a probe. Traces are pushed to the end of the
  // array, so index 0 is always the oldest — a 5th probe evicts it (FIFO),
  // per spec: "adding a 5th evicts the oldest with a toast."
  addProbe(compId, quantity) {
    const existing = this.getTrace(compId);
    if (existing) {
      if (existing.quantity !== quantity) { existing.quantity = quantity; existing.buf.clear(); }
      return { added: existing, evicted: null };
    }
    let evicted = null;
    if (this.traces.length >= this.maxTraces) {
      evicted = this.traces.shift();
    }
    const role = TRACE_ROLES[this._usedRoles().length % TRACE_ROLES.length];
    const tr = { compId, quantity, buf: new RingBuffer(this.sampleCapacity), color: role };
    this.traces.push(tr);
    return { added: tr, evicted };
  }

  removeProbe(compId) {
    const idx = this.traces.findIndex((tr) => tr.compId === compId);
    if (idx === -1) return null;
    return this.traces.splice(idx, 1)[0];
  }

  clearAll() { for (const tr of this.traces) tr.buf.clear(); }

  // readValue(compId) -> {v,i} | undefined
  sample(t, readValue) {
    for (const tr of this.traces) {
      const rec = readValue(tr.compId);
      const val = rec ? (tr.quantity === 'i' ? rec.i : rec.v) : 0;
      tr.buf.push(t, clampSample(val));
    }
  }

  windowedData(trace, tNow) {
    const tMin = tNow - this.windowSec;
    return trace.buf.toArray().filter((p) => p.t >= tMin);
  }

  // Drops (and returns) any traces whose compId is not in `liveIds` (a
  // Set<string>) — used when a probed component is deleted from the circuit.
  pruneMissing(liveIds) {
    const removed = [];
    this.traces = this.traces.filter((tr) => {
      if (liveIds.has(tr.compId)) return true;
      removed.push(tr);
      return false;
    });
    return removed;
  }

  _usedRoles() { return this.traces; }
}

// Widens a flat/empty series so it never renders as a degenerate zero-height
// line; adds `padFrac` headroom above/below the observed range otherwise.
export function autoscale(points, padFrac = 0.1) {
  if (!points || !points.length) return { min: -1, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
  if (min === max) {
    const base = Math.abs(min) || 1;
    return { min: min - base * 0.5, max: max + base * 0.5 };
  }
  const pad = (max - min) * padFrac;
  return { min: min - pad, max: max + pad };
}

// Frame-decimation gate: record at most one sample per `minDt` of sim time.
export function shouldSample(lastT, nowT, minDt) {
  if (lastT === null || lastT === undefined) return true;
  return (nowT - lastT) >= minDt;
}
