# Sim-cuit

A realistic, breakable circuit simulator in the browser. Components don't just
compute — they have real ratings and **fail the way real parts fail**:

- Push 90 mA through a 30 mA LED and it **fuses open** (with smoke).
- Feed a 6 V motor 1.5 V and it **doesn't spin** — it just sits there drawing stall current.
- Exceed a resistor's power rating and it chars and burns open after a second or two.
- Reverse a polarized electrolytic cap and it vents (fails short).
- Fuses blow on I²t, bulb filaments burn out past rated voltage, batteries sag under load.

Damage is permanent until you hit **Repair**.

## Run it

No build step, no dependencies:

```sh
cd sim-cuit
python3 -m http.server 8000   # or any static server; file:// also works in most browsers
# open http://localhost:8000
```

## Real parts from links

**Import Part** accepts a URL or pasted text containing:

1. **Manufacturer SPICE `.model` cards** (what vendors actually publish on their
   sites) — e.g. `.MODEL D1N4148 D (IS=2.52n RS=0.568 N=1.752 BV=100)`. Diode and
   LED models map onto the simulator's physical models, so the part behaves per
   its datasheet electrical characteristics.
2. **JSON part specs** including failure ratings:

```json
{ "name": "Kingbright WP7113ID",
  "base": "led",
  "params": { "vf": 2.0, "rs": 2, "color": "#ff3b30" },
  "ratings": { "maxCurrent": 0.03, "surgeCurrent": 0.1 } }
```

Note: arbitrary datasheet **PDFs can't be auto-converted** to exact behavior —
no tool can do that reliably. SPICE models capture the electrical behavior;
the JSON ratings capture the destruction limits. Imported parts appear in the
palette under "Imported" and simulate with their own parameters.

## PCB export

**Export → KiCad netlist** produces a netlist with footprints that
[KiCad](https://www.kicad.org/) (free, open source) imports directly
(PCB editor → File → Import Netlist) so you can lay out and fab a real board.
SPICE netlist export (`.cir`) works with ngspice/LTspice.

## Engine

Modified Nodal Analysis with Newton–Raphson for nonlinear devices (Shockley
diode/LED, filament bulbs, BJTs), backward-Euler transient stepping, back-EMF
motor model with static friction, and per-component thermal accumulators that
drive the failure logic. Engine is DOM-free — `node test/engine.test.mjs` runs
the physics test suite headless.

## Examples

Four example circuits are provided in the `examples/` directory to demonstrate
failure modes and realistic behavior:

- **led-basics.json** — 9 V battery, switch, 220 Ω resistor, red LED, and
  ground. When the switch closes, the LED lights at safe current (~30 mA) and
  stays on without damage.
- **led-killer.json** — Same topology but without the resistor. When the switch
  closes, the LED draws excessive current and fuses open within milliseconds,
  demonstrating overcurrent failure.
- **motor-stall.json** — 1.5 V battery (insufficient), switch, DC motor, and
  ground, plus a spare 9 V battery on the breadboard. With the switch closed,
  the motor draws stall current but does not spin due to inadequate voltage—the
  torque cannot overcome static friction. A 9 V supply would make it work.
- **fuse-protects.json** — 9 V battery, 1 A fuse, 2 Ω load resistor, and
  ground. The resistor draws ~4.5 A, causing the fuse's I²t accumulator to
  reach its threshold and blow the circuit open, protecting the system.

Load any example into the app via **Import → Load JSON** to see the behavior
live. All examples validate against the simulator via `node test/examples.test.mjs`.

## Contributing

Issues and pull requests are welcome. No build step required; to run the test
suite:

```sh
npm test
```

This runs `node test/engine.test.mjs` (solver + component models),
`node test/io.test.mjs` (import/export), `node test/integration.test.mjs`
(end-to-end circuits), and `node test/examples.test.mjs` (example circuit
validation). All modules are ES modules (`.mjs`) and run without compilation.

## Why this exists

No existing free tool combines realistic component destruction with simulation
and PCB export: KiCad+ngspice simulates but nothing ever burns out, Falstad has
no failures or PCB flow, Tinkercad Circuits breaks LEDs but is closed-source
with no PCB export. Sim-cuit is the missing intersection. MIT licensed.
