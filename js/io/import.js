// js/io/import.js
// Contract: Import real parts from SPICE .model cards or JSON specs.
// Formats: .MODEL cards (D type → diode, LED detection by name/N parameter).
// JSON part specs (validate base, pass params/ratings).
// .SUBCKT: not supported in v1; throw cleanly.
// Pure functions, no DOM.

const ENGINEERING_MULTIPLIERS = {
  'p': 1e-12, 'f': 1e-15, 'a': 1e-18,
  'n': 1e-9,  'u': 1e-6, 'm': 1e-3,
  '': 1, 'k': 1e3, 'meg': 1e6, 'g': 1e9, 't': 1e12,
};

/**
 * Fetch and import parts from a URL.
 * CORS errors → friendly message asking user to paste.
 */
export async function importFromUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return importFromText(text);
  } catch (err) {
    throw new Error(
      `Failed to fetch from ${url}: ${err.message}.\n` +
      `Try copying the file contents and using "Paste" instead.`
    );
  }
}

/**
 * Import from text: auto-detect format (SPICE, JSON, or error on .SUBCKT).
 * Returns PartDef[] = [{name, base, params, ratings}, ...]
 */
export function importFromText(text) {
  const trimmed = text.trim();

  // Check for .SUBCKT
  if (/^\s*\.SUBCKT\b/i.test(trimmed)) {
    throw new Error('Subcircuits not yet supported — import .model cards or JSON specs');
  }

  // Try JSON first
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return parseJsonParts(obj);
    } catch (e) {
      throw new Error(`JSON parse error: ${e.message}`);
    }
  }

  // Try SPICE .MODEL cards
  if (/\.MODEL\b/i.test(trimmed)) {
    return parseSpiceModels(trimmed);
  }

  throw new Error('Unknown format: must be .MODEL card(s), JSON, or .SUBCKT (not supported)');
}

/**
 * Parse SPICE .MODEL cards (potentially multiple, with + continuations).
 * .MODEL D1N4148 D (IS=2.52e-9 RS=0.568 N=1.752 ...)
 * D type → diode base (IS→is, N→n, RS→rs, BV→maxReverseV)
 * LED detection: if name contains "LED" or N>2.5, map to "led" with vf calc
 */
function parseSpiceModels(text) {
  const parts = [];
  const lines = text.split('\n');
  let modelLines = [];
  let currentCard = null;

  // Merge continuation lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('*')) continue; // skip empty/comment

    if (/^\.MODEL\b/i.test(line)) {
      if (currentCard) {
        modelLines.push(currentCard);
      }
      currentCard = line;
    } else if (/^\+/i.test(line) && currentCard) {
      // continuation line (remove leading +)
      currentCard += ' ' + line.substring(1).trim();
    } else if (currentCard) {
      currentCard += ' ' + line;
    }
  }
  if (currentCard) {
    modelLines.push(currentCard);
  }

  // Parse each .MODEL line
  for (const line of modelLines) {
    const match = line.match(/^\.MODEL\s+(\S+)\s+([A-Za-z])\s*(.*)/i);
    if (!match) continue;

    const [, modelName, typeCode, paramsStr] = match;
    const typeCodeUpper = typeCode.toUpperCase();

    if (typeCodeUpper === 'D') {
      // Parse diode parameters
      const params = parseParameters(paramsStr);
      const isLed = isLedModel(modelName, params);

      const base = isLed ? 'led' : 'diode';
      const partDef = {
        name: modelName,
        base,
        params: {},
        ratings: {},
      };

      if (isLed) {
        // LED: compute vf from IS and N
        const is = params.is || params.IS || 1e-14;
        const n = params.n || params.N || 1.8;
        const vfCalc = n * 0.02585 * Math.log(0.02 / is);
        const vf = Math.max(1.6, Math.min(3.6, vfCalc));

        partDef.params = { vf, rs: params.rs || params.RS || 2 };
        partDef.ratings = {
          maxCurrent: 0.03,
          surgeCurrent: 0.1,
        };
      } else {
        // Regular diode
        partDef.params = {
          is: params.is || params.IS || 1e-14,
          n: params.n || params.N || 1.8,
          rs: params.rs || params.RS || 0,
        };
        partDef.ratings = {
          maxCurrent: 1,
          maxReverseV: params.bv || params.BV || 100,
        };
      }

      parts.push(partDef);
    }
  }

  return parts;
}

/**
 * Parse parameter string like "(IS=2.52e-9 RS=0.568 N=1.752 BV=100)"
 * or without parens. Values can have engineering suffixes (2.52n, 1.2k, etc).
 * Case-insensitive, returns lowercase keys.
 */
function parseParameters(paramsStr) {
  const params = {};
  // Remove parens if present
  let clean = paramsStr.trim();
  if (clean.startsWith('(')) clean = clean.substring(1);
  if (clean.endsWith(')')) clean = clean.substring(0, clean.length - 1);

  // Match K=V pairs, handling engineering suffixes
  const regex = /(\w+)\s*=\s*([-+]?[\d.eE+-]*\w*)/g;
  let match;
  while ((match = regex.exec(clean)) !== null) {
    const [, key, valueStr] = match;
    const val = parseEngineeringValue(valueStr);
    params[key.toLowerCase()] = val;
  }
  return params;
}

/**
 * Parse engineering suffix: "2.52n" → 2.52e-9, "1.2k" → 1200, "3MEG" → 3e6
 */
function parseEngineeringValue(str) {
  str = str.trim();
  const match = str.match(/^([-+]?[0-9.eE+-]+)([a-zA-Z]*)$/);
  if (!match) return parseFloat(str) || 0;

  const [, numStr, suffix] = match;
  const num = parseFloat(numStr);
  const mult = ENGINEERING_MULTIPLIERS[suffix.toLowerCase()] || 1;
  return num * mult;
}

/**
 * Detect if a model is an LED: name contains "LED", or N > 2.5
 */
function isLedModel(name, params) {
  if (/LED/i.test(name)) return true;
  const n = params.n || params.N;
  if (n && n > 2.5) return true;
  return false;
}

/**
 * Parse JSON parts: single object or array of objects.
 * Each must have {name, base, params?, ratings?}.
 * Validate base against allowlist.
 */
function parseJsonParts(obj) {
  const allowedBases = [
    'led', 'diode', 'resistor', 'capacitor', 'motor',
    'bulb', 'fuse', 'switch', 'battery', 'voltmeter',
    'ammeter', 'potentiometer', 'npn', 'pnp', 'nmos',
    'pmos', 'ground',
  ];

  const parts = Array.isArray(obj) ? obj : [obj];
  const defs = [];

  for (const item of parts) {
    if (!item.name || !item.base) {
      throw new Error('JSON part missing name or base field');
    }
    if (!allowedBases.includes(item.base)) {
      throw new Error(`Invalid base: "${item.base}". Allowed: ${allowedBases.join(', ')}`);
    }

    defs.push({
      name: item.name,
      base: item.base,
      params: item.params || {},
      ratings: item.ratings || {},
    });
  }

  return defs;
}
