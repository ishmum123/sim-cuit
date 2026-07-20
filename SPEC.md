# Sim-cuit — Architecture Spec (contract for all modules)

Realistic circuit simulator: components have real ratings and FAIL realistically
(LED fuses on overcurrent, motor stalls below minimum voltage, resistor burns past
its power rating, electrolytic cap pops on reverse polarity, fuse blows on I²t).
Import real parts from manufacturer SPICE `.model` cards or JSON specs. Export
KiCad netlist for PCB layout + SPICE netlist.

**Tech:** Vanilla ES modules, no build step, no dependencies. `index.html` opens
directly in a browser. All modules are ES modules (`export` / `import`).
Solver + components must ALSO run in Node (no DOM access in `js/engine/*`).

## File layout

```
index.html
css/style.css
js/main.js              — glue: builds Netlist from editor state, runs sim loop
js/engine/solver.js     — MNA solver (DOM-free)
js/engine/components.js — component models + registry (DOM-free)
js/ui/editor.js         — canvas editor: place/drag/wire/rotate/delete/properties
js/ui/render.js         — drawing + animation (glow, current dots, smoke, meters)
js/io/import.js         — SPICE .model / JSON part import (fetch URL or paste)
js/io/export.js         — KiCad netlist + SPICE netlist exporters
test/engine.test.mjs    — Node tests for solver+components (run: node test/engine.test.mjs)
```

## Core data model (shared by ALL modules)

A **ComponentInstance** (plain object, serializable):

```js
{
  id: "R1",              // unique, prefix by type letter + counter
  type: "resistor",      // key into ComponentRegistry
  x: 240, y: 160,        // grid-snapped canvas position (grid = 20px)
  rot: 0,                // 0|90|180|270
  params: { resistance: 220 },        // electrical params (type-specific)
  ratings: { maxPower: 0.25 },        // limits; exceeding → damage
  state: {}              // sim-owned mutable state (see below), editor never touches
}
```

`state` common fields written by the engine every step:
- `v` (voltage across, terminals[0] − terminals[1]), `i` (current through, into terminal 0),
  `p` (dissipated watts)
- `temp` — 0..1+ normalized thermal stress accumulator (0 = cold, ≥1 = failed)
- `failed` — `null | "open" | "short"`
- `failureMsg` — human string, e.g. `"LED fused: 87 mA > 30 mA max"`
- `justFailed` — true only on the step the failure happened (render uses it to spawn smoke)
- type-specific: motor `rpm`, `spinning`; bulb `brightness` 0..1; led `brightness` 0..1;
  fuse `i2t` accumulator; battery `charge` 0..1

**Wires** are separate: `{ id, points: [{x,y},...] }` (polyline, grid-snapped).
**Nodes**: main.js computes electrical nodes by union-find over coincident terminal
positions and wire points. Ground component pins node 0.

## Engine API (`js/engine/solver.js`)

```js
export class Simulation {
  // comps: ComponentInstance[] with .nodes = [nodeIdx,...] already assigned (node 0 = ground)
  setNetlist(comps) {}
  step(dt) {}   // one transient step (backward Euler + Newton-Raphson for nonlinear).
                // Writes state.v/i/p on every component, then calls model.postStep()
                // which applies thermal/failure logic. Must be robust: cap Newton at
                // ~60 iters, use gmin stepping fallback; singular matrix (floating
                // node) must NOT throw — isolate and continue.
  nodeVoltages  // Float64Array, index = node
  time          // seconds
}
```

Internally: Modified Nodal Analysis, dense Gaussian elimination with partial
pivoting (circuits are small). Voltage sources & inductors get current variables.
Nonlinear devices (diode/LED/BJT/bulb) linearize per Newton iteration.
Diode companion model must limit exponentials (junction voltage clamp) for
convergence. A failed-"open" component stamps ~1e-12 S leak; failed-"short"
stamps ~1e3 S.

## Component model contract (`js/engine/components.js`)

```js
export const ComponentRegistry = {
  resistor: {
    label: "Resistor", prefix: "R", terminals: 2,
    defaultParams: {...}, defaultRatings: {...},
    paramSchema: [ { key:"resistance", label:"Resistance (Ω)", type:"number", min:... }, ... ],
    // stamping — called by solver each Newton iteration:
    stamp(comp, ctx) {},        // ctx: {G(i,j,g), I(i,cur), stampVsrc(...), vNode(i), dt, ...}
    // after each converged step — thermal + failure logic:
    postStep(comp, dt) {},
    // SPICE + KiCad export hints:
    spice(comp, nodeNames) => "R1 n1 n2 220",
    kicad: { lib: "Device", symbol: "R", footprint: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal" },
  },
  ...
}
```

### Required component types & realistic behavior (this is the heart of the app)

