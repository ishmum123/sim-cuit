/*
 * Sim-cuit — js/ui/sketchpanel.js
 * ---------------------------------------------------------------------------
 * Everything about the ESP32 "Program (JS sketch)" UX: the compact CodeEditor
 * in the properties panel, the ⤢ Expand overlay (large CodeEditor + templates
 * + API reference sidebar + serial monitor footer), live GPIO pin badges, and
 * error-gutter mapping. Owns two CodeEditor instances (js/ui/codeeditor.js)
 * that stay in sync (same underlying "source") and both drive the exact same
 * upload/stop actions against whatever ComponentInstance is currently
 * selected.
 *
 * This module is DOM-heavy by nature (modal, editors, monitor) — the pure,
 * test-covered parts of the sketch UX live in codeeditor.js (tokenizer,
 * indent math) and js/engine/sketch.js (error-line mapping).
 *
 * Constructed once by js/ui/editor.js and driven via:
 *   panel.render(comp)        — call from _renderSketchSection(comp)
 *   panel.tick(comp, simTime) — call once per editor.tick() while comp (an
 *                                esp32) is selected; refreshes pin badges,
 *                                status, gutter error, and the serial monitor
 * ---------------------------------------------------------------------------
 */

import { CodeEditor } from './codeeditor.js';
import { SketchRuntime } from '../engine/sketch.js';
import { ComponentRegistry } from '../engine/components.js';

export const DEFAULT_SKETCH = `function setup() { pinMode(4, OUTPUT); }
function loop() {
  digitalWrite(4, HIGH); delay(500);
  digitalWrite(4, LOW);  delay(500);
}
`;

const TEMPLATES = [
  {
    id: 'blink', name: 'Blink', desc: 'Toggle GPIO4 every 500ms',
    code: DEFAULT_SKETCH,
  },
  {
    id: 'button', name: 'Read a button', desc: 'GPIO4 button gates the GPIO2 LED',
    code: `function setup() {
  pinMode(4, INPUT);
  pinMode(2, OUTPUT);
}
function loop() {
  var pressed = digitalRead(4) === HIGH;
  digitalWrite(2, pressed ? HIGH : LOW);
  delay(20);
}
`,
  },
  {
    id: 'serial', name: 'Serial demo', desc: 'print(millis()) once a second',
    code: `function setup() { print('booted'); }
function loop() {
  print(millis());
  delay(1000);
}
`,
  },
];

const API_DOCS = [
  { sig: 'pinMode(pin, INPUT|OUTPUT)', desc: 'Configure a GPIO pin’s direction.' },
  { sig: 'digitalWrite(pin, HIGH|LOW)', desc: 'Drive an OUTPUT pin high or low.' },
  { sig: 'digitalRead(pin)', desc: 'Read a pin: returns HIGH or LOW.' },
  { sig: 'analogRead(pin)', desc: 'Read a pin’s voltage, scaled 0–4095.' },
  { sig: 'delay(ms)', desc: 'Pause loop() for ms milliseconds.' },
  { sig: 'millis()', desc: 'Milliseconds since boot.' },
  { sig: 'print(...)', desc: 'Write a line to the serial monitor.' },
];

const GPIO_NAMES = ['GPIO2', 'GPIO4', 'GPIO5'];

function fmtTime(t) { return `${(t || 0).toFixed(2)}s`; }

export class SketchPanel {
  // hooks: { pushUndo(), showToast(msg, kind), notify() }
  constructor(hooks) {
    this.hooks = hooks || {};
    this.comp = null;
    this._overlayOpen = false;
    this._monitorAutoscroll = true;
    this._bind();
  }

  // -------------------------------------------------------------- binding

