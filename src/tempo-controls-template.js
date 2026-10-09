import { controlsStyle } from './tempo-controls-style.js';

function dialTicks() {
  return Array.from({ length: 17 }, (_, index) => {
    const angle = ((index / 16) * 270 - 135) * Math.PI / 180;
    const inner = index % 4 === 0 ? 12 : 14;
    const point = (radius) => `${(16 + Math.sin(angle) * radius).toFixed(2)} ${(16 - Math.cos(angle) * radius).toFixed(2)}`;
    return `M${point(inner)}L${point(16)}`;
  }).join('');
}

function faderTicks() {
  return Array.from({ length: 16 }, (_, index) => {
    const y = (6 + index / 15 * 132).toFixed(2);
    return `M25 ${y}h${index % 4 === 0 || index === 15 ? 6 : 3}`;
  }).join('');
}

export function controlsTemplate({
  MIN,
  MAX,
  SLIDER_MAX,
  SLIDER_STEP,
  SLIDER_STEPS,
  sliderTicks,
}) {
  return `
      <style>${controlsStyle}</style>
      <div class="controls" role="group" aria-label="Playback tempo">
        <div class="field"
          ><input
            id="rate-number"
            type="number"
            min="${MIN}"
            max="4"
            step="0.001"
            aria-label="Exact playback speed"
            aria-describedby="number-help"
          /><span class="unit" aria-hidden="true">×</span
          ><span class="error" hidden aria-label="Playback error">!</span></div
        >
        <div class="steppers">
          <button
            class="step step-up"
            type="button"
            aria-label="Increase speed by 0.025×; Shift for 0.01×"
            title="Increase tempo"
          >
            <svg viewBox="0 0 10 8" aria-hidden="true"><path d="m2 5 3-3 3 3" /></svg>
          </button>
          <button
            class="step step-down"
            type="button"
            aria-label="Decrease speed by 0.025×; Shift for 0.01×"
            title="Decrease tempo"
          >
            <svg viewBox="0 0 10 8" aria-hidden="true"><path d="m2 3 3 3 3-3" /></svg>
          </button>
        </div>
        <div class="slider-wrap"
          ><button id="rate-dial" type="button" role="slider" aria-label="Playback speed dial" aria-valuemin="${MIN}" aria-valuemax="${MAX}" aria-valuenow="1" aria-describedby="dial-help" title="Drag up or down · Shift for fine adjustment · Double-click to reset" hidden><svg viewBox="0 0 32 32" aria-hidden="true"><path class="dial-track" d="M6.1 25.9a14 14 0 1 1 19.8 0"/><path class="dial-fill" pathLength="100" d="M6.1 25.9a14 14 0 1 1 19.8 0"/><path class="dial-ticks" d="${dialTicks()}"/><circle cx="16" cy="16" r="9"/><path class="dial-zero" d="M16 0v4"/></svg><span aria-hidden="true"></span></button>
          <button id="vertical-toggle" type="button" popovertarget="tempo-fader" aria-label="Open vertical tempo slider" title="Tempo slider" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v5m0 6v5M6 7h8v6H6Z" /></svg></button>
          <div id="tempo-fader"><output class="fader-value" aria-hidden="true">1×</output><div class="fader-rail"><input
            id="rate-slider"
            type="range"
            min="${MIN}"
            max="${SLIDER_MAX}"
            step="${SLIDER_STEP}"
            aria-label="Playback speed"
            aria-describedby="slider-help" />
          <svg class="ticks" viewBox="0 0 ${SLIDER_STEPS} 5" preserveAspectRatio="none" aria-hidden="true">
            <path d="${sliderTicks()}" />
            <path class="normal-tick" d="M${Math.round((1 - MIN) / SLIDER_STEP)} 0v5" />
          </svg>
          <span class="fader-normal" aria-hidden="true">1×</span>
          <svg class="fader-ticks" viewBox="0 0 32 144" aria-hidden="true"><path d="${faderTicks()}"/></svg>
          <span class="fader-level" style="--position:0.533333" aria-hidden="true">2×</span>
          <span class="fader-level" style="--position:0.266667" aria-hidden="true">3×</span>
          <span class="fader-limit fader-max" aria-hidden="true">4×</span>
          <span class="fader-limit fader-min" aria-hidden="true">.25×</span>
          </div>
          <button class="fader-reset" type="button">Reset</button>
          </div>
        </div>
        <label class="quick-key">Pitch <input id="quick-key-shift" type="number" min="-12" max="12" step="0.5" value="0" aria-label="Key shift in semitones"><span class="key-unit" aria-hidden="true">st</span></label>
        <button
          class="memory"
          type="button"
          aria-label="Remember tempo for this track"
          aria-pressed="false"
          aria-haspopup="dialog"
          aria-controls="tempo-settings"
          aria-expanded="false"
          ><svg viewBox="0 0 16 16" aria-hidden="true">
            <path class="bookmark" d="M4 2h8v12l-4-3-4 3Z" />
            <circle class="update-dot" cx="13" cy="3" r="2" />
            <path class="check" d="m3 8 3 3 7-7" />
            <path class="warning" d="M8 2 15 14H1Z M8 6v3 M8 11.5v.1" /></svg
        ></button>
        <button
          class="settings-button"
          type="button"
          aria-label="Tempo settings"
          title="Settings"
          aria-haspopup="dialog"
          aria-controls="tempo-settings"
          aria-expanded="false"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="m6 1-.4 2-1.2.7-1.9-.6-2 3.4L2 8l-1.5 1.5 2 3.4 1.9-.6 1.2.7.4 2h4l.4-2 1.2-.7 1.9.6 2-3.4L14 8l1.5-1.5-2-3.4-1.9.6-1.2-.7L10 1Z"
            />
            <circle cx="8" cy="8" r="2.3" />
          </svg>
        </button>
        <span class="sr-only" id="number-help">${MIN} to ${MAX}×. Double-click to reset.</span>
        <span class="sr-only" id="slider-help">Arrow keys use your default tempo increment. Double-click to reset.</span>
        <span class="sr-only" id="dial-help">Drag up to speed up, down to slow down. Hold Shift for fine adjustment. Double-click to reset to 1×. Arrow keys use your default tempo increment.</span>
        <span
          class="sr-only status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        ></span>
      </div>
      <section
        id="tempo-settings"
        class="settings"
        role="dialog"
        popover="manual"
        aria-labelledby="settings-title"
        hidden
      >
        <header
          ><strong id="settings-title">Tempo settings</strong
          ><div class="settings-actions"><button class="open-editor" type="button">Tempo editor</button><button class="close-settings" type="button" aria-label="Close tempo settings"
            >Close</button
          ></div></header
        >
        <p class="control-setup-intro" hidden>Choose a tempo control and whether to show semitone adjustment. You can change both later in Appearance.</p>
        <div class="quick-settings">
        <label class="random-label"
          ><input id="apply-saved" type="checkbox" checked />Apply saved tempos</label
        >
        <label class="random-label"><input id="copy-tempo-links" type="checkbox" />Include tempo in copied links</label>
        </div>
        <input
          id="saved-filter"
          type="search"
          placeholder="Find a saved track…"
          aria-label="Find a saved track"
        />
        <p class="saved-count"></p>
        <div class="saved-list" role="region" aria-label="Saved tracks"></div>
        <button class="saved-more" type="button" hidden>Show 100 more</button>
        <div class="settings-tools">
        <details class="appearance-settings">
          <summary>Appearance</summary>
          <label class="random-label"><input id="show-key" type="checkbox" checked />Show semitone adjustment in player</label>
          <label class="control-style-label">Tempo control <select id="control-style"><option value="slider">Slider</option><option value="dial">Dial</option><option value="vertical">Vertical slider</option></select></label>
          <label class="increment-label">Default tempo increment <input id="tempo-increment" type="number" min="0.001" max="1" step="0.001" value="0.025" aria-label="Default tempo increment"> ×</label>
          <fieldset class="appearance-options" aria-label="SoundCloud theme">
            <label><input type="radio" name="appearance" value="native" checked>SoundCloud</label>
            <label><input type="radio" name="appearance" value="charcoal">Charcoal</label>
            <label><input type="radio" name="appearance" value="oled">OLED</label>
          </fieldset>
          <label class="random-label"><input id="star-motion" type="checkbox" />Star motion</label>
          <label class="output-label" for="star-speed">Star speed <output id="star-speed-value">2×</output></label>
          <input id="star-speed" type="range" min="0.5" max="4" step="0.25" value="2" aria-label="Star motion speed" />
        </details>
        <details class="advanced-audio">
          <summary>Advanced audio</summary>
          <label class="random-label"><input id="crossfade" type="checkbox" />Crossfade tracks</label>
          <label class="output-label" for="crossfade-seconds">Overlap <output id="crossfade-value">5 seconds</output></label>
          <input id="crossfade-seconds" type="range" min="1" max="10" step="1" value="5" aria-label="Crossfade duration in seconds" />
          <p id="crossfade-status" role="status"></p>
          <details class="crossfade-debug">
            <summary>Crossfade diagnostics</summary>
            <pre id="crossfade-debug-output" tabindex="0" aria-label="Crossfade diagnostics"></pre>
            <button id="crossfade-debug-refresh" type="button">Refresh</button>
            <button id="crossfade-debug-copy" type="button">Copy diagnostics</button>
            <p id="crossfade-debug-feedback" role="status"></p>
          </details>
          <details class="pitch-customization"><summary>Semitone controls</summary><div class="pitch-bounds"><label>Minimum <input id="pitch-min" type="number" min="-12" max="12" step="0.5" value="-12"><span>st</span></label><label>Maximum <input id="pitch-max" type="number" min="-12" max="12" step="0.5" value="12"><span>st</span></label><label>Default increment <input id="pitch-step" type="number" min="0.001" max="12" step="0.1" value="0.5"><span>st</span></label></div></details>
          <label class="key-shift-label">Semitone shift <input id="key-shift" type="number" min="-12" max="12" step="0.5" value="0" /> st</label>
          <label class="random-label"
            ><input id="preserve-key" type="checkbox" />Preserve key by default</label
          >
          <p id="pitch-mode-help"
            >Timelines can use their own pitch mode.</p
          >
          <p id="wasm-status" role="status"></p>
          <label class="random-label"><input id="use-wasm" type="checkbox" />Use WASM for Preserve key</label>
          <label class="output-label" for="output-value">Output level <span class="output-entry"><input id="output-value" type="number" min="-24" step="any" value="-6" aria-describedby="output-help" /> dB</span></label>
          <input id="output-level" type="range" min="-24" max="12" step="0.1" value="-6" aria-label="Output level in dB" aria-describedby="output-help" />
          <p id="output-help">Above 0 dB can clip and become very loud. Start low.</p>
          <p id="output-status" role="status"></p>
        </details>
        <details class="shortcuts">
          <summary>Shortcuts</summary>
          <p>Double-click speed or slider: reset to 1×.<br>Shift-click arrows: 0.01× steps.<br>Alt+Shift+Left/Right: 0.05× steps.<br>Alt+Shift+Down: reset.</p>
        </details>
        <details class="library-backup">
          <summary>Backup</summary>
          <div class="backup-actions">
            <button class="backup-export" type="button">Export backup</button>
            <button class="backup-import" type="button">Import backup</button>
          </div>
          <input class="backup-file" type="file" accept=".json,application/json" aria-label="Choose a Tempo Control backup" hidden />
          <div class="backup-preview" hidden>
            <p class="backup-summary"></p>
            <p class="backup-preferences"></p>
            <div class="backup-actions">
              <button class="backup-confirm" type="button">Confirm import</button>
              <button class="backup-cancel" type="button">Cancel</button>
            </div>
          </div>
        </details>
        </div>
        <p class="settings-status" role="status" aria-live="polite"></p>
        <button class="saved-undo" type="button" hidden>Undo removal</button>
      </section>
    `;
}
