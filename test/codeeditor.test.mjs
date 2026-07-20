// test/codeeditor.test.mjs
// Node.js test suite for the DOM-free, pure parts of the ESP32 sketch editor
// UX: js/ui/codeeditor.js's regex tokenizer + indent-math helpers, and
// js/engine/sketch.js's stack-line -> source-line error mapping.
// Run: node test/codeeditor.test.mjs
// Exit nonzero on failure.

import assert from 'assert';
import { tokenize, leadingWhitespace, autoIndentFor } from '../js/ui/codeeditor.js';
import { SketchRuntime, _internal } from '../js/engine/sketch.js';

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

function classesFor(src) {
  return tokenize(src).filter((t) => t.cls).map((t) => `${t.cls}:${t.text}`);
}

// ============================================================================
// tokenizer
// ============================================================================

await test('tokenize() reproduces the source exactly when tokens are concatenated', () => {
  const src = `function setup() { pinMode(4, OUTPUT); } // hi\nfunction loop() {\n  print("a", 42);\n}\n`;
  const joined = tokenize(src).map((t) => t.text).join('');
  assert.equal(joined, src);
});

await test('tokenize() classes a keyword, a call, an API name, a string, a number, and a comment', () => {
  const src = 'function loop() { print("hi", 42); delay(10); } // done';
  const cls = classesFor(src);
  assert.ok(cls.includes('tok-keyword:function'), `expected function keyword, got ${JSON.stringify(cls)}`);
  // "print" and "delay" are sketch-API calls => tok-api, not tok-call
  assert.ok(cls.includes('tok-api:print'), `expected print as api, got ${JSON.stringify(cls)}`);
  assert.ok(cls.includes('tok-api:delay'), `expected delay as api, got ${JSON.stringify(cls)}`);
  assert.ok(cls.includes('tok-string:"hi"'), `expected "hi" string, got ${JSON.stringify(cls)}`);
  assert.ok(cls.includes('tok-number:42'), `expected 42 number, got ${JSON.stringify(cls)}`);
  assert.ok(cls.includes('tok-number:10'), `expected 10 number, got ${JSON.stringify(cls)}`);
  assert.ok(cls.some((c) => c.startsWith('tok-comment:// done')), `expected line comment, got ${JSON.stringify(cls)}`);
});

await test('tokenize() classes a user-defined function call as tok-call, not tok-api', () => {
  const cls = classesFor('function helper() {} helper();');
  assert.ok(cls.includes('tok-call:helper'), `expected helper() as a plain call, got ${JSON.stringify(cls)}`);
  assert.ok(!cls.includes('tok-api:helper'), `helper() must not be misclassified as an API name`);
});

await test('tokenize() treats HIGH/LOW/INPUT/OUTPUT constants (not followed by "(") as tok-api', () => {
  const cls = classesFor('pinMode(4, OUTPUT); digitalWrite(4, HIGH);');
  assert.ok(cls.includes('tok-api:OUTPUT'));
  assert.ok(cls.includes('tok-api:HIGH'));
});

await test('tokenize() does not tokenize identifiers inside a string as code', () => {
  const cls = classesFor('print("delay(500) looks like code but is not");');
  assert.ok(!cls.some((c) => c === 'tok-api:delay'), `string contents must not be re-tokenized: ${JSON.stringify(cls)}`);
  assert.ok(cls.some((c) => c.startsWith('tok-string:')), `expected the whole string as one token`);
});

// ============================================================================
// indentation
// ============================================================================

await test('leadingWhitespace() extracts only leading spaces/tabs', () => {
  assert.equal(leadingWhitespace('    foo'), '    ');
  assert.equal(leadingWhitespace('foo'), '');
  assert.equal(leadingWhitespace('\tfoo'), '\t');
});

await test('autoIndentFor() carries forward the previous line\'s indent', () => {
  // cursor right after typing this line, BEFORE Enter is pressed (Enter is
  // what inserts the "\n" + the computed indent — see CodeEditor#_handleEnter)
  const value = '  digitalWrite(4, HIGH);';
  const pos = value.length;
  assert.equal(autoIndentFor(value, pos), '  ');
});

await test('autoIndentFor() adds two spaces after a line ending in "{"', () => {
  const value = 'function loop() {';
  const pos = value.length;
  assert.equal(autoIndentFor(value, pos), '  ');
});

await test('autoIndentFor() compounds nested indent + brace', () => {
  const value = '  if (x) {';
  const pos = value.length;
  assert.equal(autoIndentFor(value, pos), '    ');
});

await test('autoIndentFor() is computed relative to the cursor position, not the end of the string', () => {
  // "  foo();" then a newline then "bar();" with NO indent — if autoIndentFor
  // looked at the end of the whole string it would see the unindented "bar();"
  // and return ''; it must instead use the line the cursor is actually on.
  const value = '  foo();\nbar();';
  const posAfterFirstLine = value.indexOf('\n'); // cursor at end of "  foo();", pre-Enter
  assert.equal(autoIndentFor(value, posAfterFirstLine), '  ');
});

// ============================================================================
// error-line mapping (js/engine/sketch.js) — the wrapper-preamble math
// ============================================================================

await test('PREAMBLE_LINE_COUNT is a small positive constant', () => {
  assert.ok(Number.isInteger(_internal.PREAMBLE_LINE_COUNT) && _internal.PREAMBLE_LINE_COUNT > 0);
});

await test('a runtime ReferenceError on a known source line maps back to that line', () => {
  // line 1: function setup(){}
  // line 2: function loop() {
  // line 3:   undefinedThing.x;
  // line 4: }
  const src = 'function setup(){}\nfunction loop() {\n  undefinedThing.x;\n}\n';
  const rt = new SketchRuntime(src);
  assert.equal(rt.status, 'stopped', `expected a clean compile, got: ${rt.error}`);
  rt.tick(0);
  assert.equal(rt.status, 'error');
  assert.ok(/Runtime error in loop/.test(rt.error), rt.error);
  assert.equal(rt.errorLine, 3, `expected errorLine 3, got ${rt.errorLine} (error: ${rt.error})`);
});

await test('errorLine tracks the failing line across different line numbers (not hardcoded)', () => {
  const src = 'function setup(){}\nfunction loop() {\n\n\n  undefinedThing.x;\n}\n';
  const rt = new SketchRuntime(src);
  rt.tick(0);
  assert.equal(rt.status, 'error');
  assert.equal(rt.errorLine, 5);
});

await test('a compile-time SyntaxError (no <anonymous>:L:C stack frame) falls back to message-only (errorLine null)', () => {
  const rt = new SketchRuntime('function loop() { this is not valid js (((');
  assert.equal(rt.status, 'error');
  assert.equal(rt.errorLine, null);
  assert.ok(/Compile error/.test(rt.error));
});

await test('extractSourceLine() ignores an out-of-range recovered line instead of returning garbage', () => {
  const fakeErr = { stack: 'X\n    at Object.loop (eval at <anonymous> (foo), <anonymous>:9999:1)' };
  assert.equal(_internal.extractSourceLine(fakeErr, 4), null);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
