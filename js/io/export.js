// js/io/export.js
// Contract: Export circuits to SPICE netlists, KiCad netlists, and JSON.
// Pure netlist generation (Node-testable). downloadText() is the only DOM touch.
// Signature: toSpiceNetlist(components, nodeOf, registry)
//            toKicadNetlist(components, nodeOf, registry)

/**
 * Generate SPICE netlist from components.
 * @param {Array} components - ComponentInstance[] with .type, .params, .ratings, .id
 * @param {Function} nodeOf - (comp) => [nodeIndices]
 * @param {Object} registry - ComponentRegistry (entries with spice() method or fallback)
 * @returns {string} .cir netlist text
 */
export function toSpiceNetlist(components, nodeOf, registry) {
  const lines = ['* Sim-cuit SPICE Netlist', ''];

  // Generate component lines
  for (const comp of components) {
    const nodes = nodeOf(comp) || [];
    const nodeNames = nodes.map((n) => (n === 0 ? 'GND' : `n${n}`));

    const regEntry = registry && registry[comp.type];

    if (regEntry && typeof regEntry.spice === 'function') {
      // Use registry's custom spice() generator
      const spiceLine = regEntry.spice(comp, nodeNames);
      if (spiceLine) lines.push(spiceLine);
    } else {
      // Fallback: generic 2-terminal resistor-style "COMPID n1 n2 value"
      const val = comp.params?.resistance || comp.params?.capacitance || 1;
      const ref = comp.id || `${comp.type[0].toUpperCase()}1`;
      if (nodeNames.length >= 2) {
        lines.push(`${ref} ${nodeNames[0]} ${nodeNames[1]} ${val}`);
      }
    }
  }

  lines.push('');
  lines.push('.end');
  return lines.join('\n');
}

/**
 * Generate KiCad s-expression netlist from components.
 * Produces valid s-expression syntax with unique net codes.
 * @param {Array} components - ComponentInstance[]
 * @param {Function} nodeOf - (comp) => [nodeIndices]
 * @param {Object} registry - ComponentRegistry
 * @returns {string} KiCad netlist s-expression
 */
export function toKicadNetlist(components, nodeOf, registry) {
  // Build net mapping: node index -> (code, name)
  const netMap = new Map();
  netMap.set(0, { code: 0, name: 'GND' });
  let netCode = 1;

  for (const comp of components) {
    const nodes = nodeOf(comp) || [];
    for (const n of nodes) {
      if (!netMap.has(n)) {
        netMap.set(n, { code: netCode++, name: `Net_${netCode - 1}` });
      }
    }
  }

  // Build component list
  const compLines = [];
  for (const comp of components) {
    const ref = comp.id || 'U1';
    const value = comp.params?.resistance || comp.params?.capacitance || comp.type;
    const regEntry = registry && registry[comp.type];
    const fp = regEntry?.kicad?.footprint || 'Package_Generic:GENERIC';

    compLines.push(
      `  (comp (ref "${ref}") (value "${value}") (footprint "${fp}"))`
    );
  }

  // Build net list with pins
  const netLines = [];
  for (const [nodeIdx, { code, name }] of netMap.entries()) {
    const netNodeLines = [];

    // Find all components connected to this node and list their pins
    for (const comp of components) {
      const nodes = nodeOf(comp) || [];
      for (let pinIdx = 0; pinIdx < nodes.length; pinIdx++) {
        if (nodes[pinIdx] === nodeIdx) {
          const ref = comp.id || 'U1';
          netNodeLines.push(`    (node (ref "${ref}") (pin "${pinIdx + 1}"))`);
        }
      }
    }

    const nodeStmts = netNodeLines.length > 0
      ? '\n' + netNodeLines.join('\n') + '\n  '
      : ' ';

    netLines.push(
      `  (net (code "${code}") (name "${name}")${nodeStmts})`
    );
  }

  // Assemble full s-expression
  const result = [
    '(export (version "E")',
    '  (components',
    ...compLines.map(l => '    ' + l),
    '  )',
    '  (nets',
    ...netLines,
    '  )',
    ')',
  ].join('\n');

  return result;
}

/**
 * Save circuit to JSON with version and validation.
 * @param {Object} circuit - {components: [], wires: []}
 * @returns {string} JSON text
 */
export function saveJson(circuit) {
  const data = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    circuit: circuit || { components: [], wires: [] },
  };
  return JSON.stringify(data, null, 2);
}

/**
 * Load circuit from JSON text with validation.
 * @param {string} text - JSON
 * @returns {Object} {components, wires}
 */
export function loadJson(text) {
  const data = JSON.parse(text);

  if (!data.circuit) {
    throw new Error('JSON missing "circuit" field');
  }
  if (typeof data.circuit !== 'object') {
    throw new Error('circuit must be an object');
  }

  const { components = [], wires = [] } = data.circuit;

  if (!Array.isArray(components) || !Array.isArray(wires)) {
    throw new Error('components and wires must be arrays');
  }

  return { components, wires };
}

/**
 * Download text file (DOM helper). Guards against non-browser environments.
 * @param {string} filename - e.g. "circuit.cir"
 * @param {string} text - file contents
 */
export function downloadText(filename, text) {
  // Guard: if no window/document, skip (Node.js or test environment)
  if (typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
