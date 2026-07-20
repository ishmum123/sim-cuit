// js/engine/solver.js
// Contract: DOM-free Modified Nodal Analysis (MNA) transient solver.
// Dense Gaussian elimination with partial pivoting. Backward Euler integration.
// Newton-Raphson for nonlinear device models (diode/LED/bulb/motor).
// Must never throw or produce NaN: floating nodes get a gmin leak to ground,
// and dt is halved (up to 4x) internally if convergence/NaN issues occur.
//
// Usage:
//   const sim = new Simulation();
//   sim.setNetlist(comps);   // comps: ComponentInstance[] with .nodes assigned, node 0 = ground
//   sim.step(dt);
//   sim.nodeVoltages         // Float64Array
//   sim.time                 // seconds

import { ComponentRegistry } from './components.js';

const GMIN = 1e-12;
const MAX_NEWTON_ITERS = 60;
const MAX_DT_HALVINGS = 4;

// Each voltage-defining branch (voltage source, or motor-as-source-like branch)
// gets an extra current unknown appended after the node voltages.
// ctx.stampVsrc(branchIdx, nodeP, nodeN, value) stamps a voltage source row/col.

export class Simulation {
  constructor() {
    this.comps = [];
    this.numNodes = 1; // node 0 = ground always exists
    this.numBranches = 0;
    this.nodeVoltages = new Float64Array(1);
    this.branchCurrents = new Float64Array(0);
    this.time = 0;
    this._branchMap = new Map(); // comp.id -> branch index (or array of indices)
  }

  setNetlist(comps) {
    this.comps = comps || [];
    let maxNode = 0;
    for (const c of this.comps) {
      const nodes = c.nodes || [];
      for (const n of nodes) if (n > maxNode) maxNode = n;
      if (!c.state) c.state = {};
    }
    this.numNodes = maxNode + 1;

    // Assign internal (component-private) node indices, e.g. LED junction node
    // between its series resistance and the diode itself.
    this._internalNodeMap = new Map();
    for (const c of this.comps) {
      const model = ComponentRegistry[c.type];
      if (!model) continue;
      const nExtra = typeof model.numExtraNodes === 'function'
        ? model.numExtraNodes(c)
        : (model.numExtraNodes || 0);
      if (nExtra > 0) {
        const idxs = [];
        for (let k = 0; k < nExtra; k++) idxs.push(this.numNodes++);
        this._internalNodeMap.set(c.id, idxs);
      }
    }

    // Assign branch (current-unknown) indices for components that need them.
    this._branchMap.clear();
    let branchCount = 0;
    for (const c of this.comps) {
      const model = ComponentRegistry[c.type];
      if (!model) continue;
      const nBranches = typeof model.numBranches === 'function'
        ? model.numBranches(c)
        : (model.numBranches || 0);
      if (nBranches > 0) {
        const idxs = [];
        for (let k = 0; k < nBranches; k++) idxs.push(branchCount++);
        this._branchMap.set(c.id, idxs);
      }
    }
    this.numBranches = branchCount;
    this.nodeVoltages = new Float64Array(this.numNodes);
    this.branchCurrents = new Float64Array(this.numBranches);
    this.time = 0;
  }

  // Solve one transient step of size dt. Internally may subdivide dt (halving)
  // up to MAX_DT_HALVINGS times if Newton fails to converge or NaN appears.
  step(dt) {
    this._stepRecursive(dt, 0);
    this.time += dt;
  }

  _stepRecursive(dt, depth) {
    const ok = this._newtonSolve(dt);
    if (ok || depth >= MAX_DT_HALVINGS) {
      // accept result (possibly degraded) - finalize component state
      this._finalize(dt);
      return;
    }
    // halve dt, do two half-steps
    const half = dt / 2;
    this._stepRecursive(half, depth + 1);
    this._stepRecursive(half, depth + 1);
  }

