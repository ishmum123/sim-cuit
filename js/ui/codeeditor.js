/*
 * Sim-cuit — js/ui/codeeditor.js
 * ---------------------------------------------------------------------------
 * Reusable, dependency-free JS code editor widget: the classic transparent-
 * textarea-over-highlighted-<pre> trick. A <textarea> with transparent text
 * (but a visible caret) sits directly on top of a <pre><code> that renders
 * the SAME text run through a small regex tokenizer. Both scroll together;
 * a line-number gutter scrolls with them too.
 *
 * This file intentionally keeps the tokenizer (`tokenize`) and the
 * indentation helpers as PURE functions exported alongside the class, so
 * test/codeeditor.test.mjs can exercise them under plain Node without a DOM.
 *
 * Usage:
 *   const ed = new CodeEditor(containerEl, { value, rows });
 *   ed.onChange(src => ...)
 *   ed.onSave(() => ...)         // Cmd/Ctrl+Enter
 *   ed.getValue() / ed.setValue(src)
 *   ed.setError(line, message)  // line: 1-based, or null to clear
 *   ed.clearError()
 *   ed.focus()
 *   ed.destroy()
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------- tokenizer
//
// Regex-based, single-pass, order-sensitive (comments/strings win over
// everything else inside them). Not a real JS parser — good enough for
// syntax-color hinting on a small sketch, not for correctness-critical use.
//
// Returns an array of { text, cls } tokens (cls === null for plain text)
// that, concatenated, reproduce the input EXACTLY — callers rely on this to
// keep the <pre> and <textarea> character-for-character identical.

const KEYWORDS = new Set([
  'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue',
  'var', 'let', 'const', 'true', 'false', 'null', 'undefined', 'new', 'typeof',
  'instanceof', 'in', 'of', 'switch', 'case', 'default', 'try', 'catch', 'finally',
  'throw', 'this', 'void', 'delete',
]);

// The sketch runtime's API surface (js/engine/sketch.js) — highlighted as a
// distinct class so the handful of functions/constants a sketch actually
// calls stand out from ordinary identifiers.
const API_NAMES = new Set([
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'millis', 'delay',
  'print', 'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'setup', 'loop',
]);

// Order matters: earlier alternatives win when they start at the same index.
const TOKEN_RE = new RegExp(
  [
    '(\\/\\/[^\\n]*)', // 1 line comment
    '(\\/\\*[\\s\\S]*?\\*\\/)', // 2 block comment
    '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)', // 3 string
    '(\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b)', // 4 number
    '([A-Za-z_$][A-Za-z0-9_$]*)(?=\\s*\\()', // 5 identifier followed by '(' => call
    '([A-Za-z_$][A-Za-z0-9_$]*)', // 6 identifier
  ].join('|'),
  'g',
);

export function tokenize(src) {
  const tokens = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src))) {
    if (m.index > last) tokens.push({ text: src.slice(last, m.index), cls: null });
    const text = m[0];
    let cls;
    if (m[1]) cls = 'tok-comment';
    else if (m[2]) cls = 'tok-comment';
    else if (m[3]) cls = 'tok-string';
    else if (m[4]) cls = 'tok-number';
    else if (m[5]) cls = API_NAMES.has(m[5]) ? 'tok-api' : 'tok-call';
    else if (m[6]) cls = API_NAMES.has(m[6]) ? 'tok-api' : (KEYWORDS.has(m[6]) ? 'tok-keyword' : null);
    tokens.push({ text, cls });
    last = TOKEN_RE.lastIndex;
  }
  if (last < src.length) tokens.push({ text: src.slice(last), cls: null });
  return tokens;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightToHtml(src) {
  let html = '';
  for (const t of tokenize(src)) {
    html += t.cls ? `<span class="${t.cls}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text);
  }
  // A trailing newline needs an extra blank line rendered in <pre> to keep
  // scrollHeight identical to the textarea (browsers collapse a lone
  // trailing \n's final empty line unless there's *something* after it).
  return html + '\n';
}

// -------------------------------------------------------------- indentation

// Leading whitespace of `line`.
export function leadingWhitespace(line) {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

// Compute the auto-indent to insert after Enter is pressed at `pos` in
// `value`, given the previous line's leading whitespace (+2 more spaces if
// that previous line's trailing non-whitespace character is '{').
export function autoIndentFor(value, pos) {
  const before = value.slice(0, pos);
  const lineStart = before.lastIndexOf('\n') + 1;
  const prevLine = before.slice(lineStart);
  let indent = leadingWhitespace(prevLine);
  const trimmed = prevLine.trimEnd();
  if (trimmed.endsWith('{')) indent += '  ';
  return indent;
}

// -------------------------------------------------------------- CodeEditor

let uid = 0;

export class CodeEditor {
  constructor(container, opts = {}) {
    this.container = container;
    this._changeCbs = [];
    this._saveCbs = [];
    this._errorLine = null;
    this._errorMsg = '';
    this._id = `codeeditor-${++uid}`;

    container.classList.add('codeeditor');
    container.innerHTML = `
      <div class="codeeditor-gutter" aria-hidden="true"><div class="codeeditor-gutter-inner"></div></div>
      <div class="codeeditor-scroller">
        <pre class="codeeditor-pre" aria-hidden="true"><code class="codeeditor-code"></code></pre>
        <textarea class="codeeditor-textarea" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off"></textarea>
      </div>
    `;
    this.gutterOuterEl = container.querySelector('.codeeditor-gutter');
    this.gutterEl = container.querySelector('.codeeditor-gutter-inner');
    this.scrollerEl = container.querySelector('.codeeditor-scroller');
    this.preEl = container.querySelector('.codeeditor-pre');
    this.codeEl = container.querySelector('.codeeditor-code');
    this.textareaEl = container.querySelector('.codeeditor-textarea');

    if (opts.rows) container.style.setProperty('--codeeditor-rows', String(opts.rows));
    if (opts.ariaLabel) this.textareaEl.setAttribute('aria-label', opts.ariaLabel);

    this.textareaEl.value = opts.value || '';
    this._render();

    this.textareaEl.addEventListener('input', () => { this._render(); this._emitChange(); });
    this.textareaEl.addEventListener('scroll', () => this._syncScroll());
    this.textareaEl.addEventListener('keydown', (e) => this._onKeyDown(e));
    // Keep gutter/pre synced with textarea scroll on resize too (wrapping
    // never happens — horizontal overflow only — but a container resize can
    // still change scrollTop if content re-wraps... it never does here, but
    // this is cheap insurance).
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this._syncScroll());
      this._ro.observe(this.scrollerEl);
    }
  }

  // -------------------------------------------------------------- public

  getValue() { return this.textareaEl.value; }

  setValue(src) {
    this.textareaEl.value = src || '';
    this._render();
  }

  onChange(cb) { this._changeCbs.push(cb); }

  onSave(cb) { this._saveCbs.push(cb); }

  focus() { this.textareaEl.focus(); }

  setError(line, message = '') {
    this._errorLine = line || null;
    this._errorMsg = message;
    this._renderGutter();
  }

  clearError() { this.setError(null, ''); }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this.container.innerHTML = '';
    this.container.classList.remove('codeeditor');
  }

  // ------------------------------------------------------------- internal

  _emitChange() { for (const cb of this._changeCbs) cb(this.getValue()); }

  _render() {
    this.codeEl.innerHTML = highlightToHtml(this.textareaEl.value);
    this._renderGutter();
    this._syncScroll();
  }

  _renderGutter() {
    const lineCount = (this.textareaEl.value.match(/\n/g) || []).length + 1;
    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      const isErr = i === this._errorLine;
      html += `<div class="codeeditor-gutter-line${isErr ? ' is-error' : ''}"${isErr && this._errorMsg ? ` title="${escapeHtml(this._errorMsg)}"` : ''}>${i}</div>`;
    }
    this.gutterEl.innerHTML = html;
  }

  _syncScroll() {
    const top = this.textareaEl.scrollTop;
    const left = this.textareaEl.scrollLeft;
    this.preEl.style.transform = `translate(${-left}px, ${-top}px)`;
    this.gutterEl.style.transform = `translateY(${-top}px)`;
  }

  _onKeyDown(e) {
    // Cmd/Ctrl+Enter => save/upload, doesn't insert a newline.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      for (const cb of this._saveCbs) cb(this.getValue());
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this._handleTab(e.shiftKey);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this._handleEnter();
      return;
    }
  }

  _handleTab(dedent) {
    const ta = this.textareaEl;
    const { selectionStart: start, selectionEnd: end, value } = ta;
    if (start === end && !dedent) {
      // simple insert-at-caret
      ta.value = value.slice(0, start) + '  ' + value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      this._render();
      this._emitChange();
      return;
    }
    // multi-line (or shift-tab) indent/dedent over the selected line range
    const firstLineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lastLineEnd = value.indexOf('\n', end);
    if (lastLineEnd === -1) lastLineEnd = value.length;
    const block = value.slice(firstLineStart, lastLineEnd);
    const lines = block.split('\n');
    let firstLineDelta = 0;
    const newLines = lines.map((line, i) => {
      if (dedent) {
        if (line.startsWith('  ')) { if (i === 0) firstLineDelta = -2; return line.slice(2); }
        if (line.startsWith(' ')) { if (i === 0) firstLineDelta = -1; return line.slice(1); }
        return line;
      }
      if (i === 0) firstLineDelta = 2;
      return '  ' + line;
    });
    const newBlock = newLines.join('\n');
    ta.value = value.slice(0, firstLineStart) + newBlock + value.slice(lastLineEnd);
    ta.selectionStart = Math.max(firstLineStart, start + firstLineDelta);
    ta.selectionEnd = firstLineStart + newBlock.length;
    this._render();
    this._emitChange();
  }

  _handleEnter() {
    const ta = this.textareaEl;
    const { selectionStart: start, selectionEnd: end, value } = ta;
    const indent = autoIndentFor(value, start);
    const insert = '\n' + indent;
    ta.value = value.slice(0, start) + insert + value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + insert.length;
    this._render();
    this._emitChange();
  }
}
