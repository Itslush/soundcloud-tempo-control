import { controlsStyle } from './tempo-controls-style.js';

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
          ><input
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
        </div>
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
        <span class="sr-only" id="slider-help">Steps of 0.025×. Double-click to reset.</span>
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
        <div class="quick-settings">
        <label class="random-label"
          ><input id="random-saved" type="checkbox" />50/50: saved tempo or 1×</label
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
          <fieldset class="appearance-options" aria-label="SoundCloud theme">
            <label><input type="radio" name="appearance" value="native" checked>SoundCloud</label>
            <label><input type="radio" name="appearance" value="charcoal">Charcoal</label>
            <label><input type="radio" name="appearance" value="oled">OLED</label>
          </fieldset>
        </details>
        <details class="advanced-audio">
          <summary>Advanced audio</summary>
          <label class="random-label"
            ><input id="preserve-key" type="checkbox" />Preserve key by default</label
          >
          <p id="pitch-mode-help"
            >Timelines can use their own pitch mode.</p
          >
          <p id="wasm-status" role="status"></p>
          <label class="random-label"><input id="use-wasm" type="checkbox" />Use WASM for Preserve key</label>
          <label class="output-label" for="output-level">Output level <output id="output-value">-6 dB</output></label>
          <input id="output-level" type="range" min="-24" max="0" step="1" value="-6" />
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
