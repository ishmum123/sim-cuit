// js/engine/components.js
// Contract: DOM-free component model registry for the MNA solver (solver.js).
// Each registry entry implements: defaultParams/defaultRatings/paramSchema,
// stamp(comp, ctx) [called every Newton iteration], computeState(comp, ctx)
// [called once after convergence to write state.v/i/p], postStep(comp, dt)
// [thermal + permanent-failure logic], spice(comp, nodeNames), kicad metadata.
//
// Also exports: terminalOffsets(comp), createComponent(type, x, y), repair(comp),
// resetIdCounters().

// ---------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------

import { SketchRuntime } from './sketch.js';

const GMIN_LEAK = 1e-12;
const FAIL_OPEN_G = 1e-12;
const FAIL_SHORT_G = 1e3;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// stamp a branch (a->b) whose current is modeled as  i = g*(Va-Vb) + K
// (linear companion model around the current Newton iterate).
function stampCompanion(ctx, a, b, g, K) {
  ctx.G(a, b, g);
  ctx.I(a, -K);
  ctx.I(b, K);
}

// plain resistor stamp helper
function stampResistor(ctx, a, b, ohms) {
  const r = Math.max(ohms, 1e-9);
  ctx.G(a, b, 1 / r);
}

// --- Shockley diode companion model w/ pnjlim-style junction voltage limiting.
// `store` is the comp.state object; `key` disambiguates multiple junctions
// on one component (e.g. future multi-junction parts).
function diodeCompanion(state, key, is, nVt, Vraw) {
  const vt = nVt;
  const vcrit = vt * Math.log(vt / (Math.SQRT2 * is));
  if (!state._prevVd) state._prevVd = {};
  let vold = state._prevVd[key];
  if (vold === undefined) vold = 0;
  let v = Vraw;
  if (v > vcrit && Math.abs(v - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (v - vold) / vt;
      v = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      v = vt * Math.log(Math.max(v / vt, 1e-12));
    }
  }
  // also guard very negative excursions from producing -Infinity etc (exp underflows to 0, fine)
  state._prevVd[key] = v;
  const ev = Math.exp(clamp(v / vt, -80, 80));
  const id = is * (ev - 1);
  const gd = Math.max((is / vt) * ev, GMIN_LEAK);
  const K = id - gd * v; // companion constant term
  return { g: gd, K };
}

function diodeCurrentAt(is, nVt, v) {
  const ev = Math.exp(clamp(v / nVt, -80, 80));
  return is * (ev - 1);
}

// ---------------------------------------------------------------------------
// id counters
// ---------------------------------------------------------------------------

let idCounters = {};

export function resetIdCounters() {
  idCounters = {};
}

function nextId(prefix) {
  idCounters[prefix] = (idCounters[prefix] || 0) + 1;
  return `${prefix}${idCounters[prefix]}`;
}

// ---------------------------------------------------------------------------
// terminal geometry
// ---------------------------------------------------------------------------

// rotate a local offset (dx,dy) by rot degrees (0/90/180/270), grid-snapped.
function rotOffset(dx, dy, rot) {
  switch (((rot % 360) + 360) % 360) {
    case 90: return { x: -dy, y: dx };
    case 180: return { x: -dx, y: -dy };
    case 270: return { x: dy, y: -dx };
    default: return { x: dx, y: dy };
  }
}

export function terminalOffsets(comp) {
  const rot = comp.rot || 0;
  const type = comp.type;
  if (type === 'ground') {
    return [rotOffset(0, -40, rot)];
  }
  if (type === 'potentiometer') {
    return [
      rotOffset(-40, 0, rot), // A
      rotOffset(40, 0, rot),  // B
      rotOffset(0, 30, rot),  // wiper
    ];
  }
  if (type === 'npn' || type === 'pnp') {
    return [
      rotOffset(40, -20, rot), // collector
      rotOffset(-40, 0, rot),  // base
      rotOffset(40, 20, rot),  // emitter
    ];
  }
  if (type === 'nmos' || type === 'pmos') {
    return [
      rotOffset(40, -20, rot), // drain
      rotOffset(-40, 0, rot),  // gate
      rotOffset(40, 20, rot),  // source
    ];
  }
  if (type === 'esp32') {
    return [
      rotOffset(-60, -60, rot), // VIN
      rotOffset(-60, 0, rot),   // GND
      rotOffset(-60, 60, rot),  // 3V3
      rotOffset(60, -60, rot),  // GPIO2
      rotOffset(60, 0, rot),    // GPIO4
      rotOffset(60, 60, rot),   // GPIO5
    ];
  }
  // default 2-terminal parts (battery, resistor, led, diode, zener, capacitor,
  // motor, bulb, fuse, switch, voltmeter, ammeter)
  return [rotOffset(-40, 0, rot), rotOffset(40, 0, rot)];
}

// ---------------------------------------------------------------------------
// failure helpers
// ---------------------------------------------------------------------------

function markFailed(state, kind, msg) {
  if (state.failed) return; // already failed / permanent
  state.failed = kind;
  state.failureMsg = msg;
  state.justFailed = true;
}

function clearJustFailed(state) {
  if (state.justFailed) state.justFailed = false;
}

export function repair(comp) {
  const s = comp.state || (comp.state = {});
  s.failed = null;
  s.failureMsg = null;
  s.justFailed = false;
  s.temp = 0;
  s.i2t = 0;
  s._prevVd = {};
  s.filamentTemp = 0;
  s.rpm = 0;
  s.spinning = false;
  s.brightness = 0;
  // esp32-specific (harmless no-op for other types)
  s.pinFailed = null;
  s.brownout = false;
  s.status = null;
  s.gpio = null;
  s.pinCurrent = null;
  s._sketch = null;
  s._sketchPoweredPrev = false;
  s.sketchPins = null;
  s.sketchStatus = null;
  s.sketchLog = null;
  s.sketchLogTimes = null;
  s.sketchErrorLine = null;
  if (comp.type === 'switch') {
    // leave user-set closed state alone
  }
  return comp;
}

// ---------------------------------------------------------------------------
// BJT (npn/pnp) — simplified Ebers-Moll, shared by both polarities
// ---------------------------------------------------------------------------

