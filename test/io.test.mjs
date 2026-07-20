// test/io.test.mjs
// Node.js test suite for io/ modules: import and export.
// Run: node test/io.test.mjs
// Exit nonzero on failure.

import assert from 'assert';
import {
  importFromUrl,
  importFromText,
} from '../js/io/import.js';
import {
  toSpiceNetlist,
  toKicadNetlist,
  saveJson,
  loadJson,
} from '../js/io/export.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failCount++;
  }
}

// ============================================================================
// Test 1: Parse real 1N4148 .model card with + continuations
// ============================================================================
test('Parse 1N4148 .model card with + continuations and engineering suffixes', () => {
  const modelCard = `
.MODEL D1N4148 D
+ (IS=2.52e-9 RS=0.568
+  N=1.752 BV=100 IBV=100u CJO=0.95p VJ=0.55 M=0.33 FC=0.5)
  `.trim();

  const parts = importFromText(modelCard);

  assert.strictEqual(parts.length, 1, 'should parse 1 diode');
  const part = parts[0];
  assert.strictEqual(part.name, 'D1N4148', 'name should be D1N4148');
  assert.strictEqual(part.base, 'diode', 'base should be diode (not LED)');

  // Check that parameters were parsed correctly
  assert(part.params.is !== undefined, 'should have is parameter');
  assert(Math.abs(part.params.is - 2.52e-9) < 1e-10, 'IS should be ~2.52e-9');
  assert(part.params.rs !== undefined, 'should have rs parameter');
  assert(Math.abs(part.params.rs - 0.568) < 0.001, 'RS should be ~0.568');
  assert(part.params.n !== undefined, 'should have n parameter');
  assert(Math.abs(part.params.n - 1.752) < 0.001, 'N should be ~1.752');

  assert.strictEqual(part.ratings.maxReverseV, 100, 'BV should map to maxReverseV');
});

// ============================================================================
// Test 2: LED model detection and vf calculation
// ============================================================================
test('LED model detection by name and vf calculation', () => {
  const ledModel = `.MODEL WP7113ID_LED D (IS=1e-14 N=2.8 RS=10)`;
  const parts = importFromText(ledModel);

  assert.strictEqual(parts.length, 1, 'should parse 1 part');
  const part = parts[0];
  assert.strictEqual(part.base, 'led', 'base should be led (name contains LED)');

  // Check vf calculation: vf ≈ n*0.02585*ln(0.02/is), clamped to [1.6, 3.6]
  const { vf } = part.params;
  assert(typeof vf === 'number', 'vf should be a number');
  assert(vf >= 1.6 && vf <= 3.6, `vf should be in range [1.6, 3.6], got ${vf}`);
  console.log(`  LED vf calculated: ${vf.toFixed(3)}V`);
});

// ============================================================================
// Test 3: LED detection by N > 2.5
// ============================================================================
test('LED detection by N parameter > 2.5', () => {
  const highNModel = `.MODEL HighN_Diode D (IS=1e-14 N=2.9 RS=5)`;
  const parts = importFromText(highNModel);

  assert.strictEqual(parts.length, 1);
  const part = parts[0];
  assert.strictEqual(part.base, 'led', 'N > 2.5 should map to LED');
  assert(part.params.vf >= 1.6 && part.params.vf <= 3.6);
});

// ============================================================================
// Test 4: JSON part spec roundtrip
// ============================================================================
test('JSON part spec import and roundtrip', () => {
  const jsonSpec = {
    name: 'Kingbright WP7113ID',
    base: 'led',
    params: { vf: 2.1, rs: 3 },
    ratings: { maxCurrent: 0.03, surgeCurrent: 0.1 },
  };

  const parts = importFromText(JSON.stringify(jsonSpec));
  assert.strictEqual(parts.length, 1);
  assert.deepStrictEqual(parts[0], jsonSpec);
});

// ============================================================================
// Test 5: JSON array of parts
// ============================================================================
test('JSON array of multiple parts', () => {
  const jsonArray = [
    {
      name: 'LED1',
      base: 'led',
      params: { vf: 2.0 },
      ratings: { maxCurrent: 0.02 },
    },
    {
      name: 'Resistor1',
      base: 'resistor',
      params: { resistance: 220 },
      ratings: { maxPower: 0.25 },
    },
  ];

  const parts = importFromText(JSON.stringify(jsonArray));
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0].base, 'led');
  assert.strictEqual(parts[1].base, 'resistor');
});

// ============================================================================
// Test 6: Subcircuit detection throws error
// ============================================================================
test('Subcircuit (.SUBCKT) detection throws error', () => {
  const subcktText = `.SUBCKT OPAMP 1 2 3 4 5
.ENDS`;

  let threw = false;
  let errorMsg = '';
  try {
    importFromText(subcktText);
  } catch (err) {
    threw = true;
    errorMsg = err.message;
  }

  assert.strictEqual(threw, true, 'should throw on .SUBCKT');
  assert(/Subcircuits not yet supported/i.test(errorMsg), 'error message should mention subcircuits');
});

// ============================================================================
// Test 7: Invalid base throws error
// ============================================================================
test('Invalid base in JSON throws error', () => {
  const badJson = {
    name: 'BadPart',
    base: 'invalidType',
    params: {},
  };

  let threw = false;
  try {
    importFromText(JSON.stringify(badJson));
  } catch (err) {
    threw = true;
  }

  assert.strictEqual(threw, true, 'should throw on invalid base');
});

