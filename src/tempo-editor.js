import { readPitchSettings, pitchSettingsKey } from './tempo-pitch-settings.js';
import { readTempoIncrement } from './tempo-increment.js';
import {
  encodeTempoCode,
  decodeTempoCode,
  tempoShareLink,
} from './tempo-share.js';
import { enhanceTempoFields } from './tempo-fields.js';
import { editorTemplate } from './tempo-editor-template.js';
import { syncTempoRange } from './tempo-range.js';
import {
  validateProfile,
  evaluatePoints,
  profilePitchAt,
  validKeyShift,
} from './tempo-profile.js';

export function createTempoEditor(api) {
  const website =
    api.website ??
    (typeof __TEMPO_WEBSITE__ === 'string' ? __TEMPO_WEBSITE__ : '');
  const PREFIX = 'soundcloud.tempo.timeline.';
  let active = null;
  let key = '';
  let profile = null;
  let scheduleData = null;
  let scheduleOverride = null;
  let schedule = null;
  let suspended = false;
  let keyOverride = null;
  let lastPitch = null;
  let panel = null;
  let syncFields = () => {};
  let draft = null;
  let selected = 0;
  let imported = null;
  let dirty = false;
  let dragging = null;
  let dragOffset = 0;
  let zoom = 1;
  let viewStart = 0;
  let lane = 'tempo';
  let speedTop = 1.5;
  let speedBottom = 0.75;
  let speedMode = 'custom';
  const laneViews = {
    tempo: [0.75, 1.5],
    pitch: [readPitchSettings().min, readPitchSettings().max],
  };
  const laneField = () => (lane === 'pitch' ? 'k' : 'r');
  const laneUnit = () => (lane === 'pitch' ? ' st' : '×');
  const lanePoints = (data = draft) =>
    lane === 'pitch'
      ? (data.pitchPoints ?? [
          { t: 0, k: data.keyShift ?? 0, d: 0, c: 'instant' },
        ])
      : data.points;
  const laneStep = () =>
    lane === 'pitch'
      ? Number(el('.pitch-step').value) || 0.5
      : readTempoIncrement();
  let timer = 0;
  let graphWidth = 660;

  function running() {
    return Boolean(profile?.enabled && !suspended);
  }

  function pitchMode() {
    return running() ? (profile.data.pitch ?? null) : null;
  }

  function draftData() {
    return validate({
      ...draft,
      pitch: draft.pitch ?? api.defaultPitchMode,
      keyShift: draft.keyShift ?? api.keyShift ?? 0,
    });
  }

  function syncControls() {
    if (!panel || panel.hidden || !draft) return;
    const current = draft.track === key;
    const playing = current && running();
    let saved = null;
    try {
      saved = JSON.parse(
        localStorage.getItem(storageKey(draft.track)) || 'null',
      );
      if (saved) validate(saved.data);
    } catch {
      saved = null;
    }
    el('.editor-enable').hidden = !saved || (current && profile?.temporary);
    el('.editor-enabled').checked = Boolean(
      saved?.enabled && !(current && suspended),
    );
    el('.editor-apply-once').textContent = playing
      ? 'Stop timeline'
      : 'Apply once';
    el('.editor-apply-once').setAttribute('aria-pressed', String(playing));
    el('.editor-apply-once').disabled = !current;
    el('.editor-revert').hidden = !dirty;
    el('.editor-import').hidden = !imported;
    el('.editor-import').disabled = !imported;
    el('.editor-preview').disabled = !el('.editor-code').value.trim();
    el('.playback-state').textContent = !current
      ? 'Another track is playing'
      : playing
        ? `${profile.temporary ? 'Session' : 'Saved'} timeline · ${api.pitchMode === 'preserve' ? 'Preserve key' : 'Natural'}`
        : suspended && profile?.enabled
          ? 'Timeline stopped'
          : 'Timeline off';
  }

  function stop() {
    if (profile?.temporary) load();
    suspended = true;
    api.normal();
    syncControls();
    wake();
  }

  async function copyDraft(kind, button) {
    button.disabled = true;
    try {
      if (api.canShare === false)
        throw new Error('Sharing needs a full SoundCloud track.');
      const data = draftData();
      const code = encodeProfile(data);
      const text = kind === 'link' ? tempoShareLink(data, website) : code;
      if (kind === 'link' && text.length > 8000) {
        el('.editor-sharing').open = true;
        throw new Error(
          'Too large for a link. Use Copy code in Advanced sharing.',
        );
      }
      try {
        await navigator.clipboard.writeText(text);
        status(kind === 'link' ? 'Link copied.' : 'Code copied.');
      } catch {
        el('.editor-sharing').open = true;
        el('.editor-output').hidden = false;
        el('.share-output').value = text;
        el('.share-output').focus();
        el('.share-output').select();
        status('Copy unavailable. Press Ctrl+C to copy the selected text.');
      }
    } catch (error) {
      status(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function setSpeedRange(mode, center) {
    speedMode = mode;
    if (mode === 'custom') return;
    if (mode === 'fine' || mode === 'close') {
      const data = imported || draft;
      const width = mode === 'fine' ? 0.5 : 0.2;
      const step = mode === 'fine' ? 0.1 : 0.05;
      const rate =
        center ??
        lanePoints(data)[Math.min(selected, lanePoints(data).length - 1)][
          laneField()
        ];
      const bottom = Math.max(0.25, Math.min(4 - width, rate - width / 2));
      speedBottom = round(
        Math.max(0.25, Math.floor(bottom / step + 1e-9) * step),
      );
      speedTop = round(
        Math.min(4, Math.ceil((bottom + width) / step - 1e-9) * step),
      );
    } else {
      speedBottom = 0.25;
      speedTop = Number(mode);
    }
  }

  function revealSpeed(rate) {
    if (speedMode === 'custom' || (rate >= speedBottom && rate <= speedTop))
      return;
    setSpeedRange(
      ['fine', 'close'].includes(speedMode) ? speedMode : rate > 2 ? '4' : '2',
      rate,
    );
  }

  function zoomView(factor) {
    const data = imported || draft;
    const center = viewStart + data.duration / zoom / 2;
    zoom = Math.max(1, Math.min(data.duration, zoom * factor));
    viewStart = Math.max(
      0,
      Math.min(
        data.duration - data.duration / zoom,
        center - data.duration / zoom / 2,
      ),
    );
    draw(data);
  }
  function hasTempoLink() {
    return (
      location.hash.startsWith('#sct=') ||
      (typeof location.search === 'string' &&
        new URLSearchParams(location.search).has('sct'))
    );
  }
  let pendingLink = hasTempoLink() ? location.href : null;
  window.addEventListener('hashchange', () => {
    if (hasTempoLink()) pendingLink = location.href;
    wake();
  });

  const encodeProfile = (value) => encodeTempoCode(validate(value));
  const decodeProfile = (text) =>
    decodeTempoCode(text, validate, api.parseTrack, website);
  const round = (n) => Math.round(n * 1000) / 1000;
  const storageKey = (track) => PREFIX + encodeURIComponent(track);
  const timeLabel = (n) =>
    `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  const preciseTime = (n) =>
    timeLabel(n) +
    (Number.isInteger(round(n))
      ? ''
      : '.' +
        String(Math.round(n * 1000) % 1000)
          .padStart(3, '0')
          .replace(/0+$/, ''));

  const validate = (value) => validateProfile(value, api.parseTrack);

  function displayedDuration() {
    const element = document.querySelector('.playbackTimeline__duration');
    const clock = element?.querySelector('span[aria-hidden="true"]') || element;
    const text = clock?.textContent.trim() || '';
    if (
      text.length > 32 ||
      !/^(?:\d+:[0-5]\d|\d+):[0-5]\d(?:\.\d+)?$/.test(text)
    )
      return 0;
    const duration = text
      .split(':')
      .reduce((total, part) => total * 60 + Number(part), 0);
    return duration >= 1 && duration <= 86400 ? duration : 0;
  }

  function playbackDuration() {
    const duration = active?.duration;
    return Number.isFinite(duration) && duration > 0
      ? duration
      : displayedDuration();
  }

  function shareLink(text) {
    if (!api.copyLinks || typeof text !== 'string' || text.length > 8000)
      return text;
    try {
      const url = new URL(text);
      if (
        url.origin !== 'https://soundcloud.com' ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.has('sct') ||
        api.parseTrack(url.pathname) !== key ||
        !key
      )
        return text;
      const duration = playbackDuration();
      const data =
        profile?.enabled && !suspended
          ? profile.data
          : {
              v: 1,
              track: key,
              duration,
              points: [{ t: 0, r: api.rate, d: 0, c: 'instant' }],
            };
      url.searchParams.set(
        'sct',
        encodeProfile({
          ...data,
          pitch: api.pitchMode,
          keyShift: keyOverride ?? data.keyShift ?? api.keyShift ?? 0,
          ...(keyOverride === null ? {} : { pitchPoints: undefined }),
        }),
      );
      if (website) return tempoShareLink(decodeProfile(url.href), website);
      return url.href.length <= 8000 ? url.href : text;
    } catch {
      return text;
    }
  }

  const evaluate = (data, time) => evaluatePoints(data.points, time);

  function immutableProfile(data) {
    for (const points of [data.points, data.pitchPoints]) {
      if (!points) continue;
      for (const point of points) Object.freeze(point);
      Object.freeze(points);
    }
    return Object.freeze(data);
  }

  function playbackSchedule(audio) {
    if (!key || !active || audio !== active || !running()) return null;
    const data = profile.data;
    if (data.track !== key) return null;
    if (scheduleData !== data || scheduleOverride !== keyOverride) {
      const overridden = keyOverride !== null;
      let minimumRate = data.points[0].r;
      for (let index = 1; index < data.points.length; index++)
        minimumRate = Math.min(minimumRate, data.points[index].r);
      schedule = Object.freeze({
        isConstantFrom(time) {
          const rate = evaluate(data, time);
          const pitch = profilePitchAt(data, time);
          return (
            data.points.every((point) => point.t < time || point.r === rate) &&
            (overridden ||
              !data.pitchPoints ||
              data.pitchPoints.every(
                (point) => point.t < time || point.k === pitch,
              ))
          );
        },
        rateAt(sourceSeconds) {
          if (!Number.isFinite(sourceSeconds))
            throw new RangeError('Timeline source time must be finite');
          return evaluate(data, sourceSeconds);
        },
        minimumRate,
      });
      scheduleData = data;
      scheduleOverride = keyOverride;
    }
    return schedule;
  }

  function load() {
    profile = null;
    keyOverride = null;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(key)) || 'null');
      if (saved)
        profile = {
          data: immutableProfile(validate(saved.data)),
          enabled: saved.enabled === true,
        };
      if (profile?.data.track !== key) profile = null;
    } catch {
      profile = null;
    }
  }

  function observe(audio) {
    if (!active || !audio.paused) active = audio;
    if (audio.dataset.tempoTimelineObserved) return;
    audio.dataset.tempoTimelineObserved = 'true';
    for (const name of [
      'playing',
      'seeking',
      'seeked',
      'timeupdate',
      'loadedmetadata',
      'pause',
      'ended',
    ]) {
      audio.addEventListener(name, () => {
        if (!audio.paused || !active || active === audio) active = audio;
        tick();
      });
    }
  }

  function value() {
    if (!key || !active || !profile?.enabled || suspended) return null;
    return round(evaluate(profile.data, active.currentTime || 0));
  }

  function changeTrack(next) {
    if (key === next) return;
    key = next;
    keyOverride = null;
    active = null;
    suspended = api.applySaved === false;
    load();
    syncControls();
    if (panel && !panel.hidden)
      status(
        draft?.track === key
          ? ''
          : 'Playing track changed. This draft still belongs to the track shown above.',
      );
  }

  function status(message) {
    panel.querySelector('.editor-status').textContent = message;
  }
  function el(selector) {
    return panel.querySelector(selector);
  }
  function close() {
    if (!panel) return;
    panel.hidden = true;
    panel.hidePopover?.();
    wake();
    api.root.querySelector('.settings-button').focus();
  }
  function fit() {
    if (!panel || panel.hidden || api.inline) return;
    panel.style.width = `${Math.min(720, innerWidth - 24)}px`;
    panel.style.left = `${Math.max(12, (innerWidth - Math.min(720, innerWidth - 24)) / 2)}px`;
    panel.style.top = '50%';
    panel.style.bottom = 'auto';
    panel.style.transform = 'translateY(-50%)';
  }

  function create() {
    panel = document.createElement('section');
    panel.className = 'tempo-editor';
    panel.setAttribute('role', api.inline ? 'region' : 'dialog');
    panel.setAttribute('aria-label', 'Tempo timeline editor');
    if (!api.inline) panel.setAttribute('popover', 'manual');
    else panel.classList.add('tempo-editor-inline');
    panel.hidden = true;
    panel.innerHTML = editorTemplate(Boolean(api.inline));
    api.root.append(panel);
    for (const button of panel.querySelectorAll('[data-lane]'))
      button.onclick = () => {
        laneViews[lane] = [speedBottom, speedTop];
        lane = button.dataset.lane;
        if (lane === 'pitch' && !draft.pitchPoints)
          draft.pitchPoints = lanePoints().map((point) => ({ ...point }));
        [speedBottom, speedTop] = laneViews[lane];
        speedMode = 'custom';
        selected = 0;
        refresh();
      };
    el('.pitch-step').value = String(readPitchSettings().step);
    el('.pitch-step').onchange = () => {
      const step = Number(el('.pitch-step').value);
      if (!Number.isFinite(step) || step < 0.001 || step > 12) {
        el('.pitch-step').value = '0.5';
        status('Choose a step between 0.001 and 12 semitones.');
      }
      try {
        localStorage.setItem(
          pitchSettingsKey,
          JSON.stringify({
            ...readPitchSettings(),
            step: Number(el('.pitch-step').value),
          }),
        );
        api.pitchControlsChanged?.();
      } catch {
        status('Pitch step could not be saved.');
      }
      refresh();
    };
    el('.pitch-clear').onclick = () => {
      delete draft.pitchPoints;
      lane = 'tempo';
      [speedBottom, speedTop] = laneViews.tempo;
      selected = 0;
      changed();
    };
    el('.zoom-in').onclick = () => zoomView(2);
    el('.zoom-out').onclick = () => zoomView(0.5);
    el('.zoom-focus').onclick = () => {
      const data = imported || draft;
      const point =
        lanePoints(data)[Math.min(selected, lanePoints(data).length - 1)];
      const fade = point.c === 'instant' ? 0 : point.d;
      const span = Math.min(data.duration, Math.max(1, fade * 1.5));
      zoom = data.duration / span;
      viewStart = Math.max(
        0,
        Math.min(data.duration - span, point.t - fade / 2 - span / 2),
      );
      draw(data);
    };
    el('.zoom-fit').onclick = () => {
      zoom = 1;
      viewStart = 0;
      const values = lanePoints(imported || draft).map((p) => p[laneField()]);
      speedBottom = Math.min(lane === 'pitch' ? -6 : 0.75, ...values);
      speedTop = Math.max(lane === 'pitch' ? 6 : 1.5, ...values);
      speedMode = 'custom';
      draw(imported || draft);
    };
    el('.speed-range').onchange = () => {
      setSpeedRange(el('.speed-range').value);
      draw(imported || draft);
    };
    for (const name of ['min', 'max'])
      el('.speed-' + name).onchange = () => {
        const min = el('.speed-min').valueAsNumber;
        const max = el('.speed-max').valueAsNumber;
        const valid =
          Number.isFinite(min) &&
          Number.isFinite(max) &&
          min >= (lane === 'pitch' ? -12 : 0.25) &&
          max <= (lane === 'pitch' ? 12 : 4) &&
          min < max;
        for (const bound of ['min', 'max'])
          el('.speed-' + bound).setAttribute('aria-invalid', String(!valid));
        if (!valid) {
          status(
            (lane === 'pitch'
              ? 'Use −12 to +12 semitones'
              : 'Use 0.25× to 4×') + ', with the minimum below the maximum.',
          );
          return;
        }
        speedBottom = min;
        speedTop = max;
        speedMode = 'custom';
        laneViews[lane] = [min, max];
        status('');
        draw(imported || draft);
      };
    el('.editor-pan').oninput = () => {
      viewStart = Number(el('.editor-pan').value);
      draw(imported || draft);
    };
    el('.editor-point-picker').onchange = () => {
      selected = Number(el('.editor-point-picker').value);
      const p = lanePoints()[selected];
      const span = draft.duration / zoom;
      if (p.t < viewStart || p.t > viewStart + span)
        viewStart = Math.max(
          0,
          Math.min(draft.duration - span, p.t - span / 2),
        );
      revealSpeed(p[laneField()]);
      refresh();
    };
    el('.editor-close').onclick = close;
    el('.editor-close').hidden = Boolean(api.inline);
    panel.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !api.inline) {
        e.preventDefault();
        close();
      }
    });
    el('.editor-enabled').onchange = () => {
      const enabled = el('.editor-enabled').checked;
      try {
        const stored = JSON.parse(
          localStorage.getItem(storageKey(draft.track)) || 'null',
        );
        if (!stored) throw new Error('Save this timeline first.');
        stored.data = validate(stored.data);
        localStorage.setItem(
          storageKey(draft.track),
          JSON.stringify({ data: stored.data, enabled }),
        );
        if (draft.track === key) {
          load();
          suspended = false;
          if (!enabled) api.normal();
          api.refresh();
        }
        status(
          enabled
            ? 'Saved timeline enabled.'
            : 'Timeline disabled. Current track returns to 1×.',
        );
        syncControls();
      } catch (e) {
        el('.editor-enabled').checked = !enabled;
        status(e.message);
      }
    };
    for (const name of ['time', 'rate', 'duration', 'curve'])
      el('.point-' + name).onchange = updatePoint;
    el('.point-add').onclick = () =>
      addPoint(
        draft.track === key && active ? active.currentTime : draft.duration / 2,
        lane === 'pitch' ? (draft.keyShift ?? 0) : 1,
      );
    el('.point-remove').onclick = () => {
      if (!selected) return;
      lanePoints().splice(selected, 1);
      selected = Math.max(0, selected - 1);
      normalize();
      changed();
    };
    el('.editor-revert').onclick = () => {
      const track = draft.track;
      dirty = false;
      draft = null;
      open(track);
    };
    el('.editor-save').onclick = () => {
      try {
        const data = draftData();
        localStorage.setItem(
          storageKey(data.track),
          JSON.stringify({ data, enabled: true }),
        );
        if (data.track === key) {
          load();
          suspended = false;
          api.refresh();
        }
        draft = data;
        dirty = false;
        syncControls();
        status('Timeline saved.');
      } catch (e) {
        status(`Not saved: ${e.message}`);
      }
    };
    el('.editor-apply-once').onclick = () => {
      if (draft.track !== key) return;
      if (running()) {
        stop();
        status('Timeline stopped · 1×');
        return;
      }
      try {
        profile = {
          data: immutableProfile(draftData()),
          enabled: true,
          temporary: true,
        };
        keyOverride = null;
        suspended = false;
        api.refresh();
        syncControls();
        status('Applied for this session.');
      } catch (error) {
        status(error.message);
      }
    };
    el('.editor-link').onclick = (event) =>
      copyDraft('link', event.currentTarget);
    el('.editor-copy').onclick = (event) =>
      copyDraft('code', event.currentTarget);
    el('.editor-pitch').onchange = () => {
      draft.pitch = el('.editor-pitch').value;
      changed();
    };
    el('.editor-key-shift').onchange = () => {
      const value = Number(el('.editor-key-shift').value);
      if (validKeyShift(value)) {
        draft.keyShift = value;
        changed();
      } else refresh();
    };
    el('.editor-code').oninput = () => {
      imported = null;
      el('.editor-import').disabled = true;
      el('.import-summary').textContent = '';
      syncControls();
      draw();
    };
    el('.editor-preview').onclick = () => {
      imported = null;
      syncControls();
      try {
        imported = decodeProfile(el('.editor-code').value);
        el('.import-summary').textContent =
          `${imported.track} · ${timeLabel(imported.duration)} · ${imported.points.length} points · ${(imported.pitch ?? api.defaultPitchMode) === 'preserve' ? 'Preserve key' : 'Natural'}`;
        draw(imported);
        syncControls();
        status('Preview only · playback unchanged.');
      } catch (e) {
        syncControls();
        draw();
        status(`Cannot import: ${e.message}`);
      }
    };
    el('.editor-import').onclick = () => {
      if (!imported) return;
      draft = structuredClone(imported);
      lane = 'tempo';
      [speedBottom, speedTop] = laneViews.tempo;
      imported = null;
      selected = 0;
      dirty = true;
      el('.editor-import').disabled = true;
      el('.import-summary').textContent = '';
      refresh();
      status('Draft loaded.');
    };
    syncFields = enhanceTempoFields(panel);
    const graph = el('.editor-graph');
    const coords = (event) => {
      const bounds = graph.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * graphWidth;
      const y = ((event.clientY - bounds.top) / bounds.height) * 220;
      const time =
        viewStart + (((x - 44) / (graphWidth - 56)) * draft.duration) / zoom;
      const rate = speedTop - ((y - 12) / 176) * (speedTop - speedBottom);
      return {
        t: Math.max(0, Math.min(draft.duration, time)),
        [laneField()]: Math.max(speedBottom, Math.min(speedTop, rate)),
      };
    };
    graph.addEventListener('dblclick', (e) => {
      if (!e.target.closest('[data-index]') && !imported) {
        const p = coords(e);
        addPoint(p.t, p[laneField()]);
      }
    });
    graph.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('[data-index]');
      if (imported || e.button !== 0 || !target) return;
      selected = Number(target.dataset.index);
      dragging = target.dataset.kind;
      dragOffset =
        dragging === 'ramp'
          ? coords(e).t - (lanePoints()[selected].t - lanePoints()[selected].d)
          : 0;
      graph.setPointerCapture(e.pointerId);
      e.preventDefault();
      refresh();
    });
    graph.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = coords(e),
        point = lanePoints()[selected];
      const previous = lanePoints()[selected - 1];
      if (dragging === 'ramp')
        point.d = round(
          point.t - Math.max(previous.t, Math.min(point.t, p.t - dragOffset)),
        );
      else {
        if (selected)
          point.t = round(
            Math.max(
              previous.t + 0.01,
              Math.min(
                (lanePoints()[selected + 1]?.t ?? draft.duration + 0.01) - 0.01,
                p.t,
              ),
            ),
          );
        const step = e.shiftKey ? laneStep() / 5 : laneStep();
        point[laneField()] = round(
          Math.max(
            lane === 'pitch' ? -12 : 0.25,
            Math.min(
              lane === 'pitch' ? 12 : 4,
              Math.round(p[laneField()] / step) * step,
            ),
          ),
        );
      }
      normalize();
      changed();
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
      graph.addEventListener(name, () => {
        dragging = null;
      });
    graph.addEventListener('keydown', (e) => {
      const target = e.target.closest('[data-index]');
      if (!target || imported) return;
      selected = Number(target.dataset.index);
      if (target.dataset.kind === 'ramp' && adjustFadeStart(e)) return;
      if (
        target.dataset.kind !== 'ramp' &&
        ['ArrowUp', 'ArrowDown'].includes(e.key)
      ) {
        e.preventDefault();
        const point = lanePoints()[selected];
        const step = laneStep() / (e.shiftKey ? 5 : 1);
        point[laneField()] = round(
          Math.max(
            lane === 'pitch' ? -12 : 0.25,
            Math.min(
              lane === 'pitch' ? 12 : 4,
              point[laneField()] + (e.key === 'ArrowUp' ? step : -step),
            ),
          ),
        );
        changed();
        el('.point.selected')?.focus({ preventScroll: true });
        return;
      }
      if (['Enter', ' '].includes(e.key)) {
        e.preventDefault();
        refresh();
        const advanced = panel.querySelector('.editor-advanced');
        if (advanced) advanced.open = true;
        el(
          target.dataset.kind === 'ramp'
            ? '.point-duration'
            : selected
              ? '.point-time'
              : '.point-rate',
        ).focus();
      }
    });
    window.addEventListener('resize', () => {
      fit();
      if (panel && !panel.hidden && draft) draw(imported || draft);
    });
  }

  function normalize() {
    lanePoints().forEach((p, i) => {
      p.d = i ? round(Math.min(p.d, p.t - lanePoints()[i - 1].t)) : 0;
    });
  }

  function adjustFadeStart(event) {
    const point = lanePoints()[selected];
    const previous = lanePoints()[selected - 1];
    const step = event.shiftKey ? 0.1 : 1;
    const start = point.t - point.d;
    const positions = {
      ArrowLeft: start - step,
      ArrowRight: start + step,
      Home: previous.t,
      End: point.t,
    };
    if (!(event.key in positions)) return false;
    event.preventDefault();
    point.d = round(
      point.t - Math.max(previous.t, Math.min(point.t, positions[event.key])),
    );
    const nextStart = point.t - point.d;
    const span = draft.duration / zoom;
    if (nextStart < viewStart || nextStart > viewStart + span)
      viewStart = Math.max(
        0,
        Math.min(draft.duration - span, nextStart - span / 2),
      );
    changed();
    el('.ramp')?.focus({ preventScroll: true });
    return true;
  }

  function drawFadeStart(svg, point, previous, position) {
    const labelX =
      position + 100 <= graphWidth - 12 ? position + 8 : position - 100;
    const labelLeft = Math.max(44, Math.min(graphWidth - 104, labelX));
    const handle = svg('g', {
      class: 'ramp',
      'data-index': selected,
      'data-kind': 'ramp',
      tabindex: 0,
      role: 'slider',
      'aria-label': 'Fade start',
      'aria-orientation': 'horizontal',
      'aria-valuemin': previous.t,
      'aria-valuemax': point.t,
      'aria-valuenow': round(point.t - point.d),
      'aria-valuetext': `${preciseTime(round(point.t - point.d))}, ${point.d} seconds fade`,
    });
    svg('title', {}, 'Drag to change fade duration', handle);
    svg(
      'rect',
      { x: position - 12, y: 12, width: 24, height: 176, fill: 'transparent' },
      null,
      handle,
    );
    svg(
      'line',
      { x1: position, x2: position, y1: 12, y2: 188, class: 'ramp-line' },
      null,
      handle,
    );
    svg(
      'rect',
      { x: labelLeft, y: 4, width: 92, height: 44, fill: 'transparent' },
      null,
      handle,
    );
    svg(
      'rect',
      {
        x: labelLeft,
        y: 14,
        width: 92,
        height: 24,
        rx: 3,
        class: 'ramp-label',
      },
      null,
      handle,
    );
    svg(
      'path',
      {
        d: `M${labelLeft + 8} 26h12m-9 -3-3 3 3 3m6 -6 3 3-3 3`,
        class: 'ramp-arrow',
      },
      null,
      handle,
    );
    svg('text', { x: labelLeft + 26, y: 30 }, 'Fade start', handle);
  }
  function changed() {
    dirty = true;
    imported = null;
    el('.editor-import').disabled = true;
    el('.editor-output').hidden = true;
    refresh();
    status('Unsaved changes');
    if (api.inline) api.refresh();
  }
  function updatePoint() {
    const p = lanePoints()[selected];
    const t = Number(el('.point-time').value),
      r = Number(el('.point-rate').value),
      d = Number(el('.point-duration').value);
    if (
      [el('.point-time'), el('.point-rate'), el('.point-duration')].some(
        (n) => n.value === '',
      ) ||
      ![t, r, d].every(Number.isFinite)
    ) {
      status('Enter valid numbers for time, speed, and duration.');
      refresh();
      return;
    }
    p.t = selected
      ? round(
          Math.max(
            lanePoints()[selected - 1].t + 0.01,
            Math.min(
              (lanePoints()[selected + 1]?.t ?? draft.duration + 0.01) - 0.01,
              t,
            ),
          ),
        )
      : 0;
    p[laneField()] = round(
      Math.max(
        lane === 'pitch' ? -12 : 0.25,
        Math.min(lane === 'pitch' ? 12 : 4, r),
      ),
    );
    revealSpeed(p[laneField()]);
    p.d = Math.max(0, d);
    p.c = el('.point-curve').value;
    normalize();
    changed();
  }
  function addPoint(time, speed) {
    if (lanePoints().length >= 200) {
      status('Maximum 200 points per timeline.');
      return;
    }
    const t = round(Math.max(0.01, Math.min(draft.duration, time)));
    if (lanePoints().some((p) => Math.abs(p.t - t) < 0.01)) {
      status('A point already exists here. Move it or choose another time.');
      return;
    }
    const previous = [...lanePoints()].reverse().find((p) => p.t < t);
    const point = {
      t,
      [laneField()]: round(
        Math.max(
          lane === 'pitch' ? -12 : 0.25,
          Math.min(
            lane === 'pitch' ? 12 : 4,
            Math.round(speed / laneStep()) * laneStep(),
          ),
        ),
      ),
      d: Math.min(4, t - previous.t),
      c: 'linear',
    };
    lanePoints().push(point);
    lanePoints().sort((a, b) => a.t - b.t);
    selected = lanePoints().indexOf(point);
    normalize();
    changed();
  }
  function draw(data = draft) {
    const graph = el('.editor-graph');
    graphWidth = Math.max(260, graph.clientWidth);
    graph.setAttribute('viewBox', `0 0 ${graphWidth} 220`);
    const plotWidth = graphWidth - 56;
    zoom = Math.max(1, Math.min(data.duration, zoom));
    const span = data.duration / zoom;
    viewStart = Math.max(0, Math.min(data.duration - span, viewStart));
    el('.zoom-label').textContent = `Time zoom ${round(zoom)}×`;
    el('.zoom-in').disabled = zoom >= data.duration;
    el('.zoom-out').disabled = zoom <= 1;
    el('.speed-range').value = speedMode;
    for (const [name, value] of [
      ['min', speedBottom],
      ['max', speedTop],
    ]) {
      el('.speed-' + name).value = String(value);
      el('.speed-' + name).setAttribute('aria-invalid', 'false');
    }
    const pan = el('.editor-pan');
    const visibleRange = `${preciseTime(round(viewStart))}–${preciseTime(round(viewStart + span))}`;
    pan.max = String(Math.max(0, data.duration - span));
    pan.value = String(viewStart);
    syncTempoRange(pan);
    pan.disabled = zoom === 1;
    pan.setAttribute(
      'aria-valuetext',
      `Viewing ${visibleRange} of ${timeLabel(data.duration)}`,
    );
    el('.timeline-navigation').hidden = zoom === 1;
    el('.view-window').textContent = visibleRange;
    el('.timeline-end').textContent = timeLabel(data.duration);
    const chosen =
      lanePoints(data)[Math.min(selected, lanePoints(data).length - 1)];
    el('.zoom-focus').hidden = !chosen.d || chosen.c === 'instant';
    el('.point-readout').textContent =
      `${chosen[laneField()]}${laneUnit()} · ${chosen.d ? chosen.d + 's fade' : 'Instant'}`;
    const picker = el('.editor-point-picker');
    picker.replaceChildren(
      ...lanePoints(data).map((point, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${index + 1} · ${preciseTime(point.t)} · ${point[laneField()]}${laneUnit()}`;
        return option;
      }),
    );
    picker.value = String(Math.min(selected, lanePoints(data).length - 1));
    picker.disabled = Boolean(imported);
    syncFields();
    graph.replaceChildren();
    const svg = (name, attrs, label, parent = graph) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', name);
      for (const [k, v] of Object.entries(attrs))
        node.setAttribute(k, String(v));
      if (label) node.textContent = label;
      parent.append(node);
      return node;
    };
    const x = (t) => 44 + ((t - viewStart) / span) * plotWidth,
      y = (r) => 12 + ((speedTop - r) / (speedTop - speedBottom)) * 176;
    const defs = svg('defs', {});
    const clip = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'clipPath',
    );
    clip.id = 'tempo-plot-clip';
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [k, v] of Object.entries({
      x: 44,
      y: 12,
      width: plotWidth,
      height: 176,
    }))
      rect.setAttribute(k, v);
    clip.append(rect);
    defs.append(clip);
    const step =
      speedMode === 'custom'
        ? [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 6].find(
            (value) => value >= (speedTop - speedBottom) / 8,
          )
        : speedMode === 'fine'
          ? 0.1
          : 0.05;
    const first = Math.ceil(speedBottom / step - 1e-9);
    const last = Math.floor(speedTop / step + 1e-9);
    const ticks = ['fine', 'close', 'custom'].includes(speedMode)
      ? Array.from({ length: last - first + 1 }, (_, i) =>
          round((first + i) * step),
        )
      : speedTop <= 2
        ? Array.from({ length: speedTop * 4 }, (_, i) => (i + 1) / 4)
        : [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    if (!ticks.includes(speedBottom)) ticks.unshift(speedBottom);
    if (speedMode === 'custom' && !ticks.includes(speedTop))
      ticks.push(speedTop);
    for (const r of ticks) {
      svg('line', {
        x1: 44,
        x2: graphWidth - 12,
        y1: y(r),
        y2: y(r),
        class: 'grid',
        ...(r === (lane === 'pitch' ? 0 : 1)
          ? {
              style:
                'stroke:var(--tempo-fg);stroke-width:1;stroke-dasharray:3 4',
            }
          : {}),
      });
      if (
        r === speedBottom ||
        (y(speedBottom) - y(r) >= 14 &&
          (r === speedTop || y(r) - y(speedTop) >= 14))
      )
        svg('text', { x: 2, y: y(r) + 4 }, `${r}${laneUnit()}`);
    }
    for (let i = 0; i <= 8; i++) {
      const time = viewStart + (span * i) / 8;
      svg('line', { x1: x(time), x2: x(time), y1: 12, y2: 188, class: 'grid' });
      if (i % (graphWidth < 480 ? 4 : 2)) continue;
      svg(
        'text',
        {
          x: x(time),
          y: 212,
          'text-anchor': i === 8 ? 'end' : 'start',
        },
        span < 10 ? preciseTime(round(time)) : timeLabel(time),
      );
    }
    let path = `M${x(0)},${y(lanePoints(data)[0][laneField()])}`;
    let previous = lanePoints(data)[0];
    for (const point of lanePoints(data).slice(1)) {
      const start = point.c === 'instant' ? point.t : point.t - point.d;
      path += ` L${x(start)},${y(previous[laneField()])}`;
      for (let i = 1; i <= 24; i++) {
        const t = start + ((point.t - start) * i) / 24;
        path += ` L${x(t)},${y(evaluatePoints(lanePoints(data), t, laneField()))}`;
      }
      previous = point;
    }
    path += ` L${x(data.duration)},${y(previous[laneField()])}`;
    svg('path', {
      d: path,
      class: 'curve',
      'clip-path': 'url(#tempo-plot-clip)',
    });
    lanePoints(data).forEach((p, i) => {
      if (i === selected && i && p.d && p.c !== 'instant')
        svg('rect', {
          x: x(p.t - p.d),
          y: 12,
          width: x(p.t) - x(p.t - p.d),
          height: 176,
          fill: 'var(--tempo-accent)',
          opacity: 0.08,
          'clip-path': 'url(#tempo-plot-clip)',
          'pointer-events': 'none',
        });
      if (
        i === selected &&
        i &&
        !imported &&
        p.c !== 'instant' &&
        p.t - p.d >= viewStart &&
        p.t - p.d <= viewStart + span
      ) {
        drawFadeStart(svg, p, lanePoints(data)[i - 1], x(p.t - p.d));
      }
      if (
        p.t < viewStart ||
        p.t > viewStart + span ||
        p[laneField()] > speedTop ||
        p[laneField()] < speedBottom
      )
        return;
      if (!imported)
        svg('ellipse', {
          cx: x(p.t),
          cy: y(p[laneField()]),
          rx: 12,
          ry: 12,
          fill: 'transparent',
          'data-index': i,
          'data-kind': 'point',
          'aria-hidden': 'true',
          class: 'point-hit',
          style: 'cursor:grab',
        });
      const dot = svg('circle', {
        cx: x(p.t),
        cy: y(p[laneField()]),
        r: 7,
        class: `point ${i === selected ? 'selected' : ''}`,
        'data-index': i,
        'data-kind': 'point',
        tabindex: imported ? -1 : 0,
        role: 'button',
        'aria-label': `Point ${i + 1}: ${p.t} seconds, ${p[laneField()]}${laneUnit()}. Enter to edit.`,
      });
      const title = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'title',
      );
      title.textContent = `${preciseTime(p.t)} · ${p[laneField()]}${laneUnit()}`;
      dot.append(title);
    });
    svg('line', {
      class: 'playhead',
      x1: 44,
      x2: 44,
      y1: 12,
      y2: 188,
      stroke: 'var(--tempo-fg)',
      'stroke-dasharray': '3 3',
      'pointer-events': 'none',
    });
  }
  function refresh() {
    const p = lanePoints()[selected];
    for (const button of panel.querySelectorAll('[data-lane]'))
      button.setAttribute('aria-pressed', String(button.dataset.lane === lane));
    el('.pitch-options').hidden = lane !== 'pitch';
    el('.speed-range').closest('label').hidden = lane === 'pitch';
    el('.target-label').textContent =
      lane === 'pitch' ? 'Target pitch (semitones)' : 'Target speed';
    el('.editor-point-picker').setAttribute(
      'aria-label',
      'Selected ' + lane + ' point',
    );
    el('.editor-graph').setAttribute(
      'aria-label',
      lane + ' over original song time',
    );
    for (const selector of ['.point-rate', '.speed-min', '.speed-max']) {
      el(selector).min = lane === 'pitch' ? '-12' : '0.25';
      el(selector).max = lane === 'pitch' ? '12' : '4';
    }
    el('.point-rate').step = String(laneStep());
    for (const unit of panel.querySelectorAll('.axis-unit'))
      unit.textContent = laneUnit();
    el('.editor-key-shift').disabled = Boolean(draft.pitchPoints);
    el('.editor-track').textContent = draft.track;
    el('.editor-track').href = 'https://soundcloud.com' + draft.track;
    el('.point-time').value = p.t;
    el('.point-time').disabled = selected === 0;
    el('.point-rate').value = p[laneField()];
    el('.point-duration').value = p.d;
    el('.point-duration').disabled = selected === 0 || p.c === 'instant';
    el('.point-curve').value = p.c;
    el('.point-curve').disabled = selected === 0;
    el('.point-remove').disabled = selected === 0;
    el('.editor-pitch').value = draft.pitch ?? api.defaultPitchMode;
    el('.editor-key-shift').value = draft.keyShift ?? 0;
    syncControls();
    draw();
  }
  function open(requested) {
    const target = requested || (dirty && draft ? draft.track : key);
    if (requested && dirty && draft?.track !== requested) {
      api.message(
        'An unsaved timeline is open. Finish or discard it before editing another track.',
      );
      return;
    }
    if (!panel) create();
    imported = null;
    el('.editor-import').disabled = true;
    el('.import-summary').textContent = '';
    if (!draft || !dirty) {
      let stored = null;
      try {
        stored = JSON.parse(localStorage.getItem(storageKey(target)) || 'null');
        if (stored) stored.data = validate(stored.data);
        if (stored?.data.track !== target) stored = null;
      } catch {
        stored = null;
      }
      const duration = playbackDuration();
      if (!target) {
        api.message('Play a track before opening its tempo editor.');
        return;
      }
      if (!stored && (target !== key || duration <= 0)) {
        api.message(
          'Track duration is not available yet. Load a track and retry.',
        );
        return;
      }
      draft = stored?.data || {
        v: 1,
        track: target,
        duration,
        points: [{ t: 0, r: api.rate, d: 0, c: 'instant' }],
        pitch: api.pitchMode,
        keyShift: api.keyShift ?? 0,
      };
      if (target === key && keyOverride !== null) {
        draft.keyShift = keyOverride;
        delete draft.pitchPoints;
      }
      lane = 'tempo';
      [speedBottom, speedTop] = laneViews.tempo;
      selected = 0;
    }
    api.closeSettings?.();
    panel.hidden = false;
    if (!api.inline) panel.showPopover?.();
    fit();
    refresh();
    status(
      dirty
        ? 'Unsaved draft restored.'
        : 'Double-click the graph to add a point.',
    );
    if (!api.inline) el('.editor-close').focus();
    wake();
  }
  function openPendingLink() {
    if (!pendingLink || !api.ready) return;
    const link = pendingLink;
    pendingLink = null;
    try {
      const data = decodeProfile(link);
      if (dirty) {
        api.message(
          'Tempo link received. Your unsaved draft was kept; paste the link in the editor to preview it.',
        );
        return;
      }
      draft = data;
      selected = 0;
      dirty = true;
      open();
      status('');
    } catch (error) {
      api.message('Cannot open tempo link: ' + error.message);
    }
  }

  function updatePlayhead() {
    if (document.hidden || !panel || panel.hidden || !draft || imported) return;
    const line = el('.playhead');
    if (!line) return;
    const visible =
      active &&
      draft.track === key &&
      active.currentTime >= viewStart &&
      active.currentTime <= viewStart + draft.duration / zoom;
    line.style.display = visible ? '' : 'none';
    if (!visible) return;
    const x =
      44 +
      ((Math.min(draft.duration, active.currentTime) - viewStart) /
        (draft.duration / zoom)) *
        (graphWidth - 56);
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
  }

  function tick() {
    const nextRate = value();
    const nextPitch = effectivePitch();
    const pitchChanged = nextPitch !== lastPitch;
    lastPitch = nextPitch;
    if ((nextRate !== null && nextRate !== api.rate) || pitchChanged)
      api.refresh();
    updatePlayhead();
    wake();
  }

  function wake() {
    openPendingLink();
    const automate =
      running() &&
      (profile.data.points.length > 1 ||
        (keyOverride === null && profile.data.pitchPoints?.length > 1));
    const animate =
      !document.hidden && panel && !panel.hidden && draft && !imported;
    if (!active || active.paused || active.ended || (!automate && !animate)) {
      clearTimeout(timer);
      timer = 0;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      tick();
    }, 50);
  }
  document.addEventListener('visibilitychange', wake);
  function refreshSaved(track) {
    if (track === key && !profile?.temporary) {
      const wasRunning = running();
      load();
      suspended = api.applySaved === false;
      if (wasRunning && !profile?.enabled) api.normal();
      else api.refresh();
    }
    syncControls();
    wake();
  }
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === storageKey(key)) {
      refreshSaved(key);
    }
  });
  function effectivePitch() {
    return (
      keyOverride ??
      (running()
        ? profilePitchAt(profile.data, active?.currentTime || 0)
        : null)
    );
  }
  return {
    wake,
    pitchMode,
    shareLink,
    keyShift: effectivePitch,
    setKeyShift(value) {
      if (!validKeyShift(value)) throw new RangeError('Invalid key shift');
      keyOverride = value;
      if (draft?.track === key) {
        draft.keyShift = value;
        delete draft.pitchPoints;
        selected = 0;
        dirty = true;
        if (panel && !panel.hidden) {
          refresh();
          status('Pitch changed. Save to keep it for this track.');
        }
      }
    },
    observe,
    value,
    playbackSchedule,
    changeTrack,
    open,
    validate,
    draftProfile: () => (draft ? draftData() : null),
    draftPlayback(time) {
      return draft
        ? {
            rate: evaluate(draft, time),
            pitch: draft.pitch ?? api.defaultPitchMode,
            keyShift: profilePitchAt(draft, time),
          }
        : null;
    },
    loadDraft(data) {
      draft = validate(data);
      selected = 0;
      lane = 'tempo';
      [speedBottom, speedTop] = laneViews.tempo;
      dirty = true;
      open();
    },
    refreshSaved,
    suspend() {
      suspended = true;
      syncControls();
      wake();
    },
    contains(target) {
      return panel?.contains(target);
    },
  };
}
