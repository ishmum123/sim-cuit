// js/engine/sketch.js
// Contract: DOM-free "sketch" runtime for the ESP32 part — lets a user write
// an Arduino-style JS program (setup()/loop() with pinMode/digitalWrite/...)
// that drives the simulated GPIO pins. No build step, no real threads, no
// DOM: this module must run unmodified under plain Node (see
// test/sketch.test.mjs) exactly as it does in the browser.
//
// ---------------------------------------------------------------------------
// Cooperative timing without real threads — the "replay" trick
// ---------------------------------------------------------------------------
// loop() is re-invoked from the top on every resume. `delay(ms)` doesn't
// actually block: the first time a given delay() call site is reached in the
// CURRENT loop() invocation, it records a resume sim-time and throws a Yield
// to unwind back out of loop() entirely. On the next tick() where sim time
// has caught up to that resume time, loop() is called again FROM THE TOP —
// every statement before that delay() (including earlier delay() calls in
// the same invocation) re-executes, but those earlier delay()s recognize
// they've already elapsed (tracked by `_delayHead`, how many delay() calls
// have fully elapsed so far in this invocation) and return instantly instead
// of yielding again. Once loop() runs all the way through without hitting a
// not-yet-elapsed delay(), the invocation is "done" and `_delayHead` resets
// to 0 for the next fresh invocation.
//
// This is simple and correct as long as the sketch is deterministic between
// yields given (millis(), pin reads) — see the module doc in the task/README
// for the caveat: any side effect BEFORE the current yield point (pinMode,
// digitalWrite, print) re-runs every time loop() is replayed from the top.
// pinMode/digitalWrite are just idempotent state sets, so replaying them is
// harmless. print() is NOT idempotent (it would spam the serial monitor with
// duplicate lines), so it's deduplicated the same way delay() is — by
// tracking how many print() calls have already been "emitted" so far in this
// invocation (`_printHead`) and only emitting new ones past that point.
// ---------------------------------------------------------------------------

const HIGH = 1;
const LOW = 0;
const INPUT = 0;
const OUTPUT = 1;

const VALID_PINS = new Set([2, 4, 5]);

const MAX_LOOP_ITERS = 200000;     // per single setup()/loop() execution attempt
const MAX_DELAY_REPLAY = 10000;    // per single execution attempt, see module doc
const MAX_LOG_LINES = 200;

// thrown internally to unwind out of loop()/setup() when a delay() blocks;
// never escapes SketchRuntime.
class Yield {}
const YIELD = new Yield();

class LoopBudgetError extends Error {}
class DelayBudgetError extends Error {}

// Globals that must NOT be reachable from sketch code even though `new
// Function` bodies otherwise run in (browser) global scope. Shadowed as
// ordinary function parameters bound to `undefined` at call time, so any
// reference to e.g. `window` inside the sketch resolves to the shadowed
// (undefined) parameter instead of the real global.
// NOTE: 'eval' and 'arguments' can't be shadowed this way — strict-mode
// function bodies reject a parameter literally named `eval`/`arguments`
// (SyntaxError). Everything else reachable from a "new Function" body in a
// browser is shadowed as undefined.
const SCRUBBED_GLOBALS = [
  'window', 'document', 'globalThis', 'self', 'fetch', 'XMLHttpRequest',
  'require', 'process', 'module', 'exports', 'Function',
  'importScripts', 'WebSocket', 'Worker', 'localStorage', 'sessionStorage',
  'indexedDB', 'navigator', 'location',
];

