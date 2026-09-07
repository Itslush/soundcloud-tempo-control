import { controlsTemplate } from './tempo-controls-template.js';
import * as audioModules from './audio/index.mjs';
import { syncTempoRange } from './tempo-range.js';
import { createTempoAppearance } from './tempo-appearance.js';
import { createStretchNode } from './tempo-dependency.js';
import { createOutputLevel } from './tempo-output.js';
import { createWasmAudio } from './tempo-wasm.js';
import { createBufferedPlayback } from './tempo-buffered.js';
import { createTempoEditor } from './tempo-editor.js';
import { createTempoLibrary, createTempoStore } from './tempo-library.js';
import { createTempoEmbeddedPages } from './tempo-embedded-pages.js';
import { showReleaseNotice } from './tempo-updates.js';

(() => {
  'use strict';

  const KEY = '__soundCloudTempoControlV1';
  if (window[KEY]) {
    return;
  }
  window[KEY] = true;
  const VERSION = __TEMPO_VERSION__;
  const WEBSITE = __TEMPO_WEBSITE__;
  const COPY_STORAGE = 'soundcloud.tempo.copyLinks';
  function copyLinksEnabled() {
    try {
      return localStorage.getItem(COPY_STORAGE) === 'true';
    } catch {
      return false;
    }
  }
  const PITCH_STORAGE = 'soundcloud.tempo.preserveKey';
  const WASM_STORAGE = 'soundcloud.tempo.useWasm';
  let timeline = null;
  let bufferedAudio = null;
  let appearance = null;
  const MIN = 0.025;
  const MAX = 4;
  const SLIDER_MAX = 2;
  const SLIDER_STEP = 0.025;
  const SLIDER_STEPS = Math.round((SLIDER_MAX - MIN) / SLIDER_STEP);
  const TRACK_STORAGE = 'soundcloud.tempo.track.';
  migrateTrackStorage();

  function migrateTrackStorage() {
    try {
      for (const key of Object.keys(localStorage)) {
        const match = key.match(/^[^.]+\.(soundcloud\.tempo\.track\..+)$/);
        if (!match) continue;
        const destination = match[1];
        if (localStorage.getItem(destination) === null) {
          localStorage.setItem(destination, localStorage.getItem(key));
        }
        localStorage.removeItem(key);
      }
    } catch {}
  }
  const RANDOM_STORAGE = 'soundcloud.tempo.randomSaved';
  const TRACK_LINK = '.playControls__soundBadge .playbackSoundBadge__titleLink';
  const proto = HTMLMediaElement.prototype;
  const pitchNames = [
    'preservesPitch',
    'mozPreservesPitch',
    'webkitPreservesPitch',
  ];
  const properties = ['playbackRate', 'defaultPlaybackRate', ...pitchNames];
  const native = Object.fromEntries(
    properties.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(proto, name),
    ]),
  );
  const known = new WeakSet();
  const references = new Set();
  let ui;
  let mountQueued = false;
  let savedRefreshFrame = 0;
  let failure = '';
  let storageFailure = '';
  let rate = 1;
  let savedRate = null;
  let trackKey = '';
  let lastTrackKey = '';
  let randomSaved = readRandomSetting();
  let preserveKey = readPitchSetting();
  let useWasm = readWasmSetting();

  function readWasmSetting() {
    try {
      return localStorage.getItem(WASM_STORAGE) !== 'false';
    } catch {
      return true;
    }
  }

  function preservesKey() {
    const mode = timeline?.pitchMode();
    return mode ? mode === 'preserve' : preserveKey;
  }
  const pageArtwork = new Map();
  let embeddedPages;
  let artworkDirty = true;
  let artworkFrame = 0;

  function readRandomSetting() {
    try {
      return localStorage.getItem(RANDOM_STORAGE) === 'true';
    } catch {
      return false;
    }
  }

  function readPitchSetting() {
    try {
      return (
        pitchNames.some((name) => native[name]?.set) &&
        localStorage.getItem(PITCH_STORAGE) === 'true'
      );
    } catch {
      return false;
    }
  }

  function clamp(value) {
    return Math.round(Math.max(MIN, Math.min(MAX, value)) * 1000) / 1000;
  }

  function formatRate(value) {
    return `${value.toFixed(3).replace(/(\.\d{2})0$/, '$1')}×`;
  }

  function sliderTicks() {
    return Array.from({ length: SLIDER_STEPS + 1 }, (_, index) => {
      const units = Math.round(MIN / SLIDER_STEP) + index;
      const height = units % 10 === 0 ? 5 : units % 2 === 0 ? 3 : 1.5;
      return `M${index} 0v${height}`;
    }).join('');
  }

  function tempoLogo() {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g fill="currentColor">
          <rect x="5" y="36" width="3" height="10" rx="1.5" />
          <rect x="10" y="31" width="3" height="18" rx="1.5" />
          <rect x="15" y="26" width="3" height="23" rx="1.5" />
          <rect x="20" y="21" width="3" height="28" rx="1.5" />
          <path d="M26 20C33 9 49 14 49 29C62 27 66 49 51 49H30Q26 49 26 45Z" />
        </g>
        <path d="M31 40H54" stroke="var(--logo-cutout)" stroke-width="3" stroke-linecap="round" />
        <circle cx="45" cy="40" r="4" fill="currentColor" stroke="var(--logo-cutout)" stroke-width="2" />
      </svg>
    `;
  }

  function currentTrackKey() {
    const href = document.querySelector(TRACK_LINK)?.getAttribute('href');
    return parseTrackKey(href);
  }

  function parseTrackKey(href) {
    if (!href) {
      return '';
    }
    try {
      const url = new URL(href, 'https://soundcloud.com');
      if (
        !['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(
          url.hostname,
        ) ||
        url.protocol !== 'https:'
      ) {
        return '';
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (
        parts.length < 2 ||
        parts.length > 3 ||
        (parts.length === 3 && !/^s-[\w-]+$/.test(parts[2]))
      ) {
        return '';
      }
      if (
        [
          'sets',
          'tracks',
          'albums',
          'likes',
          'reposts',
          'followers',
          'following',
        ].includes(parts[1])
      ) {
        return '';
      }
      return `/${parts[0]}/${parts[1]}`;
    } catch {
      return '';
    }
  }

  function storageKey(key) {
    return TRACK_STORAGE + encodeURIComponent(key);
  }

  function readSavedRate(key) {
    try {
      const saved = tempoStore.speed(key);
      return saved?.enabled ? saved.rate : null;
    } catch {
      storageFailure =
        'Track memory is unavailable. Allow site storage and reload.';
      return null;
    }
  }

  function announce(message) {
    if (ui && ui.status.textContent !== message) {
      ui.status.textContent = message;
    }
  }

  function syncTrack() {
    const next = currentTrackKey();
    if (next === trackKey) {
      return false;
    }
    bufferedAudio?.changeTrack(trackKey, next);
    trackKey = next;
    timeline?.changeTrack(next);
    if (!next) {
      savedRate = null;
      render();
      return false;
    }
    storageFailure = '';
    savedRate = readSavedRate(next);
    if (next === lastTrackKey) {
      render();
      return false;
    }
    lastTrackKey = next;
    rate = savedRate ?? 1;
    if (randomSaved && savedRate !== null && savedRate !== 1) {
      rate =
        crypto.getRandomValues(new Uint32Array(1))[0] < 2147483648
          ? savedRate
          : 1;
    }
    if (ui) {
      delete ui.memory.dataset.feedback;
      ui.editTrack = next;
      ui.rateNumber.value = String(rate);
    }
    announce(
      savedRate === null
        ? 'New track. Normal speed.'
        : `${randomSaved ? 'Random tempo selected' : 'Remembered tempo restored'}: ${formatRate(rate)}.`,
    );
    render();
    return true;
  }

  function rememberTrack(forget = false) {
    if (ui) {
      delete ui.memory.dataset.feedback;
    }
    if (syncTrack()) {
      updateAll();
      return;
    }
    if (!trackKey) {
      return;
    }
    const remove = savedRate !== null && (forget || savedRate === rate);
    try {
      if (remove) {
        localStorage.removeItem(storageKey(trackKey));
      } else {
        localStorage.setItem(storageKey(trackKey), String(rate));
      }
      savedRate = remove ? null : rate;
      clearTimeout(ui.feedbackTimer);
      ui.memory.dataset.feedback = remove ? '' : 'saved';
      ui.feedbackTimer = setTimeout(
        () => delete ui.memory.dataset.feedback,
        1000,
      );
      storageFailure = '';
      announce(
        remove
          ? 'Saved tempo removed. Playback is unchanged; next visit starts at 1×.'
          : `Remembered ${formatRate(rate)} for this track.`,
      );
    } catch (error) {
      console.warn('[SoundCloud Tempo] Could not save track tempo.', error);
      storageFailure =
        'Could not save track tempo. Allow site storage or free space, then click to retry.';
      announce(storageFailure);
    }
    render();
  }

  function closeSettings(restoreFocus = false) {
    if (!ui) {
      return;
    }
    ui.settings.hidden = true;
    ui.settings.hidePopover?.();
    ui.memory.setAttribute('aria-expanded', 'false');
    ui.settingsButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      (ui.settingsTrigger || ui.settingsButton).focus();
    }
  }

  function positionSettings() {
    if (!ui || ui.settings.hidden) {
      return;
    }
    const width = Math.min(600, Math.max(0, innerWidth - 24));
    ui.settings.style.width = `${width}px`;
    ui.settings.style.left = `${(innerWidth - width) / 2}px`;
    ui.settings.style.top = '50%';
    ui.settings.style.bottom = 'auto';
    ui.settings.style.transform = 'translateY(-50%)';
  }

  function openSettings(trigger = ui.memory) {
    ui.settingsTrigger = trigger;
    ui.settings.hidden = false;
    ui.memory.setAttribute('aria-expanded', 'true');
    ui.settingsButton.setAttribute('aria-expanded', 'true');
    ui.randomToggle.checked = randomSaved;
    ui.pitchToggle.checked = preserveKey;
    ui.settingsStatus.textContent = '';
    ui.savedFilter.value = '';
    ui.library.clearPreview();
    populateSavedTracks();
    positionSettings();
    if (ui.settings.showPopover && !ui.settings.matches(':popover-open')) {
      ui.settings.showPopover();
    }
    ui.randomToggle.focus();
  }

  function populateSavedTracks() {
    ui.library.render();
  }

  function scheduleSavedTracks() {
    if (!ui || ui.settings.hidden || savedRefreshFrame) return;
    savedRefreshFrame = requestAnimationFrame(() => {
      savedRefreshFrame = 0;
      if (!ui.settings.hidden) populateSavedTracks();
    });
  }

  function isAudio(audio) {
    return audio instanceof HTMLAudioElement;
  }

  function discover(audio) {
    if (!isAudio(audio) || known.has(audio)) {
      return;
    }
    outputLevel.attach(audio);
    known.add(audio);
    references.add(new WeakRef(audio));
    for (const event of [
      'play',
      'playing',
      'loadstart',
      'loadedmetadata',
      'ratechange',
      'emptied',
    ]) {
      audio.addEventListener(event, () => apply(audio));
    }
  }

  function setNative(audio, name, value) {
    const descriptor = native[name];
    if (descriptor?.set && descriptor.get.call(audio) !== value) {
      descriptor.set.call(audio, value);
    }
  }

  function apply(audio) {
    if (!isAudio(audio)) {
      return;
    }
    syncTrack();
    discover(audio);
    timeline?.observe(audio);
    const automated = timeline?.value();
    if (automated !== null && automated !== undefined) {
      rate = automated;
    }
    try {
      if (!bufferedAudio?.sync(audio)) applyNative(audio);
    } catch (error) {
      if (!failure) {
        console.warn('[SoundCloud Tempo]', error);
      }
      failure = 'Could not change playback rate. Reload SoundCloud and retry.';
      announce(failure);
      render();
    }
  }

  function applyNative(audio) {
    const wasmActive = wasmAudio.sync(audio, preservesKey() && useWasm, rate);
    for (const name of pitchNames) {
      setNative(audio, name, preservesKey() && !wasmActive);
    }
    setNative(audio, 'defaultPlaybackRate', rate);
    setNative(audio, 'playbackRate', rate);
  }

  function updateAll() {
    syncTrack();
    for (const reference of references) {
      const audio = reference.deref();
      if (!audio) references.delete(reference);
      else apply(audio);
    }
    render();
    timeline?.wake();
  }

  function setRate(value) {
    if (syncTrack()) {
      updateAll();
      return;
    }
    if (String(value).trim() === '') {
      return;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return;
    }
    rate = clamp(number);
    timeline?.suspend();
    failure = '';
    updateAll();
    if (!failure) announce(`Playback speed ${formatRate(rate)}.`);
  }

  function handleShortcut(event) {
    if (
      !event.altKey ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.isComposing
    ) {
      return false;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    setRate(
      event.key === 'ArrowDown'
        ? 1
        : rate + (event.key === 'ArrowLeft' ? -0.05 : 0.05),
    );
    return true;
  }

  function installGuards() {
    for (const name of properties) {
      const descriptor = native[name];
      if (!descriptor?.configurable || !descriptor.set) {
        continue;
      }
      Object.defineProperty(proto, name, {
        ...(Object.getOwnPropertyDescriptor(proto, name) || descriptor),
        set(value) {
          if (!isAudio(this)) {
            return descriptor.set.call(this, value);
          }
          discover(this);
          if (pitchNames.includes(name)) {
            return descriptor.set.call(
              this,
              preservesKey() && !wasmAudio.active(this),
            );
          }
          apply(this);
        },
      });
    }
    const play = proto.play;
    proto.play = function (...args) {
      if (isAudio(this)) {
        bufferedAudio.select(this);
        apply(this);
        return bufferedAudio.play(this, () => Reflect.apply(play, this, args));
      }
      return Reflect.apply(play, this, args);
    };
    const pause = proto.pause;
    proto.pause = function (...args) {
      if (isAudio(this) && bufferedAudio.pause(this)) return;
      return Reflect.apply(pause, this, args);
    };
    for (const event of ['play', 'loadedmetadata']) {
      document.addEventListener(
        event,
        (e) => {
          if (isAudio(e.target)) {
            if (e.type === 'play' && e.isTrusted)
              bufferedAudio.select(e.target);
            apply(e.target);
          }
        },
        true,
      );
    }
    document.addEventListener(
      'keydown',
      (event) => {
        if (
          event
            .composedPath()
            .some(
              (el) =>
                el instanceof Element &&
                (el === ui?.host ||
                  el.matches('input,textarea,select') ||
                  el.isContentEditable),
            )
        ) {
          return;
        }
        handleShortcut(event);
      },
      true,
    );
  }

  function createUi() {
    const host = document.createElement('span');
    host.id = 'soundcloud-tempo-control';
    host.style.cssText = `
      display: flex;
      align-items: center;
      flex: 0 0 280px;
      min-width: 280px;
      margin-inline: 4px;
    `;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = controlsTemplate({
      MIN,
      MAX,
      SLIDER_MAX,
      SLIDER_STEP,
      SLIDER_STEPS,
      sliderTicks,
    });
    const get = (selector) => root.querySelector(selector);
    ui = {
      host,
      root,
      rateNumber: get('#rate-number'),
      slider: get('#rate-slider'),
      stepUp: get('.step-up'),
      stepDown: get('.step-down'),
      memory: get('.memory'),
      settingsButton: get('.settings-button'),
      error: get('.error'),
      unit: get('.unit'),
      status: get('.status'),
      editTrack: trackKey,
      editingNumber: false,
      settings: get('.settings'),
      randomToggle: get('#random-saved'),
      copyToggle: get('#copy-tempo-links'),
      pitchToggle: get('#preserve-key'),
      savedFilter: get('#saved-filter'),
      savedList: get('.saved-list'),
      savedCount: get('.saved-count'),
      settingsStatus: get('.settings-status'),
      wasmStatus: get('#wasm-status'),
      outputSlider: get('#output-level'),
      outputValue: get('#output-value'),
      wasmToggle: get('#use-wasm'),
    };
    for (const input of root.querySelectorAll('[name="appearance"]')) {
      input.checked = input.value === appearance.mode();
      input.addEventListener('change', () => {
        if (!input.checked) return;
        try {
          appearance.setMode(input.value);
        } catch {
          for (const option of root.querySelectorAll('[name="appearance"]'))
            option.checked = option.value === appearance.mode();
          ui.settingsStatus.textContent = 'Theme could not be saved.';
        }
      });
    }
    ui.library = createTempoLibrary({
      root,
      store: tempoStore,
      edit: (track) => timeline.open(track),
      changed: (track, type) => {
        if (type === 'timeline') timeline.refreshSaved(track);
        if (track === trackKey) savedRate = readSavedRate(trackKey);
        render();
      },
      imported: () => {
        randomSaved = readRandomSetting();
        preserveKey = readPitchSetting();
        useWasm = readWasmSetting();
        savedRate = readSavedRate(trackKey);
        ui.randomToggle.checked = randomSaved;
        ui.pitchToggle.checked = preserveKey;
        ui.wasmToggle.checked = useWasm;
        ui.copyToggle.checked = copyLinksEnabled();
        outputLevel.reload();
        timeline.refreshSaved(trackKey);
        updateAll();
      },
    });
    ui.wasmToggle.checked = useWasm;
    ui.wasmToggle.addEventListener('change', () => {
      try {
        localStorage.setItem(WASM_STORAGE, String(ui.wasmToggle.checked));
        useWasm = ui.wasmToggle.checked;
        updateAll();
      } catch {
        ui.wasmToggle.checked = useWasm;
        ui.settingsStatus.textContent = 'Audio setting could not be saved.';
      }
    });
    ui.outputSlider.value = String(outputLevel.value());
    ui.outputValue.textContent = `${outputLevel.value()} dB`;
    syncTempoRange(ui.outputSlider);
    ui.outputSlider.addEventListener('input', () => {
      try {
        outputLevel.set(ui.outputSlider.value);
      } catch {
        ui.settingsStatus.textContent = 'Output level could not be saved.';
      }
    });
    root.addEventListener('input', (event) => {
      if (event.target.matches("input[type='range']"))
        syncTempoRange(event.target);
    });
    ui.copyToggle.checked = copyLinksEnabled();
    ui.copyToggle.addEventListener('change', () => {
      try {
        localStorage.setItem(COPY_STORAGE, String(ui.copyToggle.checked));
      } catch {
        ui.copyToggle.checked = copyLinksEnabled();
        ui.settingsStatus.textContent = 'Could not save setting.';
      }
    });
    ui.settingsButton.addEventListener('click', () => {
      ui.copyToggle.checked = copyLinksEnabled();
      if (ui.settings.hidden) {
        openSettings(ui.settingsButton);
      } else {
        closeSettings(true);
      }
    });
    get('.open-editor').addEventListener('click', () => timeline.open());
    ui.pitchToggle.setAttribute('aria-describedby', 'pitch-mode-help');
    ui.pitchToggle.disabled = !pitchNames.some((name) => native[name]?.set);
    if (ui.pitchToggle.disabled) {
      get('#pitch-mode-help').textContent =
        'Pitch preservation is unavailable in this browser. Natural mode remains active.';
    }
    ui.pitchToggle.addEventListener('change', () => {
      try {
        localStorage.setItem(PITCH_STORAGE, String(ui.pitchToggle.checked));
        preserveKey = ui.pitchToggle.checked;
        updateAll();
        ui.settingsStatus.textContent = timeline.pitchMode()
          ? 'Default saved. This timeline keeps its own pitch mode.'
          : preserveKey
            ? wasmAudio.label()
            : 'Natural pitch restored.';
      } catch {
        ui.pitchToggle.checked = preserveKey;
        ui.settingsStatus.textContent =
          'Could not save audio mode. Allow site storage and retry.';
      }
    });
    ui.memory.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSettings();
    });
    ui.memory.addEventListener('keydown', (event) => {
      if (
        event.key === 'ContextMenu' ||
        (event.shiftKey && event.key === 'F10') ||
        (event.altKey && event.key === 'Enter')
      ) {
        event.preventDefault();
        event.stopPropagation();
        openSettings();
      }
    });
    get('.close-settings').addEventListener('click', () => closeSettings(true));
    ui.savedFilter.addEventListener('input', populateSavedTracks);
    ui.randomToggle.addEventListener('change', () => {
      try {
        localStorage.setItem(RANDOM_STORAGE, String(ui.randomToggle.checked));
        randomSaved = ui.randomToggle.checked;
        ui.settingsStatus.textContent =
          'Preference saved. Applies to the next track.';
      } catch {
        ui.randomToggle.checked = randomSaved;
        ui.settingsStatus.textContent =
          'Could not save this preference. Allow site storage and retry.';
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (
        !event.composedPath().includes(ui.settings) &&
        !event.composedPath().includes(ui.memory) &&
        !event.composedPath().includes(ui.settingsButton)
      ) {
        closeSettings();
      }
    });
    ui.slider.addEventListener('input', () => setRate(ui.slider.value));
    for (const [button, direction] of [
      [ui.stepUp, 1],
      [ui.stepDown, -1],
    ]) {
      let timer;
      let repeated = false;
      let pressedTrack = '';
      const stop = () => clearTimeout(timer);
      button.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) {
          return;
        }
        stop();
        repeated = false;
        button.setPointerCapture(event.pointerId);
        const startingTrack = currentTrackKey();
        pressedTrack = startingTrack;
        const step = event.shiftKey ? 0.01 : 0.025;
        const repeat = () => {
          if (
            currentTrackKey() !== startingTrack ||
            !button.isConnected ||
            button.disabled
          ) {
            stop();
            return;
          }
          repeated = true;
          setRate(rate + direction * step);
          timer = setTimeout(repeat, 100);
        };
        timer = setTimeout(repeat, 400);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        button.addEventListener(type, stop);
      }
      window.addEventListener('blur', stop);
      document.addEventListener('visibilitychange', stop);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (event.detail !== 0 && pressedTrack !== currentTrackKey()) {
          return;
        }
        if (repeated && event.detail !== 0) {
          repeated = false;
          return;
        }
        setRate(rate + direction * (event.shiftKey ? 0.01 : 0.025));
      });
    }
    ui.slider.addEventListener('dblclick', () => setRate(1));
    ui.rateNumber.addEventListener('dblclick', () => {
      setRate(1);
      ui.rateNumber.value = String(rate);
    });
    ui.slider.addEventListener('pointerdown', () => {
      if (ui.root.activeElement === ui.rateNumber) {
        ui.rateNumber.blur();
      }
      if (rate > SLIDER_MAX) {
        setRate(SLIDER_MAX);
      }
    });
    ui.slider.addEventListener('keydown', (event) => {
      if (
        rate > SLIDER_MAX &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        [
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(event.key)
      ) {
        setRate(SLIDER_MAX);
      }
    });
    for (const type of [
      'pointerdown',
      'mousedown',
      'touchstart',
      'click',
      'dblclick',
    ]) {
      ui.slider.addEventListener(type, (event) => event.stopPropagation());
    }
    ui.rateNumber.addEventListener('focus', () => {
      ui.editTrack = trackKey;
    });
    ui.rateNumber.addEventListener('input', () => {
      ui.editingNumber = true;
    });
    const commitNumber = () => {
      const draft = ui.rateNumber.value;
      ui.editingNumber = false;
      const editingTrack = ui.editTrack;
      const changed = syncTrack();
      if (!changed && editingTrack === trackKey) {
        setRate(draft);
      } else {
        updateAll();
      }
      ui.rateNumber.value = String(rate);
      render();
    };
    ui.rateNumber.addEventListener('change', commitNumber);
    ui.rateNumber.addEventListener('blur', () => {
      ui.editingNumber = false;
      ui.rateNumber.value = String(rate);
    });
    ui.memory.addEventListener('click', (event) =>
      trackKey ? rememberTrack(event.shiftKey) : openSettings(),
    );
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !ui.settings.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeSettings(true);
        return;
      }
      if (
        ui.settings.contains(event.target) ||
        timeline?.contains(event.target)
      ) {
        event.stopPropagation();
        return;
      }
      if (handleShortcut(event)) {
        ui.rateNumber.value = String(rate);
        return;
      }
      if (event.target === ui.rateNumber && event.key === 'Enter') {
        event.preventDefault();
        commitNumber();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        ui.rateNumber.value = String(rate);
        ui.root.activeElement?.blur();
      }
      event.stopPropagation();
    });
    render();
  }

  function installFooterStyle() {
    if (document.getElementById('soundcloud-tempo-footer-style')) {
      return;
    }
    const style = document.createElement('style');
    style.id = 'soundcloud-tempo-footer-style';
    style.textContent = `
      .playControls__elements.soundcloud-tempo-footer > .playControls__timeline {
        flex: 1 1 300px;
        min-width: 90px;
        margin-left: 12px !important;
        margin-right: 8px !important;
      }

      .soundcloud-tempo-footer .playbackTimeline__progressWrapper {
        min-width: 24px;
      }

      .playControls__elements.soundcloud-tempo-footer > .playControls__soundBadge {
        flex: 0 1 288px;
        width: 288px;
        min-width: 180px;
        margin-left: 12px !important;
      }

      .soundcloud-tempo-footer .playbackSoundBadge__titleContextContainer {
        min-width: 0;
        margin-right: 12px !important;
      }

      .soundcloud-tempo-footer .playbackSoundBadge__avatar {
        flex-shrink: 0;
        margin-right: 8px !important;
      }

      .playbackSoundBadge__avatar.soundcloud-tempo-artwork {
        position: relative;
      }

      .soundcloud-tempo-page-position {
        position: relative;
      }

      .soundcloud-tempo-footer .playbackSoundBadge__actions {
        flex-shrink: 0;
      }

      .playControls__elements.soundcloud-tempo-footer > .playControls__volume {
        flex-shrink: 0;
      }

      @media (max-width: 1100px) {
        .playControls__elements.soundcloud-tempo-footer > .playControls__prev,
        .playControls__elements.soundcloud-tempo-footer > .playControls__play,
        .playControls__elements.soundcloud-tempo-footer > .playControls__next {
          margin-right: 8px !important;
        }

        .soundcloud-tempo-footer .playbackSoundBadge__titleContextContainer {
          margin-right: 8px !important;
        }
      }

      @media (max-width: 850px) {
        .playControls__elements.soundcloud-tempo-footer > .playControls__timeline {
          min-width: 54px;
        }
      }

      @media (max-width: 700px) {
        .playControls:has(.soundcloud-tempo-footer) {
          height: auto;
        }

        .playControls:has(.soundcloud-tempo-footer) .playControls__inner {
          height: auto;
        }

        .playControls__elements.soundcloud-tempo-footer {
          height: auto;
          min-height: 92px;
          flex-wrap: wrap;
          row-gap: 6px;
          padding: 6px 8px;
        }

        .playControls__elements.soundcloud-tempo-footer > .playControls__volume {
          order: 5;
        }

        .playControls__elements.soundcloud-tempo-footer > .playControls__timeline {
          order: 6;
          flex: 1 1 90px;
          margin: 0 4px !important;
        }

        .playControls__elements.soundcloud-tempo-footer > #soundcloud-tempo-control {
          order: 10;
          flex: 1 1 208px !important;
          min-width: 196px !important;
          margin: 0 4px 0 0;
        }

        .playControls__elements.soundcloud-tempo-footer > .playControls__soundBadge {
          order: 11;
          flex: 1 1 180px;
          width: auto;
          margin: 0 !important;
        }
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function syncTheme() {
    if (!ui?.host.isConnected) {
      return;
    }
    const bar = ui.host.closest('.playControls');
    const reference =
      bar?.querySelector('.volume__button') || bar || document.body;
    const foreground = getComputedStyle(reference).color;
    const values = foreground.match(/[\d.]+/g)?.map(Number) || [34, 34, 34];
    const dark = values.slice(0, 3).reduce((a, b) => a + b, 0) > 450;
    ui.host.style.setProperty('--tempo-fg', foreground);
    const progress = bar?.querySelector('.playbackTimeline__progressBar');
    const accent = progress && getComputedStyle(progress).backgroundColor;
    const nativeRail = progress?.getBoundingClientRect();
    const controls = ui.root.querySelector('.controls').getBoundingClientRect();
    const offset = nativeRail?.height
      ? nativeRail.y + nativeRail.height / 2 - controls.y - controls.height / 2
      : 0;
    ui.host.style.setProperty(
      '--tempo-rail-offset',
      `${Math.abs(offset) <= 8 ? offset : 0}px`,
    );
    ui.host.style.setProperty(
      '--tempo-accent',
      accent && accent !== 'rgba(0, 0, 0, 0)' ? accent : '#ff5500',
    );
    ui.host.style.setProperty('--tempo-track', dark ? '#888' : '#777');
    const surface = getComputedStyle(document.documentElement)
      .getPropertyValue('--tempo-page-surface')
      .trim();
    ui.host.style.setProperty(
      '--tempo-surface',
      surface || (dark ? '#303030' : '#f2f2f2'),
    );
    ui.host.style.setProperty('--tempo-accent-surface', surface || '#242424');
    ui.host.style.colorScheme = dark ? 'dark' : 'light';
    ui.host.style.fontFamily = getComputedStyle(reference).fontFamily;
  }

  function syncArtworkIndicator(description) {
    const artwork = document.querySelector(
      '.playControls__soundBadge .playbackSoundBadge__avatar',
    );
    if (ui.artwork !== artwork) {
      ui.artwork?.classList.remove('soundcloud-tempo-artwork');
      ui.artworkIndicator?.remove();
      ui.artwork = artwork;
      ui.artworkIndicator = null;
    }
    if (!artwork) {
      return;
    }
    if (!ui.artworkIndicator?.isConnected) {
      artwork
        .querySelectorAll('#soundcloud-tempo-artwork-indicator')
        .forEach((node) => {
          node.remove();
        });
      const indicator = document.createElement('span');
      indicator.id = 'soundcloud-tempo-artwork-indicator';
      indicator.setAttribute('role', 'img');
      indicator.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          :host {
            position: absolute;
            inset: auto 1px 1px auto;
            display: grid;
            place-items: center;
            width: 18px;
            height: 18px;
            box-sizing: border-box;
            border: 1px solid #161616;
            border-radius: 3px;
            background: #ff5500;
            color: #fff;
            --logo-cutout: #ff5500;
            z-index: 1;
            line-height: 0;
          }
          :host([hidden]) {
            display: none;
          }
          svg {
            width: 100%;
            height: 100%;
            pointer-events: none;
          }
          @media (forced-colors: active) {
            :host {
              background: Canvas;
              color: CanvasText;
              border-color: CanvasText;
            }
          }
        </style>
        ${tempoLogo()}
      `;
      artwork.classList.add('soundcloud-tempo-artwork');
      artwork.append(indicator);
      ui.artworkIndicator = indicator;
    }
    const label = description;
    const indicator = ui.artworkIndicator;
    const hidden = rate === 1 || !trackKey || Boolean(failure);
    if (indicator.hidden !== hidden) {
      indicator.hidden = hidden;
    }
    if (indicator.title !== label) {
      indicator.title = label;
      indicator.setAttribute('aria-label', label);
    }
  }

  function embeddedArtwork(image) {
    const artwork = image.parentElement;
    if (!artwork) return null;
    try {
      const url = new URL(image.currentSrc || image.src);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.sndcdn.com'))
        return null;
      if (url.pathname.startsWith('/artworks-')) return artwork;
      if (!url.pathname.startsWith('/avatars-')) return null;
      const title = image
        .closest('section[aria-label="Track header"]')
        ?.querySelector('h1')
        ?.textContent.replace(/\s+/gu, ' ')
        .trim();
      if (!title || image.alt.replace(/\s+/gu, ' ').trim() !== title)
        return null;
      const interactive =
        'a, button, input, select, textarea, [role="button"], [role="link"]';
      if (
        artwork.tagName !== 'DIV' ||
        artwork.textContent.trim() ||
        image.closest(interactive) ||
        artwork.querySelector(interactive) ||
        artwork.querySelectorAll('img').length !== 1
      )
        return null;
      const { width, height } = image.getBoundingClientRect();
      if (width >= 96 && height >= 96 && Math.abs(width - height) <= 1)
        return artwork;
      const size = image.sizes.match(/^\s*(\d+(?:\.\d+)?)px\s*$/)?.[1];
      return width === 0 && height === 0 && Number(size) >= 96 ? artwork : null;
    } catch {
      return null;
    }
  }

  function collectArtworkTargets(page, targets) {
    for (const link of page.querySelectorAll('a[href]')) {
      if (link.closest('.playControls')) {
        continue;
      }
      const key = parseTrackKey(link.getAttribute('href'));
      if (!key) {
        continue;
      }
      const visual = link.querySelector('.image, [style*="background-image"]');
      if (
        !visual &&
        !link.querySelector('img') &&
        !link.matches('[style*="background-image"], .image')
      ) {
        continue;
      }
      const artwork =
        visual && !['IMG', 'SVG'].includes(visual.tagName) ? visual : link;
      targets.set(artwork, key);
    }
    for (const card of page.querySelectorAll(
      '.playableTile, .sound, .queueItemView, .soundBadge, .trackItem',
    )) {
      const title = card.querySelector(
        'a.playableTile__mainHeading, .playableTile__mainHeading a, a.soundTitle__title, a.queueItemView__title, .queueItemView__title a, a.soundBadge__titleLink, a.trackItem__trackTitle',
      );
      const key = parseTrackKey(title?.getAttribute('href'));
      const artwork = card.querySelector(
        '.playableTile__artwork .image, .sound__coverArt .image, .queueItemView__artwork .image, .soundBadge__avatar .image, .trackItem__artwork .image',
      );
      if (key && artwork && !targets.has(artwork)) {
        targets.set(artwork, key);
      }
    }
    const pageKey =
      page === document
        ? parseTrackKey(location.href)
        : embeddedPages.key(page);
    if (pageKey) {
      page
        .querySelectorAll(
          '.listenArtworkWrapper .image, .fullHero__artwork .image',
        )
        .forEach((artwork) => targets.set(artwork, pageKey));
      if (page !== document) {
        for (const image of page.querySelectorAll(
          'section[aria-label="Track header"] img',
        )) {
          const artwork = embeddedArtwork(image);
          if (artwork) targets.set(artwork, pageKey);
        }
      }
    }
  }

  function collectPageArtwork() {
    const targets = new Map();
    for (const page of [document, ...(embeddedPages?.documents() || [])])
      collectArtworkTargets(page, targets);
    for (const [artwork, entry] of pageArtwork) {
      if (targets.get(artwork) !== entry.key) {
        entry.badge?.remove();
        if (entry.positioned) {
          artwork.classList.remove('soundcloud-tempo-page-position');
        }
        pageArtwork.delete(artwork);
      }
    }
    for (const [artwork, key] of targets) {
      if (!pageArtwork.has(artwork)) {
        artwork.classList.remove('soundcloud-tempo-page-position');
        artwork
          .querySelectorAll(':scope > .soundcloud-tempo-page-indicator')
          .forEach((badge) => badge.remove());
        pageArtwork.set(artwork, { key, badge: null, positioned: false });
      }
    }
  }

  function renderPageArtwork() {
    const saved = new Map();
    for (const [artwork, entry] of pageArtwork) {
      if (!artwork.isConnected) {
        pageArtwork.delete(artwork);
        continue;
      }
      if (!saved.has(entry.key)) {
        saved.set(entry.key, readSavedRate(entry.key));
      }
      const stored = saved.get(entry.key);
      const active = entry.key === trackKey && rate !== 1 && !failure;
      const value = active ? rate : stored;
      if (value === null || value === 1) {
        if (entry.badge) {
          entry.badge.hidden = true;
        }
        continue;
      }
      if (!entry.badge?.isConnected) {
        const badge = artwork.ownerDocument.createElement('span');
        badge.className = 'soundcloud-tempo-page-indicator';
        badge.setAttribute('role', 'img');
        badge.attachShadow({ mode: 'open' }).innerHTML = `
          <style>
            :host {
              position: absolute;
              bottom: 3px;
              right: 3px;
              display: grid;
              place-items: center;
              width: 24px;
              height: 24px;
              box-sizing: border-box;
              border: 1px solid #ff7733;
              border-radius: 3px;
              background: #303030;
              color: #ff7733;
              --logo-cutout: #303030;
              z-index: 5;
              line-height: 0;
            }

            :host([data-active='true']) {
              background: #ff5500;
              color: #fff;
              --logo-cutout: #ff5500;
              border-color: #161616;
            }

            :host([data-small='true']) {
              width: 18px;
              height: 18px;
              bottom: 1px;
              right: 1px;
            }

            :host([hidden]) {
              display: none;
            }

            svg {
              width: 100%;
              height: 100%;
              pointer-events: none;
            }

            @media (forced-colors: active) {
              :host {
                background: Canvas;
                color: CanvasText;
                border-color: CanvasText;
              }
            }
          </style>
          ${tempoLogo()}
        `;
        entry.positioned =
          artwork.ownerDocument.defaultView.getComputedStyle(artwork)
            .position === 'static';
        if (entry.positioned) {
          artwork.classList.add('soundcloud-tempo-page-position');
        }
        artwork.append(badge);
        entry.badge = badge;
      }
      const label = active
        ? `Playing at ${formatRate(value)}`
        : `Saved tempo ${formatRate(value)}`;
      if (entry.badge.hidden) {
        entry.badge.hidden = false;
      }
      if (entry.badge.dataset.active !== String(active)) {
        entry.badge.dataset.active = String(active);
      }
      const width = artwork.getBoundingClientRect().width;
      const small = String(width > 0 && width <= 48);
      if (entry.badge.dataset.small !== small) {
        entry.badge.dataset.small = small;
      }
      if (entry.badge.title !== label) {
        entry.badge.title = label;
        entry.badge.setAttribute('aria-label', label);
      }
    }
  }

  function schedulePageArtwork() {
    if (artworkFrame) return;
    artworkFrame = requestAnimationFrame(() => {
      artworkFrame = 0;
      if (artworkDirty) {
        artworkDirty = false;
        collectPageArtwork();
      }
      renderPageArtwork();
    });
  }

  function mount() {
    const bar = document.querySelector('.playControls__elements');
    if (!bar) {
      return;
    }
    installFooterStyle();
    if (!ui) {
      createUi();
    }
    bar.classList.add('soundcloud-tempo-footer');
    if (ui.host.parentNode !== bar) {
      closeSettings();
      bar.querySelectorAll('#soundcloud-tempo-control').forEach((node) => {
        if (node !== ui.host) {
          node.remove();
        }
      });
      const volume = bar.querySelector('.playControls__volume');
      bar.insertBefore(
        ui.host,
        volume || bar.querySelector('.playControls__soundBadge'),
      );
      syncTheme();
      showReleaseNotice(ui, VERSION, WEBSITE);
    }
  }

  function render() {
    if (!ui) {
      return;
    }
    ui.wasmStatus.textContent = bufferedAudio?.label() || wasmAudio.label();
    const text = formatRate(rate);
    const pitch = 12 * Math.log2(rate);
    const pitchText = `${pitch > 0 ? '+' : ''}${pitch.toFixed(2)} st`;
    const description = preservesKey()
      ? `${text} · Preserve key`
      : `${text} · natural pitch ${pitchText}`;
    const sliderRate = clamp(
      Math.round(Math.min(rate, SLIDER_MAX) / 0.025) * 0.025,
    );
    ui.stepUp.disabled = rate >= MAX;
    ui.stepDown.disabled = rate <= MIN;
    if (ui.slider.valueAsNumber !== sliderRate) {
      ui.slider.value = String(sliderRate);
    }
    syncTempoRange(ui.slider);
    const sliderDescription =
      rate > SLIDER_MAX
        ? `Slider limit ${formatRate(SLIDER_MAX)}; current speed ${description}. Use the number field for speeds above 2×`
        : `${description} · slider steps 0.025×`;
    ui.slider.setAttribute('aria-valuetext', sliderDescription);
    ui.slider.title = 'Tempo · double-click to reset';
    if (ui.root.activeElement !== ui.rateNumber || !ui.editingNumber) {
      ui.rateNumber.value = String(rate);
    }
    ui.rateNumber.title = failure || 'Exact tempo · double-click to reset';
    ui.rateNumber.setAttribute('aria-invalid', String(Boolean(failure)));
    ui.unit.hidden = Boolean(failure);
    ui.error.hidden = !failure;
    ui.error.title = failure;
    const state =
      savedRate === null
        ? 'unsaved'
        : savedRate === rate
          ? 'saved'
          : 'modified';
    ui.memory.dataset.state = storageFailure ? 'error' : state;
    ui.memory.setAttribute('aria-pressed', String(savedRate !== null));
    let label = !trackKey
      ? 'Settings'
      : state === 'saved'
        ? 'Forget saved tempo'
        : state === 'modified'
          ? 'Update saved tempo'
          : 'Save tempo';
    if (storageFailure) {
      label = storageFailure;
    }
    ui.memory.title = label;
    ui.memory.setAttribute('aria-label', label);
    syncArtworkIndicator(
      `${text} · ${preservesKey() ? 'Preserve key' : pitchText}`,
    );
    schedulePageArtwork();
  }

  function scheduleRefresh() {
    if (mountQueued) return;
    mountQueued = true;
    queueMicrotask(() => {
      mountQueued = false;
      mount();
      updateAll();
    });
  }
  timeline = createTempoEditor({
    get copyLinks() {
      return copyLinksEnabled();
    },
    get pitchMode() {
      return preservesKey() ? 'preserve' : 'natural';
    },
    get defaultPitchMode() {
      return preserveKey ? 'preserve' : 'natural';
    },
    get ready() {
      return Boolean(ui);
    },
    get rate() {
      return rate;
    },
    get root() {
      return ui.root;
    },
    get host() {
      return ui.host;
    },
    parseTrack: parseTrackKey,
    refresh: updateAll,
    normal: () => setRate(1),
    closeSettings,
    message: (text) => {
      ui.settingsStatus.textContent = text;
    },
  });
  const tempoStore = createTempoStore({
    storage: () => localStorage,
    parseTrack: parseTrackKey,
    validateTimeline: timeline.validate,
  });
  appearance = createTempoAppearance({
    onChange() {
      if (!ui) return;
      for (const input of ui.root.querySelectorAll('[name="appearance"]'))
        input.checked = input.value === appearance.mode();
      ui.settingsStatus.textContent = '';
      syncTheme();
    },
    onError() {
      if (ui)
        ui.settingsStatus.textContent =
          'Theme applied for this tab. Could not save it.';
    },
  });
  embeddedPages = createTempoEmbeddedPages({
    parseTrack: parseTrackKey,
    currentTrack: () => trackKey,
    copyLinks: copyLinksEnabled,
    shareLink: (text) => timeline.shareLink(text),
    appearance(doc) {
      try {
        return appearance.attachDocument(doc);
      } catch {
        if (ui && appearance.mode() !== 'native')
          ui.settingsStatus.textContent =
            'Theme unavailable in this track view.';
      }
    },
    changed: () => {
      artworkDirty = true;
      schedulePageArtwork();
    },
  });
  const outputLevel = createOutputLevel({ references, readUI: () => ui });
  const wasmAudio = createWasmAudio({
    audioModules,
    outputLevel,
    createStretchNode,
    preservesKey,
    readUseWasm: () => useWasm,
    references,
    updateAll,
    apply,
    discover,
    onGraphReady: (audio) => bufferedAudio?.graphReady(audio),
  });
  bufferedAudio = createBufferedPlayback({
    modules: audioModules,
    graph: wasmAudio,
    readSettings: (audio) => ({
      track: trackKey,
      rate,
      mode: preservesKey() ? 'preserve' : 'natural',
      wasm: useWasm,
      schedule: timeline.playbackSchedule(audio),
    }),
    media: function* () {
      for (const reference of references) {
        const audio = reference.deref();
        if (audio) yield audio;
      }
    },
    applyNative,
    onState: render,
    recoverNative(audio) {
      timeline?.suspend();
      rate = 0.25;
      applyNative(audio);
    },
    onFailure(message) {
      failure = message;
      announce(message);
    },
  });
  installGuards();
  if (navigator.clipboard?.writeText) {
    const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    try {
      navigator.clipboard.writeText = (text) =>
        writeText(timeline.shareLink(text));
    } catch {}
  }
  let contextLink = null;
  function restoreContextLink() {
    if (!contextLink) return;
    const { anchor, original, shared } = contextLink;
    if (anchor.getAttribute('href') === shared)
      anchor.setAttribute('href', original);
    contextLink = null;
  }
  document.addEventListener(
    'contextmenu',
    (event) => {
      restoreContextLink();
      if (!copyLinksEnabled()) return;
      const anchor = event
        .composedPath()
        .find((node) => node instanceof HTMLAnchorElement);
      if (!anchor) return;
      const original = anchor.getAttribute('href');
      if (original === null) return;
      const shared = timeline.shareLink(anchor.href);
      if (shared === anchor.href) return;
      contextLink = { anchor, original, shared };
      anchor.setAttribute('href', shared);
    },
    true,
  );
  document.addEventListener('pointerdown', restoreContextLink, true);
  document.addEventListener('keydown', restoreContextLink, true);
  window.addEventListener('pagehide', restoreContextLink);
  window.addEventListener('copy', (event) => {
    if (!copyLinksEnabled() || !event.clipboardData) return;
    const target = document.activeElement;
    const selected =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
        ? target.value.slice(
            target.selectionStart ?? 0,
            target.selectionEnd ?? 0,
          )
        : String(window.getSelection());
    const original = event.clipboardData.getData('text/plain') || selected;
    const shared = timeline.shareLink(original);
    if (shared !== original) {
      event.clipboardData.setData('text/plain', shared);
      event.clipboardData.clearData('text/html');
      event.preventDefault();
    }
  });
  const relevantNodes =
    'a[href], audio, .image, .playControls, .playControls__elements, .playableTile, .sound, .queueItemView, .soundBadge, .trackItem';
  const ownedNodes =
    '#soundcloud-tempo-control, #soundcloud-tempo-artwork-indicator, .soundcloud-tempo-page-indicator';

  function relevantMutation(mutation) {
    if (mutation.type === 'attributes') return true;
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (!(node instanceof Element)) continue;
      if (node === ui?.host) {
        if (!node.isConnected) return true;
        continue;
      }
      if (node.matches(ownedNodes)) {
        if (!node.isConnected && mutation.target.isConnected) return true;
        continue;
      }
      if (node.matches(relevantNodes) || node.querySelector(relevantNodes))
        return true;
    }
    return false;
  }

  new MutationObserver((mutations) => {
    if (!mutations.some(relevantMutation)) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (isAudio(node)) apply(node);
        else node.querySelectorAll('audio').forEach(apply);
      }
    }
    artworkDirty = true;
    scheduleRefresh();
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  window.addEventListener('storage', (event) => {
    if (
      event.key === null ||
      event.key?.startsWith(TRACK_STORAGE) ||
      event.key?.startsWith('soundcloud.tempo.timeline.')
    )
      scheduleSavedTracks();
    if (event.key === null || event.key === WASM_STORAGE) {
      useWasm = readWasmSetting();
      if (ui) ui.wasmToggle.checked = useWasm;
      updateAll();
    }
    if (event.key === null || event.key === PITCH_STORAGE) {
      preserveKey = readPitchSetting();
      if (ui) {
        ui.pitchToggle.checked = preserveKey;
      }
      updateAll();
    }
    if (event.key === null || event.key?.startsWith(TRACK_STORAGE)) {
      schedulePageArtwork();
    }
    if (event.key === null || event.key === RANDOM_STORAGE) {
      randomSaved = readRandomSetting();
      if (ui) {
        ui.randomToggle.checked = randomSaved;
      }
    }
    if (event.key === null || event.key === storageKey(trackKey)) {
      storageFailure = '';
      savedRate = trackKey ? readSavedRate(trackKey) : null;
      render();
    }
  });
  window.addEventListener('resize', syncTheme);
  window.addEventListener('resize', positionSettings);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    artworkDirty = true;
    scheduleRefresh();
    syncTheme();
  });
  const themeObserver = new MutationObserver(syncTheme);
  function observeTheme() {
    for (const element of [document.documentElement, document.body]) {
      if (element)
        themeObserver.observe(element, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme'],
        });
    }
  }
  document.addEventListener('DOMContentLoaded', observeTheme, { once: true });
  observeTheme();
  window
    .matchMedia?.('(prefers-color-scheme: dark)')
    .addEventListener('change', syncTheme);
  document.querySelectorAll('audio').forEach(discover);
  mount();
  updateAll();
})();
