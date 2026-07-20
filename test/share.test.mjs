// test/share.test.mjs
// Node.js test suite for js/io/share.js — shareable-link encode/decode.
// Run: node test/share.test.mjs
// Exit nonzero on failure.

import assert from 'assert';
import { encodeCircuit, decodeCircuit } from '../js/io/share.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.stack || err.message}`);
    failCount++;
  }
}

const sampleCircuit = {
  components: [
    { id: 'V1', type: 'battery', x: 200, y: 300, rot: 90, params: { voltage: 9 }, ratings: {} },
    { id: 'R1', type: 'resistor', x: 480, y: 200, rot: 0, params: { resistance: 220 }, ratings: { maxPower: 0.25 } },
    { id: 'D1', type: 'led', x: 620, y: 300, rot: 90, params: { vf: 2.0 }, ratings: {} },
  ],
  wires: [
    { id: 'w1', points: [{ x: 200, y: 260 }, { x: 200, y: 200 }] },
  ],
};

// ============================================================================
await test('encodeCircuit/decodeCircuit round-trip (compressed "1." path)', async () => {
  const payload = await encodeCircuit(sampleCircuit);
  assert(typeof payload === 'string', 'payload should be a string');
  assert(payload.startsWith('1.'), `expected compressed "1." prefix, got "${payload.slice(0, 2)}"`);
  const decoded = await decodeCircuit(payload);
  assert.deepStrictEqual(decoded, sampleCircuit, 'decoded circuit should equal original');
});

// ============================================================================
await test('plain base64url "0." fallback round-trips', async () => {
  const json = JSON.stringify(sampleCircuit);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const payload = `0.${b64}`;
  const decoded = await decodeCircuit(payload);
  assert.deepStrictEqual(decoded, sampleCircuit, 'plain fallback should decode to original circuit');
});

// ============================================================================
await test('empty circuit round-trips', async () => {
  const empty = { components: [], wires: [] };
  const payload = await encodeCircuit(empty);
  const decoded = await decodeCircuit(payload);
  assert.deepStrictEqual(decoded, empty);
});

// ============================================================================
await test('malformed payload (no version prefix) rejects cleanly', async () => {
  await assert.rejects(() => decodeCircuit('not-a-valid-payload-at-all'), /version prefix/i);
});

// ============================================================================
await test('malformed payload (garbage base64 body) rejects cleanly', async () => {
  await assert.rejects(() => decodeCircuit('1.@@@not-base64@@@'));
});

// ============================================================================
await test('malformed payload (valid base64 but not real compressed data) rejects cleanly', async () => {
  const bogus = Buffer.from('this is not deflate data', 'utf8').toString('base64url');
  await assert.rejects(() => decodeCircuit(`1.${bogus}`), /decompress/i);
});

// ============================================================================
await test('unknown version prefix rejects cleanly', async () => {
  const b64 = Buffer.from('{}', 'utf8').toString('base64url');
  await assert.rejects(() => decodeCircuit(`9.${b64}`), /version/i);
});

// ============================================================================
await test('empty/non-string payload rejects cleanly', async () => {
  await assert.rejects(() => decodeCircuit(''));
  await assert.rejects(() => decodeCircuit(undefined));
});

// ============================================================================
await test('size cap enforced (oversized decoded payload rejected)', async () => {
  // Build a circuit whose JSON, once decoded from the "0." plain fallback,
  // exceeds the ~100KB cap. Use a highly-compressible field so this also
  // proves the cap applies to *decoded* size, not encoded/compressed size.
  const huge = { components: [], wires: [], junk: 'x'.repeat(200 * 1024) };
  const json = JSON.stringify(huge);
  const payload = `0.${Buffer.from(json, 'utf8').toString('base64url')}`;
  await assert.rejects(() => decodeCircuit(payload), /too large/i);
});

// ============================================================================
await test('size cap also enforced on the compressed "1." path (post-decompression)', async () => {
  const huge = { components: [], wires: [], junk: 'x'.repeat(200 * 1024) };
  const payload = await encodeCircuit(huge);
  assert(payload.startsWith('1.'));
  await assert.rejects(() => decodeCircuit(payload), /too large/i);
});

// ============================================================================
await test('version prefix respected: "0." body is treated as plain, not decompressed', async () => {
  // A "0." payload whose body happens to *also* be valid deflate-raw bytes
  // must still be read as plain JSON, not decompressed, since the version
  // prefix says so.
  const json = JSON.stringify({ components: [], wires: [] });
  const payload = `0.${Buffer.from(json, 'utf8').toString('base64url')}`;
  const decoded = await decodeCircuit(payload);
  assert.deepStrictEqual(decoded, { components: [], wires: [] });
});

// ============================================================================
await test('rejects non-object decoded JSON (e.g. an array or a string)', async () => {
  const arrPayload = `0.${Buffer.from('[1,2,3]', 'utf8').toString('base64url')}`;
  await assert.rejects(() => decodeCircuit(arrPayload), /object/i);

  const strPayload = `0.${Buffer.from('"hello"', 'utf8').toString('base64url')}`;
  await assert.rejects(() => decodeCircuit(strPayload));
});

// ============================================================================
await test('rejects JSON object whose components/wires are not arrays', async () => {
  const bad = JSON.stringify({ components: 'nope', wires: [] });
  const payload = `0.${Buffer.from(bad, 'utf8').toString('base64url')}`;
  await assert.rejects(() => decodeCircuit(payload), /array/i);
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