  _bind() {
    // ---- small (properties-panel) editor ----
    const panelHost = document.getElementById('sketch-editor-panel');
    this.panelPinsEl = document.getElementById('sketch-pins-panel');
    this.panelStatusEl = document.getElementById('sketch-status');
    this.panelErrorEl = document.getElementById('sketch-error');
    this.panelMonitorEl = document.getElementById('sketch-monitor');

    if (panelHost) {
      this.panelEditor = new CodeEditor(panelHost, { rows: 12, value: '', ariaLabel: 'ESP32 sketch source' });
      this.panelEditor.onSave(() => this.upload());
      this.panelEditor.onChange((src) => this._onEditorChange(this.panelEditor, src));
    }

    document.getElementById('sketch-upload')?.addEventListener('click', () => this.upload());
    document.getElementById('sketch-stop')?.addEventListener('click', () => this.stop());
    document.getElementById('sketch-expand')?.addEventListener('click', () => this.openOverlay());

    // ---- overlay editor ----
    this.overlayEl = document.getElementById('sketch-overlay');
    this.overlayTitleEl = document.getElementById('sketch-overlay-title');
    this.sidebarEl = document.getElementById('sketch-overlay-sidebar');
    this.overlayStatusEl = document.getElementById('sketch-overlay-status');
    this.overlayErrorEl = document.getElementById('sketch-overlay-error');
    this.overlayMonitorEl = document.getElementById('sketch-overlay-monitor');
    this.overlayPinsEl = document.getElementById('sketch-overlay-pins');

    const overlayHost = document.getElementById('sketch-editor-overlay');
    if (overlayHost) {
      this.overlayEditor = new CodeEditor(overlayHost, { value: '', ariaLabel: 'ESP32 sketch source (expanded editor)' });
      this.overlayEditor.container.classList.add('codeeditor-large');
      this.overlayEditor.onSave(() => this.upload());
      this.overlayEditor.onChange((src) => this._onEditorChange(this.overlayEditor, src));
    }

    document.getElementById('sketch-overlay-close')?.addEventListener('click', () => this.closeOverlay());
    document.getElementById('sketch-overlay-upload')?.addEventListener('click', () => this.upload());
    document.getElementById('sketch-overlay-stop')?.addEventListener('click', () => this.stop());
    document.getElementById('sketch-overlay-sidebar-toggle')?.addEventListener('click', () => this._toggleSidebar());
    document.getElementById('sketch-overlay-monitor-clear')?.addEventListener('click', () => this._clearMonitor());

    // Click on the dimmed backdrop (not the modal card itself) closes it.
    this.overlayEl?.addEventListener('mousedown', (e) => { if (e.target === this.overlayEl) this.closeOverlay(); });

    // GUARD (task item 6): every keystroke while the overlay is open — on
    // ANY focusable inside it, not just the two CodeEditor textareas — must
    // stop here and never reach js/ui/editor.js's window-level keydown
    // handler (canvas shortcuts: R rotate, Delete, Ctrl/Cmd+Z, etc.). This is
    // a plain BUBBLE-phase listener (not capture): target-level handlers
    // (CodeEditor's own Tab/Enter/Cmd+Enter logic, button activation) run
    // first and get first say; only afterward, right before the event would
    // bubble past this element up to `window`, do we intercept it. Escape is
    // special-cased to close the overlay; everything else is just swallowed.
    this.overlayEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeOverlay(); return; }
      e.stopPropagation();
    });

    this.overlayMonitorEl?.addEventListener('scroll', () => this._onMonitorScroll(this.overlayMonitorEl));
    this.panelMonitorEl?.addEventListener('scroll', () => this._onMonitorScroll(this.panelMonitorEl));

    this._buildSidebar();
  }

  _buildSidebar() {
    const listEl = document.getElementById('sketch-template-list');
    if (listEl) {
      listEl.innerHTML = '';
      for (const t of TEMPLATES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sketch-template-item';
        btn.innerHTML = `<span class="sketch-template-name">${t.name}</span><span class="sketch-template-desc">${t.desc}</span>`;
        btn.addEventListener('click', () => this._insertTemplate(t));
        listEl.appendChild(btn);
      }
    }
    const apiEl = document.getElementById('sketch-api-list');
    if (apiEl) {
      apiEl.innerHTML = API_DOCS.map((a) => (
        `<div class="sketch-api-item"><span class="sketch-api-sig">${a.sig}</span><span class="sketch-api-desc">${a.desc}</span></div>`
      )).join('');
    }
  }

  // ------------------------------------------------------------ rendering

  // Called from Editor#_renderSketchSection(comp) whenever the properties
  // panel re-renders for a selected ESP32 (selection change, undo/redo, …).
  render(comp) {
    const changedComp = this.comp !== comp;
    this.comp = comp;
    const src = (comp.params.sketch || DEFAULT_SKETCH);
    if (changedComp) {
      this._setBothValues(src);
      this._clearErrorUI();
      this._resetMonitor();
      if (this.overlayTitleEl) this.overlayTitleEl.textContent = `${comp.id} — ESP32 Sketch`;
    } else {
      // Same component re-rendering (e.g. an undo/redo restore changed
      // comp.params.sketch out from under an editor that isn't focused) —
      // resync without clobbering active typing.
      for (const ed of this._editors()) {
        const focused = document.activeElement === ed.textareaEl;
        if (!focused && ed.getValue() !== src) ed.setValue(src);
      }
    }
    this._updateStatusAndError(comp);
    this._updatePins(comp);
    this._updateMonitor(comp);
  }

  // Called once per Editor#tick() while an esp32 is selected — cheap refresh
  // of the live bits (pin badges / status / monitor) without touching editor
  // text, so typing is never disturbed.
  tick(comp, simTime) {
    this.comp = comp;
    this._updateStatusAndError(comp);
    this._updatePins(comp);
    this._updateMonitor(comp);
  }

  _editors() { return [this.panelEditor, this.overlayEditor].filter(Boolean); }

  _setBothValues(src) {
    for (const ed of this._editors()) ed.setValue(src);
  }

  // Live two-way sync: typing in either editor mirrors into the other
  // (whichever isn't focused) so "editing in the overlay and small panel
  // edits the SAME source" — this fires on every keystroke but is cheap for
  // sketch-sized sources.
  _onEditorChange(source, value) {
    for (const ed of this._editors()) {
      if (ed !== source && ed.getValue() !== value) ed.setValue(value);
    }
  }

  // --------------------------------------------------------------- upload

  upload() {
    const comp = this.comp;
    if (!comp || comp.type !== 'esp32') return;
    const src = (this.panelEditor || this.overlayEditor).getValue();
    this.hooks.pushUndo?.();
    comp.params.sketch = src;
    comp.params.sketchEnabled = true;
    // Dry-compile purely for immediate UI feedback (gutter highlight + toast)
    // — the engine constructs its own SketchRuntime from comp.params.sketch
    // on the next sim step regardless (see js/engine/components.js _tickSketch).
    const probe = new SketchRuntime(src);
    if (probe.status === 'error') {
      this._showError(probe.error, probe.errorLine);
      this.hooks.showToast?.(`Sketch compile error: ${probe.error}`, 'error');
    } else {
      this._clearErrorUI();
      this.hooks.showToast?.(`${comp.id}: sketch uploaded, running.`, 'ok');
    }
    this.hooks.notify?.();
  }

  stop() {
    const comp = this.comp;
    if (!comp || comp.type !== 'esp32') return;
    this.hooks.pushUndo?.();
    comp.params.sketchEnabled = false;
    this.hooks.showToast?.(`${comp.id}: sketch stopped.`, 'info');
    this.hooks.notify?.();
  }

  // ----------------------------------------------------------------- overlay

  openOverlay() {
    if (!this.comp || !this.overlayEl) return;
    this._overlayOpen = true;
    this.overlayEl.hidden = false;
    if (this.overlayEditor) this.overlayEditor.setValue((this.panelEditor || this.overlayEditor).getValue());
    this.overlayEditor?.focus();
  }

  closeOverlay() {
    if (!this.overlayEl) return;
    this._overlayOpen = false;
    this.overlayEl.hidden = true;
    // sync back into the small panel so it reflects whatever was typed
    if (this.panelEditor && this.overlayEditor) this.panelEditor.setValue(this.overlayEditor.getValue());
  }

  _toggleSidebar() {
    this.sidebarEl?.classList.toggle('collapsed');
    const btn = document.getElementById('sketch-overlay-sidebar-toggle');
    if (btn) btn.textContent = this.sidebarEl?.classList.contains('collapsed') ? 'Sidebar ▸' : 'Sidebar ◂';
  }

  _insertTemplate(t) {
    const ed = this.overlayEditor || this.panelEditor;
    if (!ed) return;
    const current = ed.getValue();
    const lastUploaded = (this.comp && this.comp.params.sketch) || '';
    if (current.trim() !== lastUploaded.trim() && current.trim() !== t.code.trim()) {
      const ok = window.confirm(`Replace the current sketch with the "${t.name}" template? Unsaved changes will be lost.`);
      if (!ok) return;
    }
    this._setBothValues(t.code);
  }

  // ------------------------------------------------------------- error UX

  _showError(message, line) {
    for (const ed of this._editors()) {
      if (line) ed.setError(line, message); else ed.clearError();
    }
    if (this.panelErrorEl) { this.panelErrorEl.hidden = false; this.panelErrorEl.textContent = message; }
    if (this.overlayErrorEl) { this.overlayErrorEl.hidden = false; this.overlayErrorEl.textContent = message; }
  }

  _clearErrorUI() {
    for (const ed of this._editors()) ed.clearError();
    if (this.panelErrorEl) { this.panelErrorEl.hidden = true; this.panelErrorEl.textContent = ''; }
    if (this.overlayErrorEl) { this.overlayErrorEl.hidden = true; this.overlayErrorEl.textContent = ''; }
  }

  _updateStatusAndError(comp) {
    const s = comp.state || {};
    const statusEls = [this.panelStatusEl, this.overlayStatusEl].filter(Boolean);
    if (!comp.params.sketchEnabled) {
      for (const el of statusEls) { el.textContent = 'Stopped'; el.className = 'sketch-status'; }
      this._clearErrorUI();
      return;
    }
    const status = s.sketchStatus || 'Stopped';
    const isError = s._sketch && s._sketch.status === 'error';
    for (const el of statusEls) {
      el.textContent = isError ? 'Error' : status;
      el.className = 'sketch-status' + (isError ? ' error' : status === 'Running' ? ' running' : '');
    }
    if (isError) this._showError(status, s.sketchErrorLine);
    else this._clearErrorUI();
  }

  // ----------------------------------------------------------------- pins

  _updatePins(comp) {
    const s = comp.state || {};
    const gpio = s.gpio || {};
    const powered = !s.brownout && !s.failed;
    const esp32Def = ComponentRegistry.esp32;
    const html = GPIO_NAMES.map((name) => {
      let cls = 'is-hiz';
      let label = '–'; // hi-Z dash: unpowered, failed, or genuinely an INPUT pin (not driven)
      // Reuses the engine's own mode resolution (js/engine/components.js
      // esp32._effectiveMode, folding in sketch pinMode() calls) so the
      // badge never disagrees with what's actually driving the pin.
      const mode = powered && esp32Def ? esp32Def._effectiveMode(comp, name) : 'input';
      if (powered && mode !== 'input') {
        const v = gpio[name];
        if (v !== undefined) {
          const high = v > 1.65;
          cls = high ? 'is-high' : 'is-low';
          label = high ? 'HIGH' : 'LOW';
        }
      }
      return `<span class="pin-badge ${cls}" title="${name}">${name}:${label}</span>`;
    }).join('');
    if (this.panelPinsEl) this.panelPinsEl.innerHTML = html;
    if (this.overlayPinsEl) this.overlayPinsEl.innerHTML = html;
  }

  // -------------------------------------------------------------- monitor

  _resetMonitor() {
    this._monitorAutoscroll = true;
    if (this.panelMonitorEl) this.panelMonitorEl.textContent = '';
    if (this.overlayMonitorEl) this.overlayMonitorEl.textContent = '';
  }

  _clearMonitor() {
    // "Clear" only clears the VISIBLE strip — the underlying engine log
    // (comp.state.sketchLog) keeps running so re-opening still shows history
    // pre-clear on the next full render(); this just resets what we've
    // rendered so far, matching a real serial monitor's "Clear" button.
    this._clearedAt = (this.comp && this.comp.state && this.comp.state.sketchLog) ? this.comp.state.sketchLog.length : 0;
    this._renderMonitorFrom(this.comp);
  }

  _onMonitorScroll(el) {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    this._monitorAutoscroll = atBottom;
  }

  _updateMonitor(comp) {
    this._renderMonitorFrom(comp);
  }

  _renderMonitorFrom(comp) {
    if (!comp) return;
    const s = comp.state || {};
    const log = s.sketchLog || [];
    const times = s.sketchLogTimes || [];
    const start = Math.min(this._clearedAt || 0, log.length);
    let text = '';
    for (let i = start; i < log.length; i++) {
      const t = times[i];
      text += (t === undefined ? log[i] : `[${fmtTime(t)}] ${log[i]}`) + '\n';
    }
    for (const el of [this.panelMonitorEl, this.overlayMonitorEl]) {
      if (!el) continue;
      if (el.textContent === text) continue;
      el.textContent = text;
      if (this._monitorAutoscroll) el.scrollTop = el.scrollHeight;
    }
  }
}
