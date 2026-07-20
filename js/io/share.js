// js/io/share.js
// Contract: encode/decode a circuit JSON payload for use in a shareable
// `#c=<payload>` URL hash.
//
// Payload format: "<version>.<base64url>"
//   version "1" — base64url of the DEFLATE-raw-compressed (CompressionStream)
//                 UTF-8 JSON text. Preferred: smaller URLs.
//   version "0" — base64url of the plain UTF-8 JSON text, uncompressed.
//                 Fallback for environments without CompressionStream/
//                 DecompressionStream (older browsers).
//
// Pure / Node-testable: no `window` dependency. CompressionStream and
// DecompressionStream are available in Node >= 18 (via the global `stream/web`
// exposure) as well as in all modern browsers, so the "1." path is exercised
// for real by tests, not just the "0." fallback.
//
// encodeCircuit(circuit) -> Promise<string>   e.g. "1.eJxTz..." or "0.eyJj..."
// decodeCircuit(payload) -> Promise<circuit>  throws on malformed/oversized input

const MAX_DECODED_BYTES = 100 * 1024; // ~100KB cap on decoded JSON text

const hasCompression = typeof CompressionStream !== 'undefined';
const hasDecompression = typeof DecompressionStream !== 'undefined';

// ---------------------------------------------------------------------------
// base64url helpers — operate on Uint8Array, no `window`/`btoa` dependency
// (works identically in Node and browsers).
// ---------------------------------------------------------------------------

function bytesToBase64url(bytes) {
  let binary = '';
  const chunkSize = 0x8000; // avoid call-stack blowups on large inputs
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const b64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

// ---------------------------------------------------------------------------
// compression helpers
// ---------------------------------------------------------------------------

// Piping through a Blob + Response (rather than manually pumping the
// writable/readable sides of the Compression/DecompressionStream) avoids
// unhandled-rejection races between the writer and reader promises, and
// gives us a straightforward single awaited arrayBuffer() at the end.
async function compressBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Serialize + compress (when available) a circuit into a URL-safe payload.
 * @param {Object} circuit - {components, wires}
 * @returns {Promise<string>} "<version>.<base64url>"
 */
export async function encodeCircuit(circuit) {
  const json = JSON.stringify(circuit || { components: [], wires: [] });
  const bytes = new TextEncoder().encode(json);

  if (hasCompression) {
    try {
      const compressed = await compressBytes(bytes);
      return `1.${bytesToBase64url(compressed)}`;
    } catch {
      // fall through to plain encoding below
    }
  }
  return `0.${bytesToBase64url(bytes)}`;
}

/**
 * Decode a share payload back into a circuit plain object.
 * Fails safe: throws a descriptive Error on any malformed/oversized/
 * unsupported input — callers should catch and fall back to normal startup.
 * @param {string} payload - "<version>.<base64url>"
 * @returns {Promise<Object>} {components, wires}
 */
export async function decodeCircuit(payload) {
  if (typeof payload !== 'string' || !payload) {
    throw new Error('Empty share payload');
  }
  const dot = payload.indexOf('.');
  if (dot < 0) throw new Error('Malformed share payload (missing version prefix)');
  const version = payload.slice(0, dot);
  const body = payload.slice(dot + 1);
  if (!body) throw new Error('Malformed share payload (empty body)');

  let bytes;
  try {
    bytes = base64urlToBytes(body);
  } catch {
    throw new Error('Malformed share payload (invalid base64url)');
  }

  let jsonBytes;
  if (version === '1') {
    if (!hasDecompression) throw new Error('Compressed share links are not supported in this browser');
    try {
      jsonBytes = await decompressBytes(bytes);
    } catch {
      throw new Error('Malformed share payload (decompression failed)');
    }
  } else if (version === '0') {
    jsonBytes = bytes;
  } else {
    throw new Error(`Unknown share payload version "${version}"`);
  }

  if (jsonBytes.length > MAX_DECODED_BYTES) {
    throw new Error(`Share payload too large (${jsonBytes.length} bytes, max ${MAX_DECODED_BYTES})`);
  }

  let json;
  try {
    json = new TextDecoder().decode(jsonBytes);
  } catch {
    throw new Error('Malformed share payload (invalid UTF-8)');
  }

  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Malformed share payload (invalid JSON)');
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Malformed share payload (expected an object)');
  }
  const { components = [], wires = [] } = data;
  if (!Array.isArray(components) || !Array.isArray(wires)) {
    throw new Error('Malformed share payload (components/wires must be arrays)');
  }
  return { components, wires };
}
