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
  // default 2-terminal parts (battery, resistor, led, diode, capacitor, motor,
  // bulb, fuse, switch, voltmeter, ammeter)
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
  if (comp.type === 'switch') {
    // leave user-set closed state alone
  }
  return comp;
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
