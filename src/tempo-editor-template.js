import { tempoFieldStyle } from './tempo-fields.js';
import { editorStyle } from './tempo-editor-style.js';

export function editorTemplate() {
  return `
      <style>${editorStyle}${tempoFieldStyle}
.editor-lanes,.pitch-options{display:flex;align-items:center;gap:8px;margin:12px 0;flex-wrap:wrap}
.editor-lanes [aria-pressed="true"]{color:var(--tempo-fg);border-color:var(--tempo-accent)}
</style>
      <header><strong>Tempo timeline</strong><button class="editor-close" type="button">Close</button></header>
      <a class="editor-track" target="_blank" rel="noopener noreferrer"></a>
      <output class="playback-state" aria-live="polite"></output>
      <label class="editor-enable" hidden><input class="editor-enabled" type="checkbox">Use saved timeline</label>
      <div class="editor-lanes" role="group" aria-label="Automation lane"><button type="button" data-lane="tempo" aria-pressed="true">Tempo</button><button type="button" data-lane="pitch" aria-pressed="false">Pitch</button></div>
      <div class="pitch-options" hidden><label>Arrow step <input class="pitch-step" type="number" min="0.001" max="12" step="0.1" value="0.5"> st</label><button type="button" class="pitch-clear">Remove pitch automation</button></div>
      <div class="editor-toolbar">
        <button class="zoom-out" type="button" aria-label="Zoom out timeline">−</button>
        <button class="zoom-in" type="button" aria-label="Zoom in timeline">+</button>
        <button class="zoom-fit" type="button">Fit</button>
        <button class="zoom-focus" type="button">Focus fade</button>
        <output class="zoom-label"></output>
        <label>Speed range<select class="speed-range" aria-label="Graph speed range"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option><option value="fine">Close · 0.1× grid</option><option value="close">Closer · 0.05× grid</option><option value="custom" selected>Custom</option></select></label>
        <div class="speed-bounds">
          <label>Min <input class="speed-min" type="number" min="0.25" max="4" step="0.001" value="0.75" aria-label="Graph minimum value"><span class="axis-unit">×</span></label>
          <label>Max <input class="speed-max" type="number" min="0.25" max="4" step="0.001" value="1.5" aria-label="Graph maximum value"><span class="axis-unit">×</span></label>
        </div>
      </div>
      <svg class="editor-graph" viewBox="0 0 660 220" preserveAspectRatio="none" role="group" aria-label="Tempo over original song time"></svg>
      <div class="timeline-navigation" hidden>
        <div class="editor-readout"><label for="timeline-pan">Scroll timeline</label><output class="view-window" for="timeline-pan"></output></div>
        <input id="timeline-pan" class="editor-pan" type="range" min="0" max="0" step="0.01" value="0">
        <div class="timeline-limits" aria-hidden="true"><span>0:00</span><span class="timeline-end"></span></div>
      </div>
      <div class="editor-readout"><span class="point-readout"></span></div>
      <label>Point <select class="editor-point-picker" aria-label="Selected tempo point"></select></label>
      <div class="editor-fields">
        <label>Reach at (seconds)<input class="point-time" type="number" min="0" step="0.1"></label>
        <label><span class="target-label">Target speed</span><input class="point-rate" type="number" min="0.25" max="4" step="0.025"></label>
        <label>Fade duration (seconds)<input class="point-duration" type="number" min="0" step="0.1"></label>
        <label>Transition<select class="point-curve"><option value="instant">Instant</option><option value="linear">Linear</option><option value="ease-in">Ease-in</option><option value="ease-out">Ease-out</option><option value="smooth">Smooth</option></select></label>
      </div>
      <div class="point-actions">
        <button class="point-add" type="button">Add at playhead</button>
        <button class="point-remove" type="button">Remove point</button>
      </div>
      <label class="editor-pitch-label">Pitch<select class="editor-pitch"><option value="natural">Natural</option><option value="preserve">Preserve key</option></select></label>
      <label class="editor-pitch-label">Key shift<input class="editor-key-shift" type="number" min="-12" max="12" step="0.5" value="0"> semitones</label>
      <div class="editor-actions">
        <button class="editor-revert" type="button" hidden>Discard edits</button>
        <button class="editor-link" type="button">Copy link</button>
        <button class="editor-apply-once" type="button" aria-pressed="false">Apply once</button>
        <button class="editor-save primary" type="button">Save timeline</button>
      </div>
      <details class="editor-sharing">
        <summary>Advanced sharing</summary>
        <button class="editor-copy" type="button">Copy code</button>
        <label>Import link or code<textarea class="editor-code" spellcheck="false" placeholder="Paste a tempo link or SCT1 code"></textarea></label>
        <div class="editor-actions">
          <button class="editor-preview" type="button" disabled>Preview import</button>
          <button class="editor-import" type="button" hidden>Load preview as draft</button>
        </div>
        <p class="import-summary"></p>
        <label class="editor-output" hidden>Copy manually<textarea class="share-output" readonly spellcheck="false"></textarea></label>
      </details>
      <p class="editor-status" role="status" aria-live="polite"></p>
    `;
}