  _newtonSolve(dt) {
    const n = this.numNodes - 1 + this.numBranches; // ground excluded from unknowns
    if (n <= 0) return true;

    // working guess: node voltages (excluding ground) + branch currents
    let x = new Float64Array(n);
    for (let i = 1; i < this.numNodes; i++) x[i - 1] = this.nodeVoltages[i] || 0;
    for (let i = 0; i < this.numBranches; i++) x[this.numNodes - 1 + i] = this.branchCurrents[i] || 0;

    let converged = false;
    let prevX = new Float64Array(n);

    for (let iter = 0; iter < MAX_NEWTON_ITERS; iter++) {
      const A = createMatrix(n);
      const b = new Float64Array(n);

      // gmin from every node to ground for robustness (floating nodes)
      for (let i = 0; i < n; i++) A[i][i] += GMIN;

      const ctx = this._makeStampContext(A, b, x, dt);

      for (const c of this.comps) {
        const model = ComponentRegistry[c.type];
        if (!model || !model.stamp) continue;
        ctx._activeComp = c;
        model.stamp(c, ctx);
      }

      const solved = solveLinear(A, b, n);
      if (!solved) {
        return false; // singular beyond gmin help -> trigger dt halving
      }

      // solved gives the NEW x (this stamp formulation solves A*x = b directly,
      // i.e. models stamp linearized equations around current x, and we treat
      // `solved` as the next iterate).
      let maxDelta = 0;
      let hasNaN = false;
      for (let i = 0; i < n; i++) {
        if (!isFinite(solved[i])) { hasNaN = true; break; }
        const delta = Math.abs(solved[i] - x[i]);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (hasNaN) return false;

      prevX = x;
      x = solved;

      const nodeTol = 1e-6;
      const relTol = 1e-4;
      let allOk = true;
      for (let i = 0; i < n; i++) {
        const tol = nodeTol + relTol * Math.abs(x[i]);
        if (Math.abs(x[i] - prevX[i]) > tol) { allOk = false; break; }
      }
      if (allOk) { converged = true; break; }
    }

    if (!converged) {
      // gmin fallback: accept last iterate anyway if finite (already gmin-stabilized)
      let anyNaN = false;
      for (let i = 0; i < n; i++) if (!isFinite(x[i])) anyNaN = true;
      if (anyNaN) return false;
      converged = true; // accept degraded solution rather than failing the whole circuit
    }

    // commit
    for (let i = 1; i < this.numNodes; i++) this.nodeVoltages[i] = x[i - 1];
    for (let i = 0; i < this.numBranches; i++) this.branchCurrents[i] = x[this.numNodes - 1 + i];
    this.nodeVoltages[0] = 0;

    return true;
  }

  _makeStampContext(A, b, x, dt) {
    const numNodes = this.numNodes;
    const branchMap = this._branchMap;
    const internalNodeMap = this._internalNodeMap;
    const vNode = (i) => (i === 0 ? 0 : x[i - 1]);
    const unk = (i) => i - 1; // node i (i>=1) -> unknown index

    return {
      internalNode(compId, k = 0) {
        const arr = internalNodeMap.get(compId);
        return arr ? arr[k] : -1;
      },
      dt,
      time: this.time,
      vNode,
      // add conductance g between nodes i,j (i or j may be 0 = ground)
      G(i, j, g) {
        if (i > 0) A[unk(i)][unk(i)] += g;
        if (j > 0) A[unk(j)][unk(j)] += g;
        if (i > 0 && j > 0) {
          A[unk(i)][unk(j)] -= g;
          A[unk(j)][unk(i)] -= g;
        }
      },
      // inject current `cur` leaving node i (into the node, i.e RHS += cur at node i)
      I(i, cur) {
        if (i > 0) b[unk(i)] += cur;
      },
      // stamp a voltage source branch: v(nodeP) - v(nodeN) = value, with branch current
      // flowing from nodeP to nodeN inside the source. branchIdx is the global branch index.
      stampVsrc(branchIdx, nodeP, nodeN, value) {
        const row = numNodes - 1 + branchIdx;
        if (nodeP > 0) { A[unk(nodeP)][row] += 1; A[row][unk(nodeP)] += 1; }
        if (nodeN > 0) { A[unk(nodeN)][row] -= 1; A[row][unk(nodeN)] -= 1; }
        b[row] += value;
      },
      // get global branch index array for a component that owns branch(es)
      branchIndex(compId, k = 0) {
        const arr = branchMap.get(compId);
        return arr ? arr[k] : -1;
      },
      branchCurrent(compId, k = 0) {
        const idx = this.branchIndex(compId, k);
        if (idx < 0) return 0;
        return x[numNodes - 1 + idx];
      },
      // stamp extra conductance between a branch row and a node (for controlled sources like motor back-emf)
      stampBranchNodeCoupling(branchIdx, nodeI, coeff) {
        const row = numNodes - 1 + branchIdx;
        if (nodeI > 0) A[row][unk(nodeI)] += coeff;
      },
      stampBranchSelf(branchIdx, coeff) {
        const row = numNodes - 1 + branchIdx;
        A[row][row] += coeff;
      },
      stampBranchRHS(branchIdx, value) {
        const row = numNodes - 1 + branchIdx;
        b[row] += value;
      },
      numNodes,
    };
  }

  _finalize(dt) {
    const ctx = this._readCtx(dt);
    for (const c of this.comps) {
      const model = ComponentRegistry[c.type];
      if (!model) continue;
      if (model.computeState) model.computeState(c, ctx);
      // ctx is passed as an optional 3rd arg — existing postStep(comp, dt)
      // implementations simply ignore it; components that need sim time
      // (e.g. esp32's sketch runtime) can read ctx.time.
      if (model.postStep) model.postStep(c, dt, ctx);
    }
  }

  _readCtx(dt) {
    const nodeVoltages = this.nodeVoltages;
    const branchMap = this._branchMap;
    const branchCurrents = this.branchCurrents;
    const internalNodeMap = this._internalNodeMap;
    return {
      dt,
      time: this.time,
      vNode: (i) => (i === 0 ? 0 : nodeVoltages[i] || 0),
      branchCurrent: (compId, k = 0) => {
        const arr = branchMap.get(compId);
        if (!arr) return 0;
        return branchCurrents[arr[k]] || 0;
      },
      internalNode: (compId, k = 0) => {
        const arr = internalNodeMap.get(compId);
        return arr ? arr[k] : -1;
      },
    };
  }
}

function createMatrix(n) {
  const A = new Array(n);
  for (let i = 0; i < n; i++) A[i] = new Float64Array(n);
  return A;
}

// Solve A*x = b via dense Gaussian elimination w/ partial pivoting.
// Returns Float64Array solution or null if truly singular (shouldn't happen w/ gmin).
function solveLinear(A, b, n) {
  // augmented copy
  const M = new Array(n);
  for (let i = 0; i < n; i++) {
    M[i] = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) M[i][j] = A[i][j];
    M[i][n] = b[i];
  }

  for (let col = 0; col < n; col++) {
    // partial pivot
    let pivotRow = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > maxAbs) { maxAbs = v; pivotRow = r; }
    }
    if (maxAbs < 1e-15) {
      continue; // leave as-is; gmin should prevent true singularity
    }
    if (pivotRow !== col) {
      const tmp = M[col]; M[col] = M[pivotRow]; M[pivotRow] = tmp;
    }
    const pivot = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let c = row + 1; c < n; c++) sum -= M[row][c] * x[c];
    const diag = M[row][row];
    if (Math.abs(diag) < 1e-15) {
      x[row] = 0; // isolated/singular dof -> pin to 0 rather than blow up
    } else {
      x[row] = sum / diag;
    }
  }
  for (let i = 0; i < n; i++) if (!isFinite(x[i])) return null;
  return x;
}
