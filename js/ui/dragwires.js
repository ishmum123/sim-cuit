/*
 * Sim-cuit — js/ui/dragwires.js
 * ---------------------------------------------------------------------------
 * Pure, Node-testable helper that makes wires follow dragged components.
 *
 * Electrical connectivity in this app is purely positional (see
 * js/engine/netlist.js: components/wires are unioned by exactly-coincident
 * {x,y} points). That means moving a component without also moving the wire
 * vertices that sit on its terminals silently disconnects it. This module is
 * the single place that reroutes wires to keep up with a component move.
 *
 * Design: given the ORIGINAL (pre-move) component/wire layout, a set of
 * dragged component ids, and a total (dx, dy) delta from the drag's start,
 * compute brand-new component positions and wire point arrays. Callers
 * (js/ui/editor.js) call this fresh on every pointer-move with the *total*
 * delta since mousedown (not incremental deltas) — recomputing from the
 * original snapshot each time avoids drift and avoids compounding elbow
 * insertions into longer and longer polylines.
 *
 * Reroute heuristic per wire:
 *   - If a wire's FIRST and LAST point both coincide with a terminal of a
 *     dragged component (pre-move), the whole wire is a direct link between
 *     dragged parts (e.g. two components in a multi-select drag) — translate
 *     every point in it rigidly by (dx, dy).
 *   - Otherwise walk the polyline; any vertex (endpoint or interior) that
 *     coincided with a dragged terminal moves by (dx, dy); vertices that
 *     didn't (including tap junctions spliced in from other, non-dragged,
 *     wires) stay put. Whenever a segment ends up with one moved endpoint and
 *     one fixed endpoint, a single elbow point is inserted so the segment
 *     stays axis-aligned — the same one-elbow heuristic the rubber-band
 *     wiring preview uses (see Editor._orthoBend).
 */

import { terminalOffsets } from '../engine/components.js';

function terminalWorldPoints(comp) {
  return terminalOffsets(comp).map(o => ({ x: comp.x + o.x, y: comp.y + o.y }));
}

function keyOf(p) { return `${p.x},${p.y}`; }

// Mirrors Editor._orthoBend(from, to): if the two points don't already share
// an axis, return the single elbow point that keeps the two-segment path
// axis-aligned (go horizontal from `from`, then vertical into `to`).
function orthoBend(from, to) {
  if (from.x === to.x || from.y === to.y) return [];
  return [{ x: to.x, y: from.y }];
}

function rerouteWire(origPoints, movingKeySet, dx, dy) {
  const n = origPoints.length;
  if (n === 0) return [];
  const moved = origPoints.map(p => movingKeySet.has(keyOf(p)));

  if (n >= 2 && moved[0] && moved[n - 1]) {
    // Both ends of this wire are anchored to dragged terminals: it's a
    // direct link between (possibly multiple) dragged components — move the
    // whole polyline together, preserving its shape exactly.
    return origPoints.map(p => ({ x: p.x + dx, y: p.y + dy }));
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const p = origPoints[i];
    const newP = moved[i] ? { x: p.x + dx, y: p.y + dy } : { x: p.x, y: p.y };
    if (out.length === 0) { out.push(newP); continue; }
    const prev = out[out.length - 1];
    if (prev.x !== newP.x && prev.y !== newP.y) {
      out.push(...orthoBend(prev, newP));
    }
    out.push(newP);
  }
  return out;
}

// components: [{id, x, y, type, rot}, ...] — the ORIGINAL (pre-drag) layout.
// wires: [{id, points:[{x,y},...]}, ...] — the ORIGINAL (pre-drag) layout.
// ids: iterable of component ids being dragged.
// dx, dy: total world-space delta from the drag's start (already grid-snapped
//   by the caller).
// Returns { components, wires } — brand-new arrays/objects; inputs are not
// mutated, so callers can hold onto the original snapshot for the next call.
export function moveComponentsWithWires(components, wires, ids, dx, dy) {
  const idSet = new Set(ids);
  const movingKeySet = new Set();
  for (const c of components) {
    if (!idSet.has(c.id)) continue;
    for (const p of terminalWorldPoints(c)) movingKeySet.add(keyOf(p));
  }

  const newComponents = components.map(c => (
    idSet.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : { ...c }
  ));
  const newWires = wires.map(w => ({
    id: w.id,
    points: rerouteWire(w.points, movingKeySet, dx, dy),
  }));

  return { components: newComponents, wires: newWires };
}
