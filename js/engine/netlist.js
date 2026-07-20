/*
 * Sim-cuit — js/engine/netlist.js
 * ---------------------------------------------------------------------------
 * Electrical node extraction (DOM-free, Node-testable).
 * assignNodes(components, wires) unions component terminals with wire
 * vertices (including terminals landing mid-segment on orthogonal wires),
 * pins ground components to node 0 (falling back to a battery negative
 * terminal), and writes comp.nodes = [nodeIdx per terminal].
 */

import { terminalOffsets } from './components.js';

const key = (p) => `${p.x},${p.y}`;

function onSegment(p, a, b) {
  if (a.x === b.x) {
    return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  }
  if (a.y === b.y) {
    return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  }
  return false;
}

// Returns { ok, warning } — warning set when ground had to be inferred.
export function assignNodes(components, wires) {
  const parent = new Map();
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    let c = k;
    while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const add = (k) => { if (!parent.has(k)) parent.set(k, k); };
  const union = (a, b) => { add(a); add(b); parent.set(find(a), find(b)); };

  const termPoints = []; // { comp, ti, p }
  for (const c of components) {
    terminalOffsets(c).forEach((o, ti) => {
      const p = { x: c.x + o.x, y: c.y + o.y };
      termPoints.push({ comp: c, ti, p });
      add(key(p));
    });
  }
  for (const w of wires) {
    for (let i = 0; i < w.points.length; i++) {
      add(key(w.points[i]));
      if (i > 0) union(key(w.points[i - 1]), key(w.points[i]));
    }
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1], b = w.points[i];
      for (const t of termPoints) {
        if (onSegment(t.p, a, b)) union(key(t.p), key(a));
      }
    }
  }

  const groundRoots = new Set();
  for (const t of termPoints) {
    if (t.comp.type === 'ground') groundRoots.add(find(key(t.p)));
  }
  let warning = null;
  if (groundRoots.size === 0) {
    const bat = termPoints.find((t) => t.comp.type === 'battery' && t.ti === 1);
    if (bat) {
      groundRoots.add(find(key(bat.p)));
      warning = 'No ground in circuit — using battery negative terminal as reference.';
    }
  }

  const rootToNode = new Map();
  let next = 1;
  for (const r of groundRoots) rootToNode.set(r, 0);
  for (const c of components) c.nodes = [];
  for (const t of termPoints) {
    const r = find(key(t.p));
    if (!rootToNode.has(r)) rootToNode.set(r, next++);
    t.comp.nodes[t.ti] = rootToNode.get(r);
  }
  return { ok: termPoints.length > 0, warning };
}