function makeBjt(polarity, label, prefix, params) {
  return {
    label, prefix, terminals: 3,
    defaultParams: { beta: 150, isE: 6e-15, isC: 6e-14, n: 1, ...params },
    defaultRatings: { maxCurrent: 0.2, maxPower: 0.625, maxVceo: 40 },
    paramSchema: [
      { key: 'beta', label: 'Current Gain (β)', type: 'number', min: 1 },
      { key: 'isE', label: 'BE Saturation Current (A)', type: 'number', min: 1e-18 },
      { key: 'n', label: 'Ideality Factor', type: 'number', min: 1 },
    ],
    stamp(comp, ctx) {
      const [c, b, e] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'short') { stampResistor(ctx, c, e, 1 / FAIL_SHORT_G); return; }
      const isE = comp.params.isE, isC = comp.params.isC;
      const nVt = (comp.params.n || 1) * 0.02585;
      const beta = comp.params.beta;
      // beP/beN and bcP/bcN swap by polarity so the same diode math produces
      // the "forward-sense" junction voltage/current for either npn or pnp.
      const beP = polarity > 0 ? b : e, beN = polarity > 0 ? e : b;
      const bcP = polarity > 0 ? b : c, bcN = polarity > 0 ? c : b;
      const Vbe = ctx.vNode(beP) - ctx.vNode(beN);
      const { g: gBe, K: KBe } = diodeCompanion(s, 'be', isE, nVt, Vbe);
      stampCompanion(ctx, beP, beN, gBe, KBe);
      const Vbc = ctx.vNode(bcP) - ctx.vNode(bcN);
      const { g: gBc, K: KBc } = diodeCompanion(s, 'bc', isC, nVt, Vbc);
      stampCompanion(ctx, bcP, bcN, gBc, KBc);
      // controlled collector current: beta * Ibe, recomputed fresh each Newton
      // iteration from the linearized BE companion (same "fixed point per
      // iteration" idiom the motor uses for its back-EMF term). Also
      // linearized w.r.t. its OWN terminal voltage (Early-effect-like output
      // conductance) exactly like a companion diode, so the C-E branch has a
      // real Jacobian entry instead of a bare floating current source —
      // without this, Newton has nothing damping the C-E loop and diverges.
      const ibeNow = gBe * (ctx.vNode(beP) - ctx.vNode(beN)) + KBe;
      const ibcNow = gBc * (ctx.vNode(bcP) - ctx.vNode(bcN)) + KBc;
      const icForward = Math.max(beta * ibeNow, 0);
      const ceP = polarity > 0 ? c : e, ceN = polarity > 0 ? e : c;
      const vceFwdNow = ctx.vNode(ceP) - ctx.vNode(ceN);
      const gce = Math.max(icForward, 1e-9) / 100; // Early voltage ~100V
      const Kce = icForward - gce * vceFwdNow;
      stampCompanion(ctx, ceP, ceN, gce, Kce);
      // Stash the companion-linearized junction currents (NOT recomputed raw
      // from final node voltages in computeState) — with a base resistor
      // dominating the loop the diode's own conductance can stay far below
      // the outer Newton tolerance's sensitivity, so the matrix can settle
      // while Vbe is still mid-pnjlim-ladder; evaluating a bare exponential
      // at that raw, not-fully-walked-down voltage overflows. Reusing the
      // exact linear values the matrix was actually solved with keeps the
      // reported current self-consistent with what was stamped.
      s._ibeLast = ibeNow;
      s._ibcLast = ibcNow;
    },
    computeState(comp, ctx) {
      const [c, b, e] = comp.nodes;
      const s = comp.state;
      const vceRaw = ctx.vNode(c) - ctx.vNode(e);
      const vbeRaw = ctx.vNode(b) - ctx.vNode(e);
      if (s.failed === 'short') {
        s.v = vceRaw; s.vbe = vbeRaw; s.ib = 0;
        s.i = vceRaw / (1 / FAIL_SHORT_G);
        s.p = Math.abs(s.v * s.i);
        return;
      }
      const beta = comp.params.beta;
      const ibeJ = s._ibeLast || 0;
      const ibcJ = s._ibcLast || 0;
      const icJ = beta * ibeJ - ibcJ;
      const ibJ = ibeJ + ibcJ;
      s.v = vceRaw;
      s.vbe = vbeRaw;
      s.i = polarity * icJ;
      s.ib = polarity * ibJ;
      s.p = Math.abs(vceRaw * s.i) + Math.abs(vbeRaw * s.ib);
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) return;
      const maxI = comp.ratings.maxCurrent;
      const maxP = comp.ratings.maxPower;
      const maxV = comp.ratings.maxVceo;
      if (Math.abs(s.v) > maxV) {
        markFailed(s, 'short', `${comp.id} breakdown: |Vce| ${Math.abs(s.v).toFixed(1)}V exceeded ${maxV}V Vceo rating`);
        return;
      }
      const ratio = Math.max(Math.abs(s.i) / maxI, Math.abs(s.p) / maxP);
      if (ratio > 1) {
        s.temp = (s.temp || 0) + dt * (ratio - 1) / 0.8;
      } else {
        s.temp = Math.max((s.temp || 0) - dt * 0.25, 0);
      }
      if (s.temp >= 1) {
        markFailed(s, 'short', `${comp.id} burned out: ${(Math.abs(s.p) * 1000).toFixed(0)} mW > ${(maxP * 1000).toFixed(0)} mW max`);
      }
    },
    spice(comp, nn) {
      const model = polarity > 0 ? 'NPN' : 'PNP';
      return `Q${comp.id} ${nn[0]} ${nn[1]} ${nn[2]} QMOD_${comp.id}\n.MODEL QMOD_${comp.id} ${model}(IS=${comp.params.isE} BF=${comp.params.beta})`;
    },
    kicad: {
      lib: 'Transistor_BJT',
      symbol: polarity > 0 ? 'Q_NPN_CBE' : 'Q_PNP_CBE',
      footprint: 'Package_TO_SOT_THT:TO-92_Inline',
    },
  };
}

function makeBjtEntries() {
  return {
    npn: makeBjt(1, 'NPN Transistor', 'Q', {}),
    pnp: makeBjt(-1, 'PNP Transistor', 'Q', { isE: 8e-15, isC: 8e-14 }),
  };
}

// ---------------------------------------------------------------------------
// MOSFET (nmos/pmos) — quadratic (square-law) model, shared by both polarities
// ---------------------------------------------------------------------------

function makeMosfet(polarity, label, prefix, params) {
  return {
    label, prefix, terminals: 3,
    defaultParams: { vth: 2.1, kp: 0.5, ...params },
    defaultRatings: { maxCurrent: 0.2, maxPower: 0.4, maxVgs: 20 },
    paramSchema: [
      { key: 'vth', label: 'Threshold |Vgs| (V)', type: 'number', min: 0.1 },
      { key: 'kp', label: 'Transconductance kp (A/V²)', type: 'number', min: 1e-4 },
    ],
    _id(comp, vgs, vds) {
      const vth = comp.params.vth, kp = comp.params.kp;
      if (vgs <= vth) return 0;
      const vov = vgs - vth;
      let id;
      if (vds < vov) id = kp * (vov * vds - vds * vds / 2); // triode
      else id = 0.5 * kp * vov * vov; // saturation
      return Math.max(id, 0);
    },
    // id AND its derivative w.r.t. vds at the same operating point, so the
    // drain-source branch can be stamped as a companion model (like a diode)
    // instead of a bare floating current source — needed for Newton to
    // converge instead of diverging on the unconstrained D-S loop.
    _idAndGds(comp, vgs, vds) {
      const vth = comp.params.vth, kp = comp.params.kp;
      if (vgs <= vth) return { id: 0, gds: 1e-9 };
      const vov = vgs - vth;
      if (vds < vov) {
        const id = kp * (vov * vds - vds * vds / 2);
        const gds = Math.max(kp * (vov - vds), 1e-9);
        return { id: Math.max(id, 0), gds };
      }
      const id = 0.5 * kp * vov * vov;
      const gds = Math.max(kp * vov * 0.02, 1e-9); // channel-length modulation, lambda~0.02
      return { id, gds };
    },
    stamp(comp, ctx) {
      const [d, g, sN] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'short') { stampResistor(ctx, d, sN, 1 / FAIL_SHORT_G); return; }
      const vgs = polarity * (ctx.vNode(g) - ctx.vNode(sN));
      const vds = polarity * (ctx.vNode(d) - ctx.vNode(sN));
      const { id, gds } = this._idAndGds(comp, vgs, vds);
      const dP = polarity > 0 ? d : sN, dN = polarity > 0 ? sN : d;
      const K = id - gds * vds;
      stampCompanion(ctx, dP, dN, gds, K);
    },
    computeState(comp, ctx) {
      const [d, g, sN] = comp.nodes;
      const s = comp.state;
      const vgsRaw = ctx.vNode(g) - ctx.vNode(sN);
      const vdsRaw = ctx.vNode(d) - ctx.vNode(sN);
      s.vgs = vgsRaw;
      s.v = vdsRaw;
      if (s.failed === 'short') {
        s.i = vdsRaw / (1 / FAIL_SHORT_G);
        s.p = Math.abs(s.v * s.i);
        return;
      }
      const vgs = polarity * vgsRaw;
      const vds = polarity * vdsRaw;
      const id = this._id(comp, vgs, vds);
      s.i = polarity * id;
      s.p = Math.abs(vdsRaw * s.i);
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) return;
      const maxVgs = comp.ratings.maxVgs;
      if (Math.abs(s.vgs) > maxVgs) {
        markFailed(s, 'short', `${comp.id} gate oxide punch-through: |Vgs| ${Math.abs(s.vgs).toFixed(1)}V exceeded ${maxVgs}V max`);
        return;
      }
      const maxI = comp.ratings.maxCurrent, maxP = comp.ratings.maxPower;
      const ratio = Math.max(Math.abs(s.i) / maxI, Math.abs(s.p) / maxP);
      if (ratio > 1) {
        s.temp = (s.temp || 0) + dt * (ratio - 1) / 0.8;
      } else {
        s.temp = Math.max((s.temp || 0) - dt * 0.25, 0);
      }
      if (s.temp >= 1) {
        markFailed(s, 'short', `${comp.id} burned out: ${(Math.abs(s.p) * 1000).toFixed(0)} mW > ${(maxP * 1000).toFixed(0)} mW max`);
      }
    },
    spice(comp, nn) {
      const model = polarity > 0 ? 'NMOS' : 'PMOS';
      return `M${comp.id} ${nn[0]} ${nn[1]} ${nn[2]} ${nn[2]} MMOD_${comp.id}\n.MODEL MMOD_${comp.id} ${model}(VTO=${polarity * comp.params.vth} KP=${comp.params.kp})`;
    },
    kicad: {
      lib: 'Transistor_FET',
      symbol: polarity > 0 ? 'Q_NMOS_DGS' : 'Q_PMOS_DGS',
      footprint: 'Package_TO_SOT_THT:TO-92_Inline',
    },
  };
}