| type | params | ratings | realistic quirks |
|---|---|---|---|
| `battery` | voltage=9, internalResistance=0.5 | maxCurrent=5 | sags under load via Rint; short → huge current heats it (temp rises), state warns |
| `resistor` | resistance=220 | maxPower=0.25 | P>rating accumulates temp (τ≈1.5 s at 2× rating); temp≥1 → burns **open**, permanent |
| `led` | color, vf=2.0, rs=2 (Ω series) | maxCurrent=0.03 (cont), surgeCurrent=0.1 | Shockley diode model; brightness = clamp(i/ratedCurrent); i>surge → fuses **open** in ms; i>max → temp integral → fuses open in ~1 s; reverse V > 5 V → fails open. `failureMsg` includes measured mA |
| `diode` | is=1e-14, n=1.8 | maxCurrent=1, maxReverseV=100 | standard; breakdown past maxReverseV → short then open |
| `capacitor` | capacitance=100e-6, polarized=true | maxVoltage=16 | polarized + reverse V>1 → temp rises fast → fails **short** (vented); V>maxVoltage → same |
| `motor` (brushed DC) | resistance=3, ke=0.01 (V·s/rad), inertia=1e-5, friction=2e-4 (static torque N·m), kt=ke | maxVoltage=12, maxCurrent=2 | back-EMF: V = i·R + ke·ω; torque kt·i must exceed static friction to START spinning (below ~min voltage it just sits and draws stall current); stall current overheats winding → open. state.rpm |
| `bulb` (incandescent) | ratedVoltage=6, ratedPower=1 | — | resistance rises with filament temp (R_cold ≈ R_hot/10); brightness ∝ (T/T_rated)^2 clamp 0..1.2; sustained V > 1.3× rated → filament burns **open** |
| `fuse` | ratedCurrent=1 | — | I²t accumulator with dissipation; blows **open**; visual break |
| `switch` | closed=false | maxCurrent=10 | toggled by click in editor |
| `potentiometer` | resistance=10e3, wiper=0.5 | maxPower=0.1 | 3-terminal; drag/scroll adjusts wiper live |
| `ground` | — | — | pins node 0; every circuit needs one (main.js: if none, treat battery − as ground and warn) |
| `voltmeter` | — | — | 10 MΩ; displays state.v on canvas |
| `ammeter` | — | — | 0.01 Ω shunt; displays state.i |
| `wireResistor`? no — wires are ideal | | | |

Failures are **permanent** until the user clicks "Repair part" or resets. Damage
accumulates realistically (brief surge ≠ instant death unless way over surge limit).

Imported parts (from io/import.js) register as NEW registry entries cloned from a
base type (`led`, `diode`, `resistor`, `motor`, ...) with overridden
params/ratings + custom label — so they simulate exactly per their model card.

## UI (`js/ui/editor.js`, `js/ui/render.js`)

Look: dark slate background (#151a21) with subtle dot grid; components drawn as
clean schematic symbols with rounded strokes; **wires glow** subtly when carrying
current; animated **current dots** flow along wires (speed ∝ current, direction
matters); LEDs render a radial glow bloom of their color scaled by brightness;
motors show a spinning shaft/fan; overheating parts shift color toward orange/red
(temp 0→1) and emit **smoke particle wisps** on failure (justFailed) then show a
charred/cracked symbol; blown fuse shows broken filament. Voltmeter/ammeter show
live 7-seg-style readouts. 60 fps canvas, devicePixelRatio-aware.

Layout: left sidebar = parts palette (icons + names, click-to-place or drag);
top bar = Run/Pause, Reset, sim speed, Import Part, Export ▾ (KiCad netlist /
SPICE netlist / Save JSON / Load JSON), Repair All; right panel = properties of
selected component (from paramSchema + ratings, editable) + live readings
(V/I/P/temp bar) + failure banner with failureMsg and per-part Repair button.
Canvas: click palette part then click canvas to place; drag to move (grid snap
20px); R rotates; Del deletes; click a terminal then click/drag to route a wire
(orthogonal segments); Esc cancels; click switch toggles it; scroll on pot =
wiper. Status toast for events ("LED1 fused: 87 mA > 30 mA max").

Editor owns: `{ components: [], wires: [] }` and selection; exposes
`getCircuit()`, `onChange(cb)`, `markDirty()`. Render reads engine `state` fields
directly off component objects. Keep editor logic and pure drawing separated.

## Import (`js/io/import.js`)

```js
export async function importFromUrl(url) => PartDef[]   // fetch text (CORS may block; catch → tell user to paste)
export function importFromText(text) => PartDef[]        // auto-detect format
// PartDef: { name, base: "led"|"diode"|"resistor"|"npn"|..., params: {...}, ratings: {...} }
```

Formats:
1. **SPICE `.model` cards** — `.MODEL D1N4148 D (IS=2.52e-9 RS=0.568 N=1.752 BV=100 ...)`
   Map D→diode (IS→is, N→n, RS→rs, BV→maxReverseV). LED models (VF via IS/N) map to led.
2. **JSON part spec** — `{ "name":"Kingbright WP7113ID", "base":"led", "params":{"vf":2.0,...}, "ratings":{"maxCurrent":0.03,"surgeCurrent":0.1} }` (single object or array).
3. `.SUBCKT` — not simulated in v1; detect and report "subcircuits not yet supported" cleanly.

main.js adds returned PartDefs into ComponentRegistry (cloning the base) and the
palette under an "Imported" section.

## Export (`js/io/export.js`)

```js
export function toSpiceNetlist(components, wires) => string      // .cir with .model cards
export function toKicadNetlist(components, wires) => string      // KiCad s-expression netlist
export function saveJson(circuit) / loadJson(text)
```

KiCad netlist: `(export (version "E") (components (comp (ref ...) (value ...)
(footprint ...))...) (nets (net (code ...) (name ...) (node (ref ...) (pin ...))...)))`
— importable in KiCad PCB editor (File → Import Netlist) so the user lays out a
real board. Use each registry entry's `kicad.footprint`. Node numbering identical
to sim nodes. Both exporters trigger a file download (this part may touch DOM —
that's fine, io/ is browser-side; but keep netlist STRING generation pure so it
is testable in Node).

## Conventions

- Grid 20 px. Terminal positions derive from x,y,rot per type (2-terminal parts:
  ±40 px along axis; document a `terminalOffsets(comp)` helper in components.js —
  UI and main.js both use it).
- No frameworks, no external fonts/CDNs. System font stack + monospace for readouts.
- Every module head-commented with its contract. Keep functions small.
