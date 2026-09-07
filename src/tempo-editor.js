import { editorTemplate } from './tempo-editor-template.js';
import { syncTempoRange } from './tempo-range.js';

export function createTempoEditor(api) {
  const PREFIX = 'soundcloud.tempo.timeline.';
  const curves = ['instant', 'linear', 'ease-in', 'ease-out', 'smooth'];
  let active = null;
  let key = '';
  let profile = null;
  let scheduleData = null;
  let schedule = null;
  let suspended = false;
  let panel = null;
  let draft = null;
  let selected = 0;
  let imported = null;
  let dirty = false;
  let dragging = null;
  let dragOffset = 0;
  let zoom = 1;
  let viewStart = 0;
  let speedTop = 2;
  let speedBottom = 0.025;
  let speedMode = '2';
  let timer = 0;
  let graphWidth = 660;

  function running() {
    return Boolean(profile?.enabled && !suspended);
  }

  function pitchMode() {
    return running() ? (profile.data.pitch ?? null) : null;
  }

  function draftData() {
    return validate({ ...draft, pitch: draft.pitch ?? api.defaultPitchMode });
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
      const data = draftData();
      const code = encodeProfile(data);
      const text =
        kind === 'link'
          ? `https://soundcloud.com${data.track}#sct=${code}`
          : code;
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
    if (mode === 'fine' || mode === 'close') {
      const data = imported || draft;
      const width = mode === 'fine' ? 0.5 : 0.2;
      const step = mode === 'fine' ? 0.1 : 0.05;
      const rate =
        center ?? data.points[Math.min(selected, data.points.length - 1)].r;
      const bottom = Math.max(0.025, Math.min(4 - width, rate - width / 2));
      speedBottom = round(
        Math.max(0.025, Math.floor(bottom / step + 1e-9) * step),
      );
      speedTop = round(
        Math.min(4, Math.ceil((bottom + width) / step - 1e-9) * step),
      );
    } else {
      speedBottom = 0.025;
      speedTop = Number(mode);
    }
  }

  function revealSpeed(rate) {
    if (rate >= speedBottom && rate <= speedTop) return;
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
  let pendingLink = location.hash.startsWith('#sct=') ? location.href : null;
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#sct=')) pendingLink = location.href;
    wake();
  });

  function encodeProfile(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(validate(value)));
    return (
      'SCT1.' +
      btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '')
    );
  }

  function decodeProfile(text) {
    let code = text.trim();
    let linkedTrack = null;
    if (code.startsWith('https://')) {
      if (code.length > 8000)
        throw new Error('Link is too long. Ask for the tempo code instead.');
      const url = new URL(code);
      if (
        url.origin !== 'https://soundcloud.com' ||
        url.username ||
        url.password ||
        !url.hash.startsWith('#sct=')
      )
        throw new Error('Use a SoundCloud tempo link.');
      linkedTrack = api.parseTrack(url.pathname);
      if (!linkedTrack) throw new Error('The link must point to a track.');
      code = url.hash.slice(5);
    }
    if (code.length > 50000 || !/^SCT1\.[A-Za-z0-9_-]+$/.test(code))
      throw new Error('Paste a valid SCT1 code or SoundCloud tempo link.');
    const bytes = Uint8Array.from(
      atob(code.slice(5).replaceAll('-', '+').replaceAll('_', '/')),
      (c) => c.charCodeAt(0),
    );
    const data = validate(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (linkedTrack !== null && linkedTrack !== data.track)
      throw new Error('The link and tempo settings refer to different tracks.');
    return data;
  }
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

  function validate(value) {
    if (
      !value ||
      value.v !== 1 ||
      typeof value.track !== 'string' ||
      api.parseTrack(value.track) !== value.track ||
      !Number.isFinite(value.duration) ||
      value.duration < 1 ||
      value.duration > 86400 ||
      !Array.isArray(value.points) ||
      !value.points.length ||
      value.points.length > 200
    ) {
      throw new Error('Invalid tempo code or unsupported version.');
    }
    const points = value.points.map((p, i) => {
      if (
        !p ||
        ![p.t, p.r, p.d].every(Number.isFinite) ||
        p.t < 0 ||
        p.t > value.duration ||
        p.r < 0.025 ||
        p.r > 4 ||
        p.d < 0 ||
        !curves.includes(p.c) ||
        (i === 0 && (p.t !== 0 || p.d !== 0)) ||
        (i > 0 &&
          (p.t <= value.points[i - 1].t || p.t - p.d < value.points[i - 1].t))
      ) {
        throw new Error(
          'Invalid points: ramps must not overlap and speeds must be 0.025–4×.',
        );
      }
      return { t: round(p.t), r: round(p.r), d: round(p.d), c: p.c };
    });
    for (let i = 1; i < points.length; i++) {
      if (
        points[i].t <= points[i - 1].t ||
        round(points[i].t - points[i].d) < points[i - 1].t
      ) {
        throw new Error('Points are too close together.');
      }
    }
    if (
      value.pitch !== undefined &&
      !['natural', 'preserve'].includes(value.pitch)
    )
      throw new Error('Invalid pitch mode.');
    return {
      v: 1,
      track: value.track,
      duration: value.duration,
      points,
      ...(value.pitch === undefined ? {} : { pitch: value.pitch }),
    };
  }

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
      url.hash = 'sct=' + encodeProfile({ ...data, pitch: api.pitchMode });
      return url.href.length <= 8000 ? url.href : text;
    } catch {
      return text;
    }
  }

  function evaluate(data, time) {
    let previous = data.points[0];
    for (let index = 1; index < data.points.length; index++) {
      const point = data.points[index];
      if (time < point.t) {
        if (!point.d || point.c === 'instant' || time <= point.t - point.d)
          return previous.r;
        let x = Math.max(0, Math.min(1, (time - point.t + point.d) / point.d));
        if (point.c === 'ease-in') x *= x;
        else if (point.c === 'ease-out') x = 1 - (1 - x) ** 2;
        else if (point.c === 'smooth') x = x * x * (3 - 2 * x);
        return previous.r + (point.r - previous.r) * x;
      }
      previous = point;
    }
    return previous.r;
  }

  function immutableProfile(data) {
    for (const point of data.points) Object.freeze(point);
    Object.freeze(data.points);
    return Object.freeze(data);
  }

  function playbackSchedule(audio) {
    if (!key || !active || audio !== active || !running()) return null;
    const data = profile.data;
    if (data.track !== key) return null;
    if (scheduleData !== data) {
      let minimumRate = data.points[0].r;
      for (let index = 1; index < data.points.length; index++)
        minimumRate = Math.min(minimumRate, data.points[index].r);
      schedule = Object.freeze({
        rateAt(sourceSeconds) {
          if (!Number.isFinite(sourceSeconds))
            throw new RangeError('Timeline source time must be finite');
          return evaluate(data, sourceSeconds);
        },
        minimumRate,
      });
      scheduleData = data;
    }
    return schedule;
  }

  function load() {
    profile = null;
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
    active = null;
    suspended = false;
    load();
    syncControls();
    if (panel && !panel.hidden)
      status(
        'Playing track changed. This draft still belongs to the track shown above.',
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
    if (!panel || panel.hidden) return;
    panel.style.width = `${Math.min(720, innerWidth - 24)}px`;
    panel.style.left = `${Math.max(12, (innerWidth - Math.min(720, innerWidth - 24)) / 2)}px`;
    panel.style.top = '50%';
    panel.style.bottom = 'auto';
    panel.style.transform = 'translateY(-50%)';
  }

  function create() {
    panel = document.createElement('section');
    panel.className = 'tempo-editor';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Tempo timeline editor');
    panel.setAttribute('popover', 'manual');
    panel.hidden = true;
    panel.innerHTML = editorTemplate();
    api.root.append(panel);
    el('.zoom-in').onclick = () => zoomView(2);
    el('.zoom-out').onclick = () => zoomView(0.5);
    el('.zoom-focus').onclick = () => {
      const data = imported || draft;
      const point = data.points[Math.min(selected, data.points.length - 1)];
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
      setSpeedRange(
        (imported || draft).points.some((p) => p.r > 2) ? '4' : '2',
      );
      draw(imported || draft);
    };
    el('.speed-range').onchange = () => {
      setSpeedRange(el('.speed-range').value);
      draw(imported || draft);
    };
    el('.editor-pan').oninput = () => {
      viewStart = Number(el('.editor-pan').value);
      draw(imported || draft);
    };
    el('.editor-point-picker').onchange = () => {
      selected = Number(el('.editor-point-picker').value);
      const p = draft.points[selected];
      const span = draft.duration / zoom;
      if (p.t < viewStart || p.t > viewStart + span)
        viewStart = Math.max(
          0,
          Math.min(draft.duration - span, p.t - span / 2),
        );
      revealSpeed(p.r);
      refresh();
    };
    el('.editor-close').onclick = close;
    panel.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
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
        1,
      );
    el('.point-remove').onclick = () => {
      if (!selected) return;
      draft.points.splice(selected, 1);
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
      imported = null;
      selected = 0;
      dirty = true;
      el('.editor-import').disabled = true;
      el('.import-summary').textContent = '';
      refresh();
      status('Draft loaded.');
    };
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
        r: Math.max(speedBottom, Math.min(speedTop, rate)),
      };
    };
    graph.addEventListener('dblclick', (e) => {
      if (!e.target.closest('[data-index]') && !imported) {
        const p = coords(e);
        addPoint(p.t, p.r);
      }
    });
    graph.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('[data-index]');
      if (imported || e.button !== 0 || !target) return;
      selected = Number(target.dataset.index);
      dragging = target.dataset.kind;
      dragOffset =
        dragging === 'ramp'
          ? coords(e).t - (draft.points[selected].t - draft.points[selected].d)
          : 0;
      graph.setPointerCapture(e.pointerId);
      e.preventDefault();
      refresh();
    });
    graph.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = coords(e),
        point = draft.points[selected];
      const previous = draft.points[selected - 1];
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
                (draft.points[selected + 1]?.t ?? draft.duration + 0.01) - 0.01,
                p.t,
              ),
            ),
          );
        const step = e.shiftKey ? 0.005 : 0.025;
        point.r = round(Math.round(p.r / step) * step);
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
      if (['Enter', ' '].includes(e.key)) {
        e.preventDefault();
        refresh();
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
    draft.points.forEach((p, i) => {
      p.d = i ? round(Math.min(p.d, p.t - draft.points[i - 1].t)) : 0;
    });
  }

  function adjustFadeStart(event) {
    const point = draft.points[selected];
    const previous = draft.points[selected - 1];
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
  }
  function updatePoint() {
    const p = draft.points[selected];
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
            draft.points[selected - 1].t + 0.01,
            Math.min(
              (draft.points[selected + 1]?.t ?? draft.duration + 0.01) - 0.01,
              t,
            ),
          ),
        )
      : 0;
    p.r = round(Math.max(0.025, Math.min(4, r)));
    revealSpeed(p.r);
    p.d = Math.max(0, d);
    p.c = el('.point-curve').value;
    normalize();
    changed();
  }
  function addPoint(time, speed) {
    if (draft.points.length >= 200) {
      status('Maximum 200 points per timeline.');
      return;
    }
    const t = round(Math.max(0.01, Math.min(draft.duration, time)));
    if (draft.points.some((p) => Math.abs(p.t - t) < 0.01)) {
      status('A point already exists here. Move it or choose another time.');
      return;
    }
    const previous = [...draft.points].reverse().find((p) => p.t < t);
    const point = {
      t,
      r: round(Math.round(speed / 0.025) * 0.025),
      d: Math.min(4, t - previous.t),
      c: 'linear',
    };
    draft.points.push(point);
    draft.points.sort((a, b) => a.t - b.t);
    selected = draft.points.indexOf(point);
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
    const chosen = data.points[Math.min(selected, data.points.length - 1)];
    el('.zoom-focus').hidden = !chosen.d || chosen.c === 'instant';
    el('.point-readout').textContent =
      `${chosen.r}× · ${chosen.d ? chosen.d + 's fade' : 'Instant'}`;
    const picker = el('.editor-point-picker');
    picker.replaceChildren(
      ...data.points.map((point, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${index + 1} · ${preciseTime(point.t)} · ${point.r}×`;
        return option;
      }),
    );
    picker.value = String(Math.min(selected, data.points.length - 1));
    picker.disabled = Boolean(imported);
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
    const step = speedMode === 'fine' ? 0.1 : 0.05;
    const first = Math.ceil(speedBottom / step - 1e-9);
    const last = Math.floor(speedTop / step + 1e-9);
    const ticks = ['fine', 'close'].includes(speedMode)
      ? Array.from({ length: last - first + 1 }, (_, i) =>
          round((first + i) * step),
        )
      : speedTop <= 2
        ? Array.from({ length: speedTop * 4 }, (_, i) => (i + 1) / 4)
        : [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    if (speedBottom < ticks[0]) ticks.unshift(speedBottom);
    for (const r of ticks) {
      svg('line', {
        x1: 44,
        x2: graphWidth - 12,
        y1: y(r),
        y2: y(r),
        class: 'grid',
        ...(r === 1
          ? {
              style:
                'stroke:var(--tempo-fg);stroke-width:1;stroke-dasharray:3 4',
            }
          : {}),
      });
      svg('text', { x: 2, y: y(r) + 4 }, `${r}×`);
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
    let path = `M${x(0)},${y(data.points[0].r)}`;
    let previous = data.points[0];
    for (const point of data.points.slice(1)) {
      const start = point.c === 'instant' ? point.t : point.t - point.d;
      path += ` L${x(start)},${y(previous.r)}`;
      for (let i = 1; i <= 24; i++) {
        const t = start + ((point.t - start) * i) / 24;
        path += ` L${x(t)},${y(evaluate(data, t))}`;
      }
      previous = point;
    }
    path += ` L${x(data.duration)},${y(previous.r)}`;
    svg('path', {
      d: path,
      class: 'curve',
      'clip-path': 'url(#tempo-plot-clip)',
    });
    data.points.forEach((p, i) => {
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
        drawFadeStart(svg, p, data.points[i - 1], x(p.t - p.d));
      }
      if (
        p.t < viewStart ||
        p.t > viewStart + span ||
        p.r > speedTop ||
        p.r < speedBottom
      )
        return;
      if (!imported)
        svg('ellipse', {
          cx: x(p.t),
          cy: y(p.r),
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
        cy: y(p.r),
        r: 7,
        class: `point ${i === selected ? 'selected' : ''}`,
        'data-index': i,
        'data-kind': 'point',
        tabindex: imported ? -1 : 0,
        role: 'button',
        'aria-label': `Point ${i + 1}: ${p.t} seconds, ${p.r}×. Enter to edit.`,
      });
      const title = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'title',
      );
      title.textContent = `${preciseTime(p.t)} · ${p.r}×`;
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
    const p = draft.points[selected];
    el('.editor-track').textContent = draft.track;
    el('.editor-track').href = 'https://soundcloud.com' + draft.track;
    el('.point-time').value = p.t;
    el('.point-time').disabled = selected === 0;
    el('.point-rate').value = p.r;
    el('.point-duration').value = p.d;
    el('.point-duration').disabled = selected === 0 || p.c === 'instant';
    el('.point-curve').value = p.c;
    el('.point-curve').disabled = selected === 0;
    el('.point-remove').disabled = selected === 0;
    el('.editor-pitch').value = draft.pitch ?? api.defaultPitchMode;
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
      };
      selected = 0;
    }
    api.closeSettings();
    panel.hidden = false;
    panel.showPopover?.();
    fit();
    refresh();
    status(
      dirty
        ? 'Unsaved draft restored.'
        : 'Double-click the graph to add a point.',
    );
    el('.editor-close').focus();
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
    if (nextRate !== null && nextRate !== api.rate) api.refresh();
    updatePlayhead();
    wake();
  }

  function wake() {
    openPendingLink();
    const automate =
      profile?.enabled && !suspended && profile.data.points.length > 1;
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
      suspended = false;
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
  return {
    wake,
    pitchMode,
    shareLink,
    observe,
    value,
    playbackSchedule,
    changeTrack,
    open,
    validate,
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