function makeMosfetEntries() {
  return {
    nmos: makeMosfet(1, 'N-MOSFET', 'M', {}),
    pmos: makeMosfet(-1, 'P-MOSFET', 'M', { kp: 0.3 }),
  };
}

// ---------------------------------------------------------------------------
// ComponentRegistry
// ---------------------------------------------------------------------------

export const ComponentRegistry = {

  // -------------------------------------------------------------- battery
  battery: {
    label: 'Battery', prefix: 'B', terminals: 2,
    defaultParams: { voltage: 9, internalResistance: 0.5 },
    defaultRatings: { maxCurrent: 5 },
    paramSchema: [
      { key: 'voltage', label: 'Voltage (V)', type: 'number', min: 0 },
      { key: 'internalResistance', label: 'Internal R (Ω)', type: 'number', min: 0 },
    ],
    numBranches: 1,
    stamp(comp, ctx) {
      const [p, n] = comp.nodes;
      const branch = ctx.branchIndex(comp.id, 0);
      const s = comp.state;
      if (s.failed === 'open') {
        stampResistor(ctx, p, n, 1 / FAIL_OPEN_G);
        return;
      }
      const rint = Math.max(comp.params.internalResistance, 1e-6);
      if (s.failed === 'short') {
        stampResistor(ctx, p, n, rint); // battery itself still has some internal R even shorted
        return;
      }
      ctx.stampVsrc(branch, p, n, comp.params.voltage);
      ctx.stampBranchSelf(branch, -rint);
    },
    computeState(comp, ctx) {
      const [p, n] = comp.nodes;
      const v = ctx.vNode(p) - ctx.vNode(n);
      const i = comp.state.failed ? v / (1 / FAIL_OPEN_G) : ctx.branchCurrent(comp.id, 0);
      comp.state.v = v;
      comp.state.i = i;
      comp.state.p = v * i;
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      const maxI = comp.ratings.maxCurrent;
      const overload = Math.abs(s.i) / maxI;
      if (overload > 1) {
        s.temp = clamp((s.temp || 0) + dt * (overload - 1) / 2, 0, 2);
      } else {
        s.temp = clamp((s.temp || 0) - dt * 0.3, 0, 2);
      }
      s.charge = clamp(1 - (s.temp || 0) * 0.05, 0, 1);
    },
    spice(comp, nn) { return `V${comp.id} ${nn[0]} ${nn[1]} DC ${comp.params.voltage}`; },
    kicad: { lib: 'Device', symbol: 'Battery_Cell', footprint: 'Battery:BatteryHolder_Keystone_2460_1x18650' },
  },

  // ------------------------------------------------------------- resistor
  resistor: {
    label: 'Resistor', prefix: 'R', terminals: 2,
    defaultParams: { resistance: 220 },
    defaultRatings: { maxPower: 0.25 },
    paramSchema: [
      { key: 'resistance', label: 'Resistance (Ω)', type: 'number', min: 0.01 },
    ],
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'open') { stampResistor(ctx, a, b, 1 / FAIL_OPEN_G); return; }
      if (s.failed === 'short') { stampResistor(ctx, a, b, 1 / FAIL_SHORT_G); return; }
      stampResistor(ctx, a, b, comp.params.resistance);
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const v = ctx.vNode(a) - ctx.vNode(b);
      const r = comp.state.failed === 'open' ? 1 / FAIL_OPEN_G
        : comp.state.failed === 'short' ? 1 / FAIL_SHORT_G
        : comp.params.resistance;
      const i = v / Math.max(r, 1e-9);
      comp.state.v = v; comp.state.i = i; comp.state.p = v * i;
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) return;
      const ratio = Math.abs(s.p) / comp.ratings.maxPower;
      const TAU_FAIL = 4.5; // calibrated so 4x-rated dissipation fails in ~1.5s
      if (ratio > 1) {
        s.temp = (s.temp || 0) + dt * (ratio - 1) / TAU_FAIL;
      } else {
        s.temp = Math.max((s.temp || 0) - dt * 0.2, 0);
      }
      if (s.temp >= 1) {
        markFailed(s, 'open', `R${comp.id.replace(/\D/g, '')} burned open: ${(Math.abs(s.p)).toFixed(2)}W > ${comp.ratings.maxPower}W rated`);
      }
    },
    spice(comp, nn) { return `R${comp.id} ${nn[0]} ${nn[1]} ${comp.params.resistance}`; },
    kicad: { lib: 'Device', symbol: 'R', footprint: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal' },
  },

  // ------------------------------------------------------------------ led
  led: {
    label: 'LED', prefix: 'D', terminals: 2,
    defaultParams: { color: 'red', vf: 2.0, rs: 2, is: 1e-20, n: 2.0 },
    defaultRatings: { maxCurrent: 0.03, surgeCurrent: 0.1 },
    paramSchema: [
      { key: 'color', label: 'Color', type: 'select', options: ['red', 'green', 'blue', 'yellow', 'white'] },
      { key: 'vf', label: 'Forward Voltage (V)', type: 'number', min: 0.5 },
      { key: 'rs', label: 'Series R (Ω)', type: 'number', min: 0 },
    ],
    numExtraNodes(comp) { return comp.params.rs > 0 ? 1 : 0; },
    _isFor(comp) {
      // derive Is such that at ratedCurrent the diode drop ≈ vf (n≈2 default)
      if (comp.params.is) return comp.params.is;
      return 1e-20;
    },
    _nVt(comp) { return (comp.params.n || 2.0) * 0.02585; },
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'open') { stampResistor(ctx, a, b, 1 / FAIL_OPEN_G); return; }
      if (s.failed === 'short') { stampResistor(ctx, a, b, 1 / FAIL_SHORT_G); return; }
      const is = this._isFor(comp);
      const nVt = this._nVt(comp);
      const rs = comp.params.rs || 0;
      let jNode = b;
      if (rs > 0) {
        const j = ctx.internalNode(comp.id, 0);
        stampResistor(ctx, a, j, rs);
        jNode = j;
        const Vraw = ctx.vNode(j) - ctx.vNode(b);
        const { g, K } = diodeCompanion(s, 'd0', is, nVt, Vraw);
        stampCompanion(ctx, j, b, g, K);
      } else {
        const Vraw = ctx.vNode(a) - ctx.vNode(b);
        const { g, K } = diodeCompanion(s, 'd0', is, nVt, Vraw);
        stampCompanion(ctx, a, b, g, K);
      }
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      const v = ctx.vNode(a) - ctx.vNode(b);
      let i;
      if (s.failed === 'open') i = v / (1 / FAIL_OPEN_G);
      else if (s.failed === 'short') i = v / (1 / FAIL_SHORT_G);
      else {
        const rs = comp.params.rs || 0;
        if (rs > 0) {
          const j = ctx.internalNode(comp.id, 0);
          const vj = ctx.vNode(j);
          i = diodeCurrentAt(this._isFor(comp), this._nVt(comp), vj - ctx.vNode(b));
        } else {
          i = diodeCurrentAt(this._isFor(comp), this._nVt(comp), v);
        }
      }
      s.v = v; s.i = i; s.p = v * i;
      const rated = comp.ratings.maxCurrent;
      s.brightness = s.failed ? 0 : clamp(i / rated, 0, 1.2);
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) return;
      const i = s.i;
      const surge = comp.ratings.surgeCurrent;
      const maxI = comp.ratings.maxCurrent;
      // reverse breakdown
      if (s.v < -5) {
        markFailed(s, 'open', `LED fused: reverse voltage ${s.v.toFixed(2)}V exceeded 5V limit`);
        return;
      }
      if (i > surge) {
        s.temp = (s.temp || 0) + dt / 0.003; // fails within a few ms
      } else if (i > maxI) {
        s.temp = (s.temp || 0) + dt * (i / maxI - 1) / 1.0;
      } else {
        s.temp = Math.max((s.temp || 0) - dt * 0.5, 0);
      }
      if (s.temp >= 1) {
        markFailed(s, 'open', `LED fused: ${(i * 1000).toFixed(0)} mA > ${(maxI * 1000).toFixed(0)} mA max`);
      }
    },
    spice(comp, nn) { return `D${comp.id} ${nn[0]} ${nn[1]} LED_${comp.params.color}`; },
    kicad: { lib: 'Device', symbol: 'LED', footprint: 'LED_THT:LED_D5.0mm' },
  },

  // ---------------------------------------------------------------- diode
  diode: {
    label: 'Diode', prefix: 'D', terminals: 2,
    defaultParams: { is: 1e-14, n: 1.8, rs: 0 },
    defaultRatings: { maxCurrent: 1, maxReverseV: 100 },
    paramSchema: [
      { key: 'is', label: 'Saturation Current (A)', type: 'number', min: 1e-18 },
      { key: 'n', label: 'Ideality Factor', type: 'number', min: 1 },
    ],
    _nVt(comp) { return (comp.params.n || 1.8) * 0.02585; },
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'open') { stampResistor(ctx, a, b, 1 / FAIL_OPEN_G); return; }
      if (s.failed === 'short') { stampResistor(ctx, a, b, 1 / FAIL_SHORT_G); return; }
      const is = comp.params.is;
      const nVt = this._nVt(comp);
      const Vraw = ctx.vNode(a) - ctx.vNode(b);
      const { g, K } = diodeCompanion(s, 'd0', is, nVt, Vraw);
      stampCompanion(ctx, a, b, g, K);
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      const v = ctx.vNode(a) - ctx.vNode(b);
      let i;
      if (s.failed === 'open') i = v / (1 / FAIL_OPEN_G);
      else if (s.failed === 'short') i = v / (1 / FAIL_SHORT_G);
      else i = diodeCurrentAt(comp.params.is, this._nVt(comp), v);
      s.v = v; s.i = i; s.p = v * i;
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) return;
      const maxRV = comp.ratings.maxReverseV;
      if (s.v < -maxRV) {
        // breakdown: shorts first (avalanche), then fuses open if it persists
        markFailed(s, 'short', `Diode breakdown: reverse V ${s.v.toFixed(1)} exceeded ${maxRV}V`);
        return;
      }
      const maxI = comp.ratings.maxCurrent;
      if (Math.abs(s.i) > maxI) {
        s.temp = (s.temp || 0) + dt * (Math.abs(s.i) / maxI - 1) / 1.0;
      } else {
        s.temp = Math.max((s.temp || 0) - dt * 0.3, 0);
      }
      if (s.temp >= 1) {
        markFailed(s, 'open', `Diode overcurrent: ${(s.i * 1000).toFixed(0)} mA > ${(maxI * 1000).toFixed(0)} mA max`);
      }
    },
    spice(comp, nn) { return `D${comp.id} ${nn[0]} ${nn[1]} DMOD_${comp.id}\n.MODEL DMOD_${comp.id} D(IS=${comp.params.is} N=${comp.params.n})`; },
    kicad: { lib: 'Device', symbol: 'D', footprint: 'Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal' },
  },

  // ------------------------------------------------------------ capacitor
  capacitor: {
    label: 'Capacitor', prefix: 'C', terminals: 2,
    defaultParams: { capacitance: 100e-6, polarized: true },
    defaultRatings: { maxVoltage: 16 },
    paramSchema: [
      { key: 'capacitance', label: 'Capacitance (F)', type: 'number', min: 1e-12 },
      { key: 'polarized', label: 'Polarized', type: 'boolean' },
    ],
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'open') { stampResistor(ctx, a, b, 1 / FAIL_OPEN_G); return; }
      if (s.failed === 'short') { stampResistor(ctx, a, b, 1 / FAIL_SHORT_G); return; }
      const C = comp.params.capacitance;
      const dt = Math.max(ctx.dt, 1e-9);
      const geq = C / dt;
      const vold = s._vPrev || 0;
      stampCompanion(ctx, a, b, geq, -geq * vold);
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      const v = ctx.vNode(a) - ctx.vNode(b);
      let i;
      if (s.failed === 'open') i = v / (1 / FAIL_OPEN_G);
      else if (s.failed === 'short') i = v / (1 / FAIL_SHORT_G);
      else {
        const C = comp.params.capacitance;
        const dt = Math.max(ctx.dt || 1e-9, 1e-9);
        i = C * (v - (s._vPrev || 0)) / dt;
      }
      s.v = v; s.i = i; s.p = v * i;
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (!s.failed) {
        if (comp.params.polarized && s.v < -1) {
          s.temp = (s.temp || 0) + dt / 0.05;
        } else if (s.v > comp.ratings.maxVoltage) {
          s.temp = (s.temp || 0) + dt * (s.v / comp.ratings.maxVoltage - 1) / 0.2;
        } else {
          s.temp = Math.max((s.temp || 0) - dt * 0.3, 0);
        }
        if (s.temp >= 1) {
          const reason = (comp.params.polarized && s.v < -1)
            ? `Electrolytic cap vented: reverse voltage ${s.v.toFixed(2)}V`
            : `Cap vented: ${s.v.toFixed(1)}V > ${comp.ratings.maxVoltage}V rated`;
          markFailed(s, 'short', reason);
        }
      }
      if (!s.failed) s._vPrev = s.v;
    },
    spice(comp, nn) { return `C${comp.id} ${nn[0]} ${nn[1]} ${comp.params.capacitance}`; },
    kicad: { lib: 'Device', symbol: 'C_Polarized', footprint: 'Capacitor_THT:CP_Radial_D6.3mm_P2.50mm' },
  },

  // ---------------------------------------------------------------- motor
  motor: {
    label: 'Motor', prefix: 'M', terminals: 2,
    // NOTE: default `friction` deviates from the spec table's 2e-4 N·m — see
    // report. With ke=kt=0.01 and R=3Ω, 2e-4 N·m of static friction is
    // overcome by only ~0.02A (0.06V stall), so literally any nonzero supply
    // would spin the motor, contradicting the required "must not start below
    // minimum voltage" behavior. Raised so a sub-rated voltage genuinely
    // fails to overcome friction while a rated-range voltage does.
    defaultParams: { resistance: 3, ke: 0.01, kt: 0.01, inertia: 1e-5, friction: 5e-3 },
    defaultRatings: { maxVoltage: 12, maxCurrent: 2 },
    paramSchema: [
      { key: 'resistance', label: 'Winding R (Ω)', type: 'number', min: 0.01 },
      { key: 'ke', label: 'Back-EMF const (V·s/rad)', type: 'number', min: 0 },
      { key: 'friction', label: 'Static Friction (N·m)', type: 'number', min: 0 },
    ],
    numBranches: 1,
    stamp(comp, ctx) {
      const [p, n] = comp.nodes;
      const s = comp.state;
      const branch = ctx.branchIndex(comp.id, 0);
      if (s.failed === 'open') { stampResistor(ctx, p, n, 1 / FAIL_OPEN_G); return; }
      if (s.failed === 'short') { stampResistor(ctx, p, n, 1 / FAIL_SHORT_G); return; }
      const R = Math.max(comp.params.resistance, 1e-6);
      const omega = (s.rpm || 0) * 2 * Math.PI / 60;
      const backEmf = comp.params.ke * omega * (s.spinning ? 1 : 0);
      ctx.stampVsrc(branch, p, n, backEmf);
      ctx.stampBranchSelf(branch, -R);
    },
    computeState(comp, ctx) {
      const [p, n] = comp.nodes;
      const s = comp.state;
      const v = ctx.vNode(p) - ctx.vNode(n);
      const i = s.failed ? v / (1 / FAIL_OPEN_G) : ctx.branchCurrent(comp.id, 0);
      s.v = v; s.i = i; s.p = v * i;
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) return;
      const kt = comp.params.kt;
      const friction = comp.params.friction;
      const inertia = Math.max(comp.params.inertia, 1e-9);
      const torque = kt * Math.abs(s.i);
      let omega = (s.rpm || 0) * 2 * Math.PI / 60;
      if (!s.spinning) {
        if (torque > friction) {
          s.spinning = true;
        } else {
          omega = 0;
        }
      }
      if (s.spinning) {
        const netTorque = torque - friction;
        omega = Math.max(0, omega + dt * netTorque / inertia);
        if (omega <= 1e-6 && netTorque <= 0) { omega = 0; s.spinning = false; }
      }
      s.rpm = omega * 60 / (2 * Math.PI);

      // thermal: sustained stall / overcurrent overheats the winding
      const maxI = comp.ratings.maxCurrent;
      if (Math.abs(s.i) > maxI) {
        s.temp = (s.temp || 0) + dt * (Math.abs(s.i) / maxI - 1) / 1.5;
      } else {
        s.temp = Math.max((s.temp || 0) - dt * 0.2, 0);
      }
      if (s.temp >= 1) {
        markFailed(s, 'open', `Motor winding burned open: stalled at ${(s.i).toFixed(2)}A > ${maxI}A rated`);
        s.spinning = false; s.rpm = 0;
      }
    },
    spice(comp, nn) { return `* motor M${comp.id} modeled as R+back-EMF, not natively representable in SPICE\nR${comp.id} ${nn[0]} ${nn[1]} ${comp.params.resistance}`; },
    kicad: { lib: 'Motor', symbol: 'Motor_DC', footprint: 'Motor:Motor_DC_Generic_THT' },
  },

  // ----------------------------------------------------------------- bulb
  bulb: {
    label: 'Bulb', prefix: 'L', terminals: 2,
    defaultParams: { ratedVoltage: 6, ratedPower: 1 },
    defaultRatings: {},
    paramSchema: [
      { key: 'ratedVoltage', label: 'Rated Voltage (V)', type: 'number', min: 0.1 },
      { key: 'ratedPower', label: 'Rated Power (W)', type: 'number', min: 0.01 },
    ],
    _rHot(comp) { return (comp.params.ratedVoltage ** 2) / comp.params.ratedPower; },
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'open') { stampResistor(ctx, a, b, 1 / FAIL_OPEN_G); return; }
      if (s.failed === 'short') { stampResistor(ctx, a, b, 1 / FAIL_SHORT_G); return; }
      const rHot = this._rHot(comp);
      const rCold = rHot / 10;
      const ft = clamp(s.filamentTemp || 0, 0, 1.5);
      const r = rCold + (rHot - rCold) * (ft / (1 + ft)); // saturating toward rHot
      stampResistor(ctx, a, b, Math.max(r, rCold));
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      const v = ctx.vNode(a) - ctx.vNode(b);
      const rHot = this._rHot(comp);
      const rCold = rHot / 10;
      const ft = clamp(s.filamentTemp || 0, 0, 1.5);
      const r = s.failed === 'open' ? 1 / FAIL_OPEN_G
        : s.failed === 'short' ? 1 / FAIL_SHORT_G
        : Math.max(rCold + (rHot - rCold) * (ft / (1 + ft)), rCold);
      const i = v / r;
      s.v = v; s.i = i; s.p = v * i;
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) { s.brightness = 0; return; }
      const target = s.p / comp.params.ratedPower;
      const tau = 0.08; // fast filament thermal response
      s.filamentTemp = (s.filamentTemp || 0) + dt * (target - (s.filamentTemp || 0)) / tau;
      s.filamentTemp = clamp(s.filamentTemp, 0, 1.5);
      s.brightness = clamp(s.filamentTemp ** 2, 0, 1.2);

      const overV = Math.abs(s.v) / comp.params.ratedVoltage;
      if (overV > 1.3) {
        s.temp = (s.temp || 0) + dt * (overV - 1.3) / 0.3;
      } else {
        s.temp = Math.max((s.temp || 0) - dt * 0.2, 0);
      }
      if (s.temp >= 1) {
        markFailed(s, 'open', `Bulb filament burned open: ${Math.abs(s.v).toFixed(1)}V > ${(1.3 * comp.params.ratedVoltage).toFixed(1)}V sustained`);
        s.brightness = 0;
      }
    },
    spice(comp, nn) { return `R${comp.id} ${nn[0]} ${nn[1]} ${this._rHot(comp).toFixed(2)}`; },
    kicad: { lib: 'Device', symbol: 'Lamp', footprint: 'LED_THT:LED_D10.0mm' },
  },

  // ----------------------------------------------------------------- fuse
  fuse: {
    label: 'Fuse', prefix: 'F', terminals: 2,
    defaultParams: { ratedCurrent: 1 },
    defaultRatings: {},
    paramSchema: [
      { key: 'ratedCurrent', label: 'Rated Current (A)', type: 'number', min: 0.001 },
    ],
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'open') { stampResistor(ctx, a, b, 1 / FAIL_OPEN_G); return; }
      stampResistor(ctx, a, b, 0.02); // small realistic fuse resistance
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      const v = ctx.vNode(a) - ctx.vNode(b);
      const r = s.failed === 'open' ? 1 / FAIL_OPEN_G : 0.02;
      const i = v / r;
      s.v = v; s.i = i; s.p = v * i;
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) return;
      const rated = comp.params.ratedCurrent;
      const iAbs = Math.abs(s.i);
      if (iAbs > rated) {
        s.i2t = (s.i2t || 0) + (iAbs * iAbs - rated * rated) * dt;
      } else {
        s.i2t = Math.max((s.i2t || 0) - rated * rated * dt * 0.5, 0);
      }
      const threshold = rated * rated * 1.2; // calibrated for sub-second-to-few-second blow at moderate overload
      if (s.i2t >= threshold) {
        markFailed(s, 'open', `Fuse blown: ${iAbs.toFixed(2)}A exceeded ${rated}A rating (I²t)`);
      }
    },
    spice(comp, nn) { return `R${comp.id} ${nn[0]} ${nn[1]} 0.02`; },
    kicad: { lib: 'Device', symbol: 'Fuse', footprint: 'Fuse:Fuse_THT_5x20mm_Horizontal' },
  },

  // --------------------------------------------------------------- switch
  switch: {
    label: 'Switch', prefix: 'S', terminals: 2,
    defaultParams: { closed: false },
    defaultRatings: { maxCurrent: 10 },
    paramSchema: [
      { key: 'closed', label: 'Closed', type: 'boolean' },
    ],
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      const r = comp.params.closed ? 1e-3 : 1e9;
      stampResistor(ctx, a, b, r);
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const v = ctx.vNode(a) - ctx.vNode(b);
      const r = comp.params.closed ? 1e-3 : 1e9;
      const i = v / r;
      comp.state.v = v; comp.state.i = i; comp.state.p = v * i;
    },
    postStep(comp) { clearJustFailed(comp.state); },
    spice(comp, nn) { return `R${comp.id} ${nn[0]} ${nn[1]} ${comp.params.closed ? '0.001' : '1e9'}`; },
    kicad: { lib: 'Device', symbol: 'SW_SPST', footprint: 'Button_Switch_THT:SW_SPST_B3F-1000' },
  },

  // ---------------------------------------------------------- potentiometer
  potentiometer: {
    label: 'Potentiometer', prefix: 'P', terminals: 3,
    defaultParams: { resistance: 10e3, wiper: 0.5 },
    defaultRatings: { maxPower: 0.1 },
    paramSchema: [
      { key: 'resistance', label: 'Total Resistance (Ω)', type: 'number', min: 1 },
      { key: 'wiper', label: 'Wiper Position', type: 'number', min: 0, max: 1 },
    ],
    stamp(comp, ctx) {
      const [nA, nB, nW] = comp.nodes;
      const w = clamp(comp.params.wiper, 0, 1);
      const R = comp.params.resistance;
      const r1 = Math.max(R * w, 1);
      const r2 = Math.max(R * (1 - w), 1);
      stampResistor(ctx, nA, nW, r1);
      stampResistor(ctx, nW, nB, r2);
    },
    computeState(comp, ctx) {
      const [nA, nB, nW] = comp.nodes;
      const vA = ctx.vNode(nA), vB = ctx.vNode(nB), vW = ctx.vNode(nW);
      const w = clamp(comp.params.wiper, 0, 1);
      const R = comp.params.resistance;
      const r1 = Math.max(R * w, 1);
      const i1 = (vA - vW) / r1;
      comp.state.v = vA - vB;
      comp.state.i = i1;
      comp.state.p = Math.abs((vA - vW) * i1) + Math.abs((vW - vB) * ((vW - vB) / Math.max(R * (1 - w), 1)));
    },
    postStep(comp) { clearJustFailed(comp.state); },
    spice(comp, nn) { return `R${comp.id}a ${nn[0]} ${nn[2]} ${(comp.params.resistance * comp.params.wiper).toFixed(1)}\nR${comp.id}b ${nn[2]} ${nn[1]} ${(comp.params.resistance * (1 - comp.params.wiper)).toFixed(1)}`; },
    kicad: { lib: 'Device', symbol: 'R_Potentiometer', footprint: 'Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical' },
  },

  // ---------------------------------------------------------------- ground
  ground: {
    label: 'Ground', prefix: 'GND', terminals: 1,
    defaultParams: {}, defaultRatings: {}, paramSchema: [],
    stamp() {},
    computeState(comp, ctx) {
      comp.state.v = 0; comp.state.i = 0; comp.state.p = 0;
    },
    postStep(comp) { clearJustFailed(comp.state); },
    spice() { return `* ground`; },
    kicad: { lib: 'power', symbol: 'GND', footprint: '' },
  },

  // -------------------------------------------------------------- voltmeter
  voltmeter: {
    label: 'Voltmeter', prefix: 'VM', terminals: 2,
    defaultParams: {}, defaultRatings: {},
    paramSchema: [],
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      stampResistor(ctx, a, b, 10e6);
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const v = ctx.vNode(a) - ctx.vNode(b);
      const i = v / 10e6;
      comp.state.v = v; comp.state.i = i; comp.state.p = v * i;
    },
    postStep(comp) { clearJustFailed(comp.state); },
    spice(comp, nn) { return `R${comp.id} ${nn[0]} ${nn[1]} 10E6`; },
    kicad: { lib: 'Device', symbol: 'R', footprint: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal' },
  },

  // --------------------------------------------------------------- ammeter
  ammeter: {
    label: 'Ammeter', prefix: 'AM', terminals: 2,
    defaultParams: {}, defaultRatings: {},
    paramSchema: [],
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      stampResistor(ctx, a, b, 0.01);
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const v = ctx.vNode(a) - ctx.vNode(b);
      const i = v / 0.01;
      comp.state.v = v; comp.state.i = i; comp.state.p = v * i;
    },
    postStep(comp) { clearJustFailed(comp.state); },
    spice(comp, nn) { return `R${comp.id} ${nn[0]} ${nn[1]} 0.01`; },
    kicad: { lib: 'Device', symbol: 'R', footprint: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal' },
  },

  // ------------------------------------------------------------------ npn/pnp
  // Simplified Ebers-Moll BJT: two diode junctions (BE, BC) stamped exactly
  // like the LED/diode companion model (reusing diodeCompanion/diodeCurrentAt
  // so convergence relies on the same pnjlim machinery), plus a
  // beta-controlled collector current recomputed fresh from the latest Newton
  // iterate each stamp() call (same "fixed point per iteration" idiom the
  // motor uses for its back-EMF term). `polarity` (+1 npn / -1 pnp) picks
  // which physical terminal plays the "anode" role of each junction so both
  // types share one implementation.
  ...makeBjtEntries(),

  // ------------------------------------------------------------- nmos/pmos
  // Quadratic (square-law) MOSFET: Id = 0 below Vth, triode/saturation above,
  // stamped as a controlled current source (same per-iteration idiom as the
  // BJT above) plus a small stabilizing drain-source conductance.
  ...makeMosfetEntries(),

  // -------------------------------------------------------------- zener
  zener: {
    label: 'Zener Diode', prefix: 'DZ', terminals: 2,
    defaultParams: { vz: 5.1, is: 1e-14, n: 1.8, isZ: 1e-9, nz: 0.5 },
    defaultRatings: { maxPower: 0.5 },
    paramSchema: [
      { key: 'vz', label: 'Zener Voltage (V)', type: 'number', min: 0.1 },
      { key: 'is', label: 'Forward Saturation Current (A)', type: 'number', min: 1e-18 },
    ],
    stamp(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      if (s.failed === 'open') { stampResistor(ctx, a, b, 1 / FAIL_OPEN_G); return; }
      if (s.failed === 'short') { stampResistor(ctx, a, b, 1 / FAIL_SHORT_G); return; }
      const nVt = (comp.params.n || 1.8) * 0.02585;
      const nVtZ = (comp.params.nz || 0.5) * 0.02585;
      const Vf = ctx.vNode(a) - ctx.vNode(b);
      const { g: gF, K: KF } = diodeCompanion(s, 'zf', comp.params.is, nVt, Vf);
      stampCompanion(ctx, a, b, gF, KF);
      // reverse breakdown path: conducts b->a once |Vf| exceeds vz (reverse).
      // Vr = (Vb-Va) - vz is a SHIFTED variable (offset by the zener voltage)
      // fed into diodeCompanion purely so its exponential/pnjlim math sees a
      // "starts conducting at 0" junction; diodeCompanion's own K is linear
      // in Vr, but stampCompanion(ctx,b,a,g,K) encodes i=g*(Vb-Va)+K against
      // the RAW node difference, not Vr — so K must be re-based off Vr's
      // offset (-vz) or the stamped current is off by a spurious g*vz term.
      const Vr = -Vf - comp.params.vz;
      const { g: gR, K: KRraw } = diodeCompanion(s, 'zr', comp.params.isZ, nVtZ, Vr);
      const KR = KRraw - gR * comp.params.vz;
      stampCompanion(ctx, b, a, gR, KR);
      // Stash the companion-linearized currents for computeState to reuse —
      // see the BJT's identical comment: recomputing a bare exponential from
      // the raw final node voltage can overflow if the outer Newton loop
      // settled while the junction's own (tiny, at low current) conductance
      // hadn't yet dominated the node-voltage convergence check.
      s._iFLast = gF * (ctx.vNode(a) - ctx.vNode(b)) + KF;
      s._iRLast = gR * (ctx.vNode(b) - ctx.vNode(a)) + KR;
    },
    computeState(comp, ctx) {
      const [a, b] = comp.nodes;
      const s = comp.state;
      const v = ctx.vNode(a) - ctx.vNode(b);
      let i;
      if (s.failed === 'open') i = v / (1 / FAIL_OPEN_G);
      else if (s.failed === 'short') i = v / (1 / FAIL_SHORT_G);
      else {
        i = (s._iFLast || 0) - (s._iRLast || 0);
      }
      s.v = v; s.i = i; s.p = v * i;
    },
    postStep(comp, dt) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) return;
      const maxP = comp.ratings.maxPower;
      const ratio = Math.abs(s.p) / maxP;
      if (ratio > 1) {
        s.temp = (s.temp || 0) + dt * (ratio - 1) / 0.6;
      } else {
        s.temp = Math.max((s.temp || 0) - dt * 0.3, 0);
      }
      if (s.temp >= 1) {
        markFailed(s, 'open', `${comp.id} shorted then blew open: ${(Math.abs(s.p) * 1000).toFixed(0)} mW > ${(maxP * 1000).toFixed(0)} mW rated`);
      }
    },
    spice(comp, nn) { return `D${comp.id} ${nn[0]} ${nn[1]} ZMOD_${comp.id}\n.MODEL ZMOD_${comp.id} D(IS=${comp.params.is} BV=${comp.params.vz} IBV=1e-3)`; },
    kicad: { lib: 'Device', symbol: 'D_Zener', footprint: 'Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal' },
  },

  // --------------------------------------------------------------- esp32
  // Behavioral dev-board model (does NOT run firmware). 6 pins: VIN, GND,
  // 3V3, GPIO2, GPIO4, GPIO5. Powered via VIN 4.5-12V (onboard regulator
  // drives 3V3 through a low series resistance) OR by feeding 3V3 directly
  // (3.0-3.6V). Each GPIO is a Thevenin-style driver (3.3V/0V through ~40R)
  // in 'high'/'low'/'blink', or a 10M input in 'input' mode / when unpowered
  // (brownout). Overcurrent fuses that pin open; overvoltage/undervoltage on
  // any GPIO or overvoltage on VIN kills the whole board (failed='open').
  esp32: {
    label: 'ESP32 Dev Board', prefix: 'U', terminals: 6,
    defaultParams: {
      gpio2Mode: 'low', gpio4Mode: 'low', gpio5Mode: 'input',
      sketch: '', sketchEnabled: false,
    },
    defaultRatings: { gpioMaxCurrent: 0.04, gpioAbsMaxV: 3.6, gpioAbsMinV: -0.3, vinMax: 12 },
    paramSchema: [
      { key: 'gpio2Mode', label: 'GPIO2 Mode', type: 'select', options: ['high', 'low', 'blink', 'input'] },
      { key: 'gpio4Mode', label: 'GPIO4 Mode', type: 'select', options: ['high', 'low', 'blink', 'input'] },
      { key: 'gpio5Mode', label: 'GPIO5 Mode', type: 'select', options: ['high', 'low', 'blink', 'input'] },
    ],
    _gpioOut(mode, t) {
      if (mode === 'high') return 3.3;
      if (mode === 'low') return 0;
      if (mode === 'blink') return (((t || 0) % 1) < 0.5) ? 3.3 : 0;
      return null; // input mode: not driven
    },
    // Effective mode for a pin, folding in a running sketch's pinMode() calls.
    // Pins the sketch hasn't touched (never pinMode'd) fall back to the
    // manual per-pin param, exactly like when no sketch is running at all.
    _effectiveMode(comp, name) {
      const s = comp.state;
      if (comp.params.sketchEnabled && s.sketchPins && s.sketchPins[Number(name.replace('GPIO', ''))]) {
        const p = s.sketchPins[Number(name.replace('GPIO', ''))];
        return p.mode === 'input' ? 'input' : 'sketch';
      }
      const modes = { GPIO2: comp.params.gpio2Mode, GPIO4: comp.params.gpio4Mode, GPIO5: comp.params.gpio5Mode };
      return modes[name];
    },
    _target(comp, name, mode, t) {
      if (mode === 'sketch') {
        const p = comp.state.sketchPins[Number(name.replace('GPIO', ''))];
        return p.value ? 3.3 : 0;
      }
      return this._gpioOut(mode, t);
    },
    stamp(comp, ctx) {
      const [vin, gnd, v3v3, g2, g4, g5] = comp.nodes;
      const s = comp.state;
      if (s.failed) return; // dead board: everything floats (global gmin only)
      const pins = { GPIO2: g2, GPIO4: g4, GPIO5: g5 };
      const vVin = ctx.vNode(vin) - ctx.vNode(gnd);
      const vV3 = ctx.vNode(v3v3) - ctx.vNode(gnd);
      const vinOk = vVin >= 4.5 && vVin <= 12;
      const v3Ok = vV3 >= 3.0 && vV3 <= 3.6;
      const powered = vinOk || v3Ok;
      if (vinOk) {
        // onboard regulator: drives the 3V3 rail from VIN through ~5 ohm.
        stampCompanion(ctx, v3v3, gnd, 1 / 5, -(1 / 5) * 3.3);
      }
      for (const name of Object.keys(pins)) {
        const pin = pins[name];
        if (s.pinFailed && s.pinFailed[name]) { stampResistor(ctx, pin, gnd, 1 / FAIL_OPEN_G); continue; }
        const mode = this._effectiveMode(comp, name);
        if (!powered || mode === 'input') { stampResistor(ctx, pin, gnd, 10e6); continue; }
        const target = this._target(comp, name, mode, ctx.time);
        stampCompanion(ctx, pin, gnd, 1 / 40, -(1 / 40) * target);
      }
    },
    computeState(comp, ctx) {
      const [vin, gnd, v3v3, g2, g4, g5] = comp.nodes;
      const s = comp.state;
      const vVin = ctx.vNode(vin) - ctx.vNode(gnd);
      const vV3 = ctx.vNode(v3v3) - ctx.vNode(gnd);
      s.vin = vVin;
      s.v = vV3;
      s.i = 0;
      s.p = 0;
      if (s.failed) {
        s.brownout = true;
        s.gpio = { GPIO2: 0, GPIO4: 0, GPIO5: 0 };
        s.status = `DEAD — ${s.failureMsg || 'failed'}`;
        return;
      }
      const pins = { GPIO2: g2, GPIO4: g4, GPIO5: g5 };
      const vinOk = vVin >= 4.5 && vVin <= 12;
      const v3Ok = vV3 >= 3.0 && vV3 <= 3.6;
      const powered = vinOk || v3Ok;
      s.brownout = !powered;
      if (!s.pinFailed) s.pinFailed = { GPIO2: false, GPIO4: false, GPIO5: false };
      s.gpio = {};
      s.pinCurrent = {};
      for (const name of Object.keys(pins)) {
        const pin = pins[name];
        const vPin = ctx.vNode(pin) - ctx.vNode(gnd);
        s.gpio[name] = vPin;
        if (s.pinFailed[name]) { s.pinCurrent[name] = 0; continue; }
        const mode = this._effectiveMode(comp, name);
        let iPin;
        if (!powered || mode === 'input') iPin = vPin / 10e6;
        else {
          const target = this._target(comp, name, mode, ctx.time);
          iPin = (target - vPin) / 40;
        }
        s.pinCurrent[name] = iPin;
      }
      s.status = s.brownout ? 'Brownout (unpowered)' : `Powered — 3V3=${vV3.toFixed(2)}V`;
    },
    postStep(comp, dt, ctx) {
      const s = comp.state;
      clearJustFailed(s);
      if (s.failed) { this._tickSketch(comp, (ctx ? ctx.time : 0) + (dt || 0)); return; }
      if (!s.pinFailed) s.pinFailed = { GPIO2: false, GPIO4: false, GPIO5: false };
      const gpio = s.gpio || {};
      const pinCurrent = s.pinCurrent || {};
      for (const name of ['GPIO2', 'GPIO4', 'GPIO5']) {
        if (s.pinFailed[name]) continue;
        const vPin = gpio[name];
        if (vPin === undefined) continue;
        if (vPin > comp.ratings.gpioAbsMaxV || vPin < comp.ratings.gpioAbsMinV) {
          markFailed(s, 'open', `ESP32 killed: ${vPin.toFixed(1)} V on ${name} exceeds ${comp.ratings.gpioAbsMaxV} V abs max`);
          this._tickSketch(comp, (ctx ? ctx.time : 0) + (dt || 0));
          return;
        }
        const iPin = pinCurrent[name];
        if (iPin !== undefined && Math.abs(iPin) > comp.ratings.gpioMaxCurrent) {
          s.pinFailed[name] = true;
          s.justFailed = true;
          s.failureMsg = `${comp.id} ${name} bond wire fused: ${(Math.abs(iPin) * 1000).toFixed(0)} mA > ${(comp.ratings.gpioMaxCurrent * 1000).toFixed(0)} mA abs max`;
        }
      }
      if (s.vin !== undefined && s.vin > comp.ratings.vinMax) {
        markFailed(s, 'open', `ESP32 regulator dead: VIN ${s.vin.toFixed(1)}V exceeded ${comp.ratings.vinMax}V max`);
      }
      const now = (ctx ? ctx.time : 0) + (dt || 0);
      this._tickSketch(comp, now);
    },
    // Runs the sketch (if enabled) for the current step, using the pin
    // voltages computeState() just wrote into s.gpio for digitalRead()/
    // analogRead(). Overrides s.sketchPins (consulted by _effectiveMode/
    // _target above on the NEXT step's stamp()) with the sketch's pinMode()/
    // digitalWrite() output. Losing power (brownout) or the board failing
    // resets the runtime — setup() runs again once power returns, like a
    // real reboot.
    _tickSketch(comp, now) {
      const s = comp.state;
      if (!comp.params.sketchEnabled || !comp.params.sketch) {
        s._sketch = null;
        s._sketchPoweredPrev = false;
        s.sketchPins = null;
        s.sketchStatus = null;
        s.sketchLog = null;
        s.sketchLogTimes = null;
        s.sketchErrorLine = null;
        return;
      }
      if (!s._sketch || s._sketch.source !== comp.params.sketch) {
        s._sketch = new SketchRuntime(comp.params.sketch);
        s._sketchPoweredPrev = false;
      }
      const rt = s._sketch;
      const poweredNow = !s.failed && !s.brownout;
      if (!poweredNow) {
        if (s._sketchPoweredPrev) rt.reset();
        s._sketchPoweredPrev = false;
        s.sketchPins = null;
        s.sketchStatus = rt.status === 'error' ? rt.error : 'Stopped (unpowered)';
        s.sketchLog = rt.log;
        s.sketchLogTimes = rt.logTimes;
        s.sketchErrorLine = rt.errorLine;
        return;
      }
      if (!s._sketchPoweredPrev) rt.reset(); // just powered on: fresh boot
      s._sketchPoweredPrev = true;
      rt.setPinReader((pinNum) => (s.gpio ? (s.gpio[`GPIO${pinNum}`] || 0) : 0));
      rt.tick(now);
      s.sketchPins = rt.getPinState();
      s.sketchStatus = rt.status === 'error' ? rt.error : (rt.status === 'running' ? 'Running' : 'Stopped');
      s.sketchLog = rt.log;
      s.sketchLogTimes = rt.logTimes;
      s.sketchErrorLine = rt.errorLine;
    },
    spice(comp) { return `* ${comp.id} ESP32 dev board — behavioral GPIO model only, not a native SPICE primitive`; },
    kicad: { lib: 'MCU_Espressif', symbol: 'ESP32-DEVKITC-32E', footprint: 'Module:ESP32-DEVKITC' },
  },
};

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export function createComponent(type, x, y, idMapOverride) {
  const model = ComponentRegistry[type];
  if (!model) throw new Error(`Unknown component type: ${type}`);
  let id;
  if (idMapOverride && typeof idMapOverride === 'object') {
    const n = (idMapOverride[model.prefix] || 0) + 1;
    idMapOverride[model.prefix] = n;
    id = `${model.prefix}${n}`;
  } else {
    id = nextId(model.prefix);
  }
  return {
    id,
    type,
    x, y,
    rot: 0,
    params: { ...model.defaultParams },
    ratings: { ...model.defaultRatings },
    state: { v: 0, i: 0, p: 0, temp: 0, failed: null, failureMsg: null, justFailed: false },
  };
}