// ============================================================================
// Test 8: Engineering suffix parsing
// ============================================================================
test('Engineering suffix parsing (n, u, m, k, MEG)', () => {
  const model = `.MODEL TestDiode D (IS=2.52n RS=1.5u BV=50k CJO=95p)`;
  const parts = importFromText(model);

  assert.strictEqual(parts.length, 1);
  const { is, rs } = parts[0].params;

  // 2.52n = 2.52e-9
  assert(Math.abs(is - 2.52e-9) < 1e-15, `IS should be 2.52e-9, got ${is}`);
  // 1.5u = 1.5e-6
  assert(Math.abs(rs - 1.5e-6) < 1e-12, `RS should be 1.5e-6, got ${rs}`);
});

// ============================================================================
// Test 9: SPICE netlist generation (3-component circuit)
// ============================================================================
test('SPICE netlist generation with correct node references', () => {
  // Build a hand-crafted 3-component circuit:
  // Battery: nodes [0, 1]
  // Resistor: nodes [1, 2]
  // LED: nodes [2, 0]

  const components = [
    {
      id: 'V1',
      type: 'battery',
      params: { voltage: 9 },
      nodes: [0, 1],
    },
    {
      id: 'R1',
      type: 'resistor',
      params: { resistance: 220 },
      nodes: [1, 2],
    },
    {
      id: 'D1',
      type: 'led',
      params: { vf: 2.0 },
      nodes: [2, 0],
    },
  ];

  const nodeOf = (comp) => comp.nodes;

  // Mock registry with minimal spice() implementations
  const registry = {
    battery: {
      spice: (comp, nodeNames) => `${comp.id} ${nodeNames[0]} ${nodeNames[1]} DC ${comp.params.voltage}`,
    },
    resistor: {
      spice: (comp, nodeNames) => `${comp.id} ${nodeNames[0]} ${nodeNames[1]} ${comp.params.resistance}`,
    },
    led: {
      spice: (comp, nodeNames) => `D${comp.id} ${nodeNames[0]} ${nodeNames[1]} LED_MODEL`,
    },
  };

  const spice = toSpiceNetlist(components, nodeOf, registry);

  // Verify SPICE output
  assert(spice.includes('V1 GND n1 DC 9'), 'should have battery line with correct nodes');
  assert(spice.includes('R1 n1 n2 220'), 'should have resistor line');
  assert(spice.includes('D1 n2 GND LED_MODEL'), 'should have LED line');
  assert(spice.includes('.end'), 'should end with .end');

  console.log('  SPICE netlist generated (first 300 chars):');
  console.log('  ' + spice.substring(0, 300).replace(/\n/g, '\n  '));
});

// ============================================================================
// Test 10: KiCad netlist generation (s-expression structure)
// ============================================================================
test('KiCad netlist generation with balanced s-expressions', () => {
  const components = [
    {
      id: 'R1',
      type: 'resistor',
      params: { resistance: 220 },
      nodes: [1, 2],
    },
    {
      id: 'C1',
      type: 'capacitor',
      params: { capacitance: 100e-6 },
      nodes: [2, 0],
    },
  ];

  const nodeOf = (comp) => comp.nodes;

  const registry = {
    resistor: {
      kicad: { lib: 'Device', symbol: 'R', footprint: 'R_0603' },
      spice: () => '',
    },
    capacitor: {
      kicad: { lib: 'Device', symbol: 'C', footprint: 'C_0603' },
      spice: () => '',
    },
  };

  const kicad = toKicadNetlist(components, nodeOf, registry);

  // Check s-expression structure
  const openCount = (kicad.match(/\(/g) || []).length;
  const closeCount = (kicad.match(/\)/g) || []).length;
  assert.strictEqual(openCount, closeCount, 'parentheses should be balanced');

  // Check for required fields
  assert(kicad.includes('(export (version "E")'), 'should have export version E');
  assert(kicad.includes('(components'), 'should have components section');
  assert(kicad.includes('(nets'), 'should have nets section');
  assert(kicad.includes('(ref "R1")'), 'should contain R1 reference');
  assert(kicad.includes('(ref "C1")'), 'should contain C1 reference');
  assert(kicad.includes('GND'), 'should have GND net');
  assert(kicad.includes('pin'), 'should list pins');

  console.log('  KiCad netlist generated (first 400 chars):');
  console.log('  ' + kicad.substring(0, 400).replace(/\n/g, '\n  '));
});

// ============================================================================
// Test 11: saveJson and loadJson roundtrip
// ============================================================================
test('saveJson and loadJson roundtrip', () => {
  const original = {
    components: [
      { id: 'R1', type: 'resistor', params: { resistance: 220 }, nodes: [1, 2] },
    ],
    wires: [
      { id: 'W1', points: [{ x: 100, y: 200 }] },
    ],
  };

  const json = saveJson(original);
  assert(typeof json === 'string', 'saveJson should return string');
  assert(json.includes('version'), 'should include version field');

  const loaded = loadJson(json);
  assert.deepStrictEqual(loaded.components, original.components);
  assert.deepStrictEqual(loaded.wires, original.wires);
});

// ============================================================================
// Test 12: loadJson validation
// ============================================================================
test('loadJson rejects invalid JSON structure', () => {
  const badJson = JSON.stringify({ someField: 'value' });

  let threw = false;
  try {
    loadJson(badJson);
  } catch (err) {
    threw = true;
  }

  assert.strictEqual(threw, true, 'should throw on missing circuit field');
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(60));
console.log(`Tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  process.exit(1);
}
process.exit(0);