// Lightweight loop-body instrumentation ("loop protect"): inject a budget
// check as the first statement of every for/while/do-while loop body so a
// runaway `while (true) {}` with no delay() throws instead of hanging the
// JS thread forever (nothing else CAN interrupt a synchronous JS loop).
// Regex-based, not a real parser — handles the common brace-delimited forms
// (`for (...) { ... }`, `while (...) { ... }`, `do { ... } while (...)`,
// including one level of nested parens in the condition, e.g. a function
// call). Loops without braces (`while (x) doStuff();`) are NOT instrumented;
// this is a documented limitation, not a soundness guarantee.
function instrumentLoops(src) {
  const guard = '__lg__();';
  return src
    .replace(/\b(for|while)\s*\((?:[^()]|\([^()]*\))*\)\s*\{/g, (m) => `${m}${guard}`)
    .replace(/\bdo\s*\{/g, (m) => `${m}${guard}`);
}

export class SketchRuntime {
  constructor(source) {
    this.source = source || '';
    this.status = 'stopped'; // 'stopped' | 'running' | 'error'
    this.error = null;
    this.log = [];
    this._maxLog = MAX_LOG_LINES;

    this._setupDone = false;
    this._delayHead = 0;
    this._printHead = 0;
    this._pendingResumeAt = null;
    this._now = 0;
    this._inSetup = false;
    this._loopIterCount = 0;
    this._pins = {}; // pinNum -> { mode: 'output'|'input', value: 0|1 }
    this._readVoltage = () => 0;

    this._exports = null;
    this._compile();
  }

  // ------------------------------------------------------------- compiling

  _compile() {
    let guarded;
    try {
      guarded = instrumentLoops(this.source);
    } catch (e) {
      this.status = 'error';
      this.error = `Compile error: ${e.message}`;
      return;
    }
    const apiNames = [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'millis',
      'delay', 'print', 'HIGH', 'LOW', 'INPUT', 'OUTPUT', '__lg__',
    ];
    const body = `"use strict";\n${guarded}\n;return { setup: (typeof setup === 'function' ? setup : null), loop: (typeof loop === 'function' ? loop : null) };`;
    try {
      // eslint-disable-next-line no-new-func
      const factory = new Function(...apiNames, ...SCRUBBED_GLOBALS, body);
      const api = this._makeApi();
      const scrubbedArgs = SCRUBBED_GLOBALS.map(() => undefined);
      this._exports = factory(
        api.pinMode, api.digitalWrite, api.digitalRead, api.analogRead,
        api.millis, api.delay, api.print, HIGH, LOW, INPUT, OUTPUT, api.__lg__,
        ...scrubbedArgs,
      );
    } catch (e) {
      this.status = 'error';
      this.error = `Compile error: ${e.message}`;
      this._exports = null;
      return;
    }
    if (!this._exports || typeof this._exports.loop !== 'function') {
      this.status = 'error';
      this.error = 'Compile error: sketch must define a loop() function';
      this._exports = null;
    }
  }

  // ------------------------------------------------------------------- api

  _makeApi() {
    const rt = this;
    return {
      pinMode(pin, mode) {
        rt._checkPin(pin);
        const p = rt._pins[pin] || { value: 0 };
        p.mode = mode === OUTPUT ? 'output' : 'input';
        rt._pins[pin] = p;
      },
      digitalWrite(pin, val) {
        rt._checkPin(pin);
        const p = rt._pins[pin] || { mode: 'output' };
        p.mode = 'output'; // implicit like real Arduino (works, just not best practice)
        p.value = val ? HIGH : LOW;
        rt._pins[pin] = p;
      },
      digitalRead(pin) {
        rt._checkPin(pin);
        const p = rt._pins[pin];
        if (p && p.mode === 'output') return p.value; // register readback
        const v = rt._readVoltage(pin);
        return v > 1.65 ? HIGH : LOW;
      },
      analogRead(pin) {
        rt._checkPin(pin);
        const v = rt._readVoltage(pin);
        const raw = Math.round((v / 3.3) * 4095);
        return Math.max(0, Math.min(4095, raw));
      },
      millis() {
        return Math.floor((rt._now - rt._startTime) * 1000);
      },
      delay(ms) {
        if (!rt._inSetup) rt._delay(ms);
        // delay() inside setup() is a documented no-op — setup() runs once,
        // synchronously, to completion; it doesn't support cooperative
        // yielding.
      },
      print(...args) {
        rt._print(args);
      },
      __lg__() {
        rt._loopIterCount++;
        if (rt._loopIterCount > MAX_LOOP_ITERS) throw new LoopBudgetError();
      },
    };
  }

  _checkPin(pin) {
    if (!VALID_PINS.has(pin)) throw new Error(`Invalid pin ${pin} — valid GPIOs are 2, 4, 5`);
  }

  _delay(ms) {
    if (this._delayIdx < this._delayHead) {
      // already elapsed earlier in THIS replay of the current loop() invocation
      this._delayIdx++;
      return;
    }
    if (this._delayIdx > MAX_DELAY_REPLAY) throw new DelayBudgetError();
    if (this._pendingResumeAt === null) {
      this._pendingResumeAt = this._now + Math.max(0, Number(ms) || 0) / 1000;
      throw YIELD;
    }
    if (this._now < this._pendingResumeAt) throw YIELD;
    // this exact delay() call's time has elapsed: consume it and keep going
    this._delayHead++;
    this._pendingResumeAt = null;
    this._delayIdx++;
  }

  _print(args) {
    if (this._printIdx < this._printHead) { this._printIdx++; return; }
    const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    this.log.push(line);
    if (this.log.length > this._maxLog) this.log.shift();
    this._printHead++;
    this._printIdx++;
  }

  // ---------------------------------------------------------------- driver

  // Bind a callback used by digitalRead()/analogRead(): (pinNumber) => volts
  setPinReader(fn) { this._readVoltage = fn; }

  // Restart the sketch as if the board had just rebooted: setup() runs again
  // on the next tick(), all pin state / timing state is cleared. Called by
  // the ESP32 integration when the board loses power (or fails) and later
  // regains power — a real MCU reboots too.
  reset() {
    this._setupDone = false;
    this._delayHead = 0;
    this._printHead = 0;
    this._pendingResumeAt = null;
    this._pins = {};
    this._startTime = this._now;
    if (this.status !== 'error') this.status = 'stopped';
  }

  getPinState() { return this._pins; }

  // Advance the sketch: run setup() once (first call), then run/resume
  // loop() if it's time to. `now` is simulated seconds. No-ops once halted
  // (status === 'error') — the caller (ESP32 postStep) surfaces `error` via
  // the properties panel; the sketch must be re-Uploaded (which constructs a
  // fresh SketchRuntime) to clear it.
  tick(now) {
    this._now = now;
    if (this.status === 'error' || !this._exports) return;
    if (this._startTime === undefined) this._startTime = now;

    if (!this._setupDone) {
      this._runEntry('setup', now);
      if (this.status === 'error') return;
      this._setupDone = true;
      this.status = 'running';
    }

    if (this._pendingResumeAt !== null && now < this._pendingResumeAt) return; // still waiting
    this._runEntry('loop', now);
  }

  _runEntry(which, now) {
    const fn = which === 'setup' ? this._exports.setup : this._exports.loop;
    if (typeof fn !== 'function') return; // setup() is optional
    this._inSetup = which === 'setup';
    this._delayIdx = 0;
    this._printIdx = 0;
    this._loopIterCount = 0;
    try {
      fn();
      // ran to completion without yielding: this invocation is fully done
      this._delayHead = 0;
      this._printHead = 0;
      this._pendingResumeAt = (which === 'loop' && this._delayIdx === 0)
        ? now + 0.001 // loop() never called delay() at all: guard against a tight busy-poll
        : null;
    } catch (e) {
      if (e === YIELD || e instanceof Yield) return; // normal cooperative pause
      if (e instanceof LoopBudgetError) {
        this.status = 'error';
        this.error = 'Sketch stopped: loop() too long — add delay()';
        return;
      }
      if (e instanceof DelayBudgetError) {
        this.status = 'error';
        this.error = 'Sketch stopped: too many delay() calls in a single loop() pass';
        return;
      }
      this.status = 'error';
      this.error = `Runtime error in ${which}(): ${e.message}`;
    }
  }
}

export const SketchConstants = { HIGH, LOW, INPUT, OUTPUT };
