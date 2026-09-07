import { AudioPreview, sampleAudio } from './audio-preview';
import { initNumberFields } from './number-field';
import { syncRange } from './range';
import { demoTrack } from '../lib/demo-track';
import {
  clamp,
  defaultPoints,
  EditHistory,
  formatTime,
  rateAt,
  round,
  roundTime,
  timeTicks,
} from './demo-timeline';

const syncNumbers = initNumberFields();
const get = <T extends Element>(id: string) =>
  document.getElementById(id) as unknown as T;
const surface = document.querySelector<HTMLElement>('.timeline-demo')!;
const graph = get<SVGSVGElement>('demo-graph');
const grid = get<SVGGElement>('demo-grid');
const curve = get<SVGPathElement>('demo-curve');
const nodes = get<SVGGElement>('demo-nodes');
const rateInput = get<HTMLInputElement>('demo-point-rate');
const pitchInput = get<HTMLSelectElement>('demo-pitch');
const pan = get<HTMLInputElement>('demo-pan');
const status = get<HTMLElement>('demo-status');
const follow = get<HTMLInputElement>('preview-follow');
const seek = get<HTMLInputElement>('preview-seek');
const play = get<HTMLButtonElement>('preview-play');
const copy = get<HTMLButtonElement>('demo-copy');
const compare = get<HTMLButtonElement>('preview-compare');
const timeInput = get<HTMLInputElement>('demo-point-time');
const fadeInput = get<HTMLInputElement>('demo-point-fade');
const slider = get<HTMLInputElement>('demo-speed');
const exact = get<HTMLInputElement>('demo-speed-number');
const loader = get<HTMLDetailsElement>('preview-loader');
const urlInput = get<HTMLInputElement>('preview-url');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const points = defaultPoints(24);
const history = new EditHistory(points);
const preview = new AudioPreview(
  (message) => {
    status.textContent = message;
  },
  (message) => failTrack(message),
);
let duration = 24;
let trackPath: string | null = null;
let phase: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let buffering = false;
let original = false;
let frame = 0;
let lastAudioFrame = 0;
let lastLabelFrame = 0;
let loadRequest = 0;
let playRequest = 0;
let requestedUrl = demoTrack.url;
let sourceKind: 'remote' | 'local' = 'remote';
let currentFile: Blob | null = null;
let currentName = demoTrack.title;
let fixedRate = 1;
let selected = 2;
let zoom = 1;
let start = 0;
let width = 800;
const x = (time: number) =>
  40 + ((time - start) / (duration / zoom)) * (width - 52);
const y = (rate: number) => 212 - ((rate - 0.25) / 1.75) * 192;
const head = get<SVGGElement>('demo-playhead');
const headDot = get<SVGCircleElement>('demo-playhead-dot');

function svg(
  tag: string,
  attributes: Record<string, string | number>,
  text = '',
) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  if (text) element.textContent = text;
  return element;
}

function currentRate() {
  if (original) return 1;
  return follow.checked ? rateAt(points, preview.audio.currentTime) : fixedRate;
}

function syncMode() {
  surface.dataset.mode = follow.checked ? 'timeline' : 'fixed';
  surface.dataset.compare = original ? 'original' : 'adjusted';
  get('preview-fixed').setAttribute('aria-pressed', String(!follow.checked));
  get('preview-timeline').setAttribute('aria-pressed', String(follow.checked));
  get<HTMLElement>('preview-fixed-controls').hidden = follow.checked;
  compare.setAttribute('aria-pressed', String(original));
  compare.textContent = original ? 'Back to adjusted' : 'Listen to original';
  get('demo-copy-label').textContent = original
    ? 'Copy adjusted link'
    : 'Copy link';
  exact.value = String(fixedRate);
  slider.value = String(Math.min(fixedRate, 2));
  syncRange(slider);
  slider.setAttribute('aria-valuetext', `${fixedRate} times speed`);
  syncNumbers();
  applyAudio();
}

function setMode(timeline: boolean) {
  follow.checked = timeline;
  original = false;
  syncMode();
}

function syncHistory() {
  for (const direction of ['undo', 'redo'] as const)
    get<HTMLButtonElement>(`demo-${direction}`).disabled =
      !history.available(direction);
}

function commit() {
  history.commit(points);
  syncHistory();
}

function restore(direction: 'undo' | 'redo') {
  const next = history.move(direction);
  if (!next) return;
  points.splice(0, points.length, ...next);
  syncHistory();
  applyAudio();
  draw();
}

function draw() {
  width = Math.max(240, graph.clientWidth);
  graph.setAttribute('viewBox', `0 0 ${width} 260`);
  grid.replaceChildren();
  const end = start + duration / zoom;
  for (const rate of [0.25, 0.5, 0.75, 1, 1.5, 2]) {
    grid.append(
      svg('line', {
        x1: 40,
        x2: width - 12,
        y1: y(rate),
        y2: y(rate),
        class: rate === 1 ? 'graph-original' : 'graph-grid-line',
        'stroke-dasharray': rate === 1 ? '3 4' : 'none',
      }),
    );
    grid.append(svg('text', { x: 0, y: y(rate) + 5 }, `${rate}×`));
  }
  const { ticks, precision } = timeTicks(start, end, width < 500 ? 3 : 4);
  ticks.forEach((time, index) => {
    grid.append(
      svg('line', {
        x1: x(time),
        x2: x(time),
        y1: 20,
        y2: 212,
        class: 'graph-grid-line',
      }),
    );
    grid.append(
      svg(
        'text',
        {
          x: x(time),
          y: 244,
          'text-anchor':
            index === 0
              ? 'start'
              : index === ticks.length - 1
                ? 'end'
                : 'middle',
        },
        formatTime(time, precision),
      ),
    );
  });
  const samples = Array.from(
    { length: 181 },
    (_, index) => start + ((end - start) * index) / 180,
  );
  curve.setAttribute(
    'd',
    samples
      .map(
        (time, index) =>
          `${index ? 'L' : 'M'}${x(time).toFixed(2)},${y(rateAt(points, time)).toFixed(2)}`,
      )
      .join(' '),
  );
  points.forEach((point, index) => {
    const node = nodes.children[index];
    node.setAttribute('transform', `translate(${x(point.t)} ${y(point.r)})`);
    node.setAttribute(
      'visibility',
      point.t < start || point.t > end ? 'hidden' : 'visible',
    );
    node.setAttribute('aria-pressed', String(index === selected));
    node.setAttribute(
      'aria-label',
      `Point ${index + 1}, ${formatTime(point.t, precision)}, ${point.r} times speed`,
    );
  });
  rateInput.value = String(points[selected].r);
  timeInput.value = String(points[selected].t);
  timeInput.disabled = selected === 0;
  const gap = Math.min(0.1, duration / 100);
  timeInput.step = String(gap);
  fadeInput.step = String(gap);
  timeInput.min = String(
    roundTime(selected ? points[selected - 1].t + gap : 0),
  );
  timeInput.max = String(
    roundTime(points[selected + 1] ? points[selected + 1].t - gap : duration),
  );
  fadeInput.value = String(points[selected].d);
  fadeInput.disabled = selected === 0;
  fadeInput.max = String(
    roundTime(selected ? points[selected].t - points[selected - 1].t : 0),
  );
  syncNumbers();
  renderPlayback();
}

function setRate(value: number, save = true) {
  if (!Number.isFinite(value)) return draw();
  points[selected].r = round(clamp(value, 0.25, 2));
  if (save) commit();
  applyAudio();
  draw();
}

points.forEach((_, index) => {
  const node = svg('g', {
    class: 'node',
    tabindex: 0,
    role: 'button',
    'aria-describedby': 'demo-node-help',
  });
  node.append(svg('circle', { class: 'node-hit', r: 22, fill: 'transparent' }));
  node.append(svg('circle', { class: 'node-dot', r: 6 }));
  let dragging = false;
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    selected = index;
    dragging = true;
    node.setPointerCapture(event.pointerId);
    (node as SVGElement).focus();
    draw();
  });
  node.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const matrix = graph.getScreenCTM();
    if (!matrix) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    setRate(
      Math.round((0.25 + ((212 - position.y) / 192) * 1.75) / 0.025) * 0.025,
      false,
    );
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
    node.addEventListener(event, () => {
      if (dragging) commit();
      dragging = false;
    });
  node.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    selected = index;
    const step = event.shiftKey ? 0.01 : 0.025;
    if (event.key === 'ArrowUp') setRate(points[index].r + step);
    else if (event.key === 'ArrowDown') setRate(points[index].r - step);
    else {
      draw();
      rateInput.focus();
    }
  });
  node.addEventListener('focus', () => {
    selected = index;
    draw();
  });
  nodes.append(node);
});

rateInput.addEventListener('change', () => setRate(rateInput.valueAsNumber));

function setZoom(value: number) {
  zoom = clamp(value, 1, 32);
  const visible = duration / zoom;
  start = clamp(points[selected].t - visible / 2, 0, duration - visible);
  pan.max = String(duration - visible);
  pan.step = String(Math.max(0.000001, roundTime(visible / 100)));
  pan.value = String(start);
  syncRange(pan);
  pan.parentElement!.hidden = zoom === 1;
  get<HTMLButtonElement>('zoom-out').disabled = zoom === 1;
  get<HTMLButtonElement>('zoom-in').disabled = zoom === 32;
  get('demo-zoom').textContent = `Time zoom ${zoom}×`;
  draw();
}

get('zoom-out').addEventListener('click', () => setZoom(zoom / 2));
get('zoom-in').addEventListener('click', () => setZoom(zoom * 2));
pan.addEventListener('input', () => {
  start = Number(pan.value);
  draw();
});

copy.addEventListener('click', async () => {
  if (!trackPath || phase !== 'ready') return;
  const data = {
    v: 1,
    track: trackPath,
    duration,
    points: follow.checked
      ? points
      : [{ t: 0, r: fixedRate, d: 0, c: 'instant' }],
    pitch: pitchInput.value,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const code = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const link = `https://soundcloud.com${data.track}#sct=SCT1.${code}`;
  const fallback = get<HTMLTextAreaElement>('demo-copy-fallback');
  try {
    await navigator.clipboard.writeText(link);
    fallback.hidden = true;
    status.textContent = 'Tempo link copied.';
  } catch {
    fallback.hidden = false;
    fallback.value = link;
    fallback.focus();
    fallback.select();
    status.textContent = 'Copy the selected tempo link below.';
  }
});

function setSimpleSpeed(value: number) {
  fixedRate = Number.isFinite(value) ? round(clamp(value, 0.25, 4)) : fixedRate;
  setMode(false);
}

slider.addEventListener('input', () => setSimpleSpeed(slider.valueAsNumber));
exact.addEventListener('change', () => setSimpleSpeed(exact.valueAsNumber));
for (const input of [slider, exact])
  input.addEventListener('dblclick', () => setSimpleSpeed(1));
get('preview-fixed').addEventListener('click', () => setMode(false));
get('preview-timeline').addEventListener('click', () => setMode(true));
follow.addEventListener('change', () => setMode(follow.checked));
compare.addEventListener('click', () => {
  original = !original;
  syncMode();
});

function applyAudio() {
  preview.apply(currentRate(), !original && pitchInput.value === 'preserve');
  renderPlayback();
}

function renderPlayback(labels = true) {
  const time = preview.audio.currentTime;
  const rate = currentRate();
  if (labels) {
    get('preview-readout').textContent =
      `${formatTime(time)} · ${round(rate)}× ${original ? 'original' : 'now'}`;
    seek.value = String(time);
    syncRange(seek);
    seek.setAttribute(
      'aria-valuetext',
      `${formatTime(time)} of ${formatTime(duration)}`,
    );
  }
  head.setAttribute(
    'visibility',
    time < start || time > start + duration / zoom ? 'hidden' : 'visible',
  );
  head.setAttribute('transform', `translate(${x(time)} 0)`);
  headDot.setAttribute('cy', String(y(Math.min(2, rate))));
}

function animate(time: number) {
  frame = 0;
  if (preview.audio.paused || document.hidden) return;
  if (time - lastAudioFrame >= 50) {
    preview.apply(currentRate(), !original && pitchInput.value === 'preserve');
    lastAudioFrame = time;
  }
  const labels = time - lastLabelFrame >= 100;
  if (!reducedMotion.matches || labels) renderPlayback(labels);
  if (labels) lastLabelFrame = time;
  frame = requestAnimationFrame(animate);
}

function playbackState() {
  surface.dataset.playback =
    phase === 'ready'
      ? preview.audio.paused
        ? 'paused'
        : buffering
          ? 'buffering'
          : 'playing'
      : phase;
  play.textContent =
    phase === 'loading'
      ? 'Loading…'
      : phase === 'error'
        ? 'Retry'
        : preview.audio.paused
          ? 'Play'
          : 'Pause';
  play.disabled = phase === 'loading';
  play.setAttribute('aria-busy', String(phase === 'loading'));
  seek.disabled = phase !== 'ready';
  compare.disabled = phase !== 'ready';
  copy.disabled = phase !== 'ready' || !trackPath;
  cancelAnimationFrame(frame);
  frame = 0;
  if (!preview.audio.paused && !document.hidden)
    frame = requestAnimationFrame(animate);
  renderPlayback();
}

function setPhase(value: typeof phase) {
  phase = value;
  const form = get<HTMLFormElement>('preview-link-form');
  const button = form.querySelector('button')!;
  button.disabled = value === 'loading';
  button.textContent = value === 'loading' ? 'Loading…' : 'Load';
  form.setAttribute('aria-busy', String(value === 'loading'));
  playbackState();
}

function failTrack(message: string) {
  if (phase === 'idle') return;
  setPhase('error');
  status.textContent = message;
  get<HTMLButtonElement>('preview-sample').hidden = false;
  loader.open = true;
}

function beginTrack() {
  preview.audio.pause();
  trackPath = null;
  buffering = false;
  original = false;
  status.textContent = 'Loading audio…';
  get<HTMLAnchorElement>('preview-credit').hidden = true;
  get<HTMLButtonElement>('preview-sample').hidden = true;
  get<HTMLTextAreaElement>('demo-copy-fallback').hidden = true;
  setPhase('loading');
  syncMode();
}

function finalizeTrack(next: number) {
  const scale = next / duration;
  points.forEach((point) => {
    point.t = roundTime(point.t * scale);
    point.d = roundTime(point.d * scale);
  });
  duration = next;
  history.reset(points);
  syncHistory();
  seek.max = String(duration);
  setZoom(1);
  setPhase('ready');
  applyAudio();
}

async function localTrack(file: Blob, name: string) {
  const request = ++loadRequest;
  playRequest++;
  sourceKind = 'local';
  currentFile = file;
  currentName = name;
  beginTrack();
  get('preview-title').textContent = name;
  try {
    const next = await preview.loadFile(file);
    if (request !== loadRequest) return false;
    finalizeTrack(next);
    status.textContent =
      'Audio file ready. Sharing is available for SoundCloud tracks.';
    return true;
  } catch (error) {
    if (request === loadRequest) failTrack((error as Error).message);
    return false;
  }
}

async function remoteTrack(url: string) {
  const request = ++loadRequest;
  requestedUrl = url;
  urlInput.value = url;
  sourceKind = 'remote';
  currentFile = null;
  beginTrack();
  get('preview-title').textContent = 'Loading track…';
  try {
    const track = await preview.loadLink(url);
    if (!track || request !== loadRequest) return false;
    trackPath = track.preview ? null : new URL(track.permalink).pathname;
    get('preview-title').textContent = `${track.title} · ${track.artist}`;
    const credit = get<HTMLAnchorElement>('preview-credit');
    credit.href = track.permalink;
    credit.hidden = false;
    finalizeTrack(preview.audio.duration);
    status.textContent = track.preview
      ? 'Preview excerpt. Full track needed for sharing.'
      : '';
    return true;
  } catch (error) {
    if (request !== loadRequest) return false;
    get('preview-title').textContent = 'Track unavailable';
    failTrack(
      (error as Error).message ||
        'Track could not be loaded. Retry or choose another track.',
    );
    return false;
  }
}

play.addEventListener('click', async () => {
  if (!preview.audio.paused) return preview.audio.pause();
  let request = ++playRequest;
  try {
    await preview.unlock();
    if (request !== playRequest) return;
    if (phase !== 'ready') {
      const loading =
        sourceKind === 'local' && currentFile
          ? localTrack(currentFile, currentName)
          : remoteTrack(requestedUrl);
      request = playRequest;
      if (!(await loading)) return;
    }
    if (request !== playRequest) return;
    await preview.play();
  } catch {
    if (request === playRequest)
      failTrack('Playback could not start. Retry or choose another track.');
  }
});

get('preview-sample').addEventListener('click', () => {
  void localTrack(sampleAudio(), 'Synth sample');
});
for (const event of ['play', 'pause', 'ended', 'seeked'])
  preview.audio.addEventListener(event, playbackState);
preview.audio.addEventListener('waiting', () => {
  buffering = true;
  if (phase === 'ready') status.textContent = 'Buffering…';
  playbackState();
});
preview.audio.addEventListener('playing', () => {
  buffering = false;
  if (status.textContent === 'Buffering…') status.textContent = '';
  playbackState();
});
preview.audio.addEventListener('timeupdate', () => {
  if (document.hidden)
    preview.apply(currentRate(), !original && pitchInput.value === 'preserve');
});
document.addEventListener('visibilitychange', playbackState);
seek.addEventListener('input', () => {
  if (phase === 'ready') preview.audio.currentTime = Number(seek.value);
  applyAudio();
});
get<HTMLInputElement>('preview-volume').addEventListener('input', (event) => {
  preview.audio.volume = Number((event.target as HTMLInputElement).value);
});
pitchInput.addEventListener('change', applyAudio);

function timing() {
  if (!selected) return;
  const point = points[selected];
  const gap = Math.min(0.1, duration / 100);
  if (Number.isFinite(timeInput.valueAsNumber))
    point.t = roundTime(
      clamp(
        timeInput.valueAsNumber,
        points[selected - 1].t + gap,
        points[selected + 1] ? points[selected + 1].t - gap : duration,
      ),
    );
  if (Number.isFinite(fadeInput.valueAsNumber))
    point.d = roundTime(
      clamp(fadeInput.valueAsNumber, 0, point.t - points[selected - 1].t),
    );
  points.forEach((p, i) => {
    if (i) p.d = roundTime(Math.min(p.d, p.t - points[i - 1].t));
  });
  commit();
  applyAudio();
  draw();
}

timeInput.addEventListener('change', timing);
fadeInput.addEventListener('change', timing);
get('demo-undo').addEventListener('click', () => restore('undo'));
get('demo-redo').addEventListener('click', () => restore('redo'));
surface.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  if ((event.target as Element).closest('input,textarea,[contenteditable]'))
    return;
  const key = event.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  event.preventDefault();
  restore(key === 'y' || event.shiftKey ? 'redo' : 'undo');
});
get('preview-reset').addEventListener('click', () => {
  playRequest++;
  preview.audio.pause();
  if (phase === 'ready') preview.audio.currentTime = 0;
  points.splice(0, points.length, ...defaultPoints(duration));
  commit();
  selected = 2;
  fixedRate = 1;
  setMode(true);
  pitchInput.value = 'natural';
  pitchInput.dispatchEvent(new Event('change', { bubbles: true }));
  setZoom(1);
  if (phase !== 'error' && phase !== 'loading') status.textContent = '';
});
get<HTMLInputElement>('preview-file').addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void localTrack(file, file.name);
  input.value = '';
});
get<HTMLFormElement>('preview-link-form').addEventListener(
  'submit',
  (event) => {
    event.preventDefault();
    playRequest++;
    void remoteTrack(urlInput.value);
  },
);

urlInput.value = requestedUrl;
for (const input of surface.querySelectorAll<HTMLInputElement>(
  "input[type='range']",
)) {
  syncRange(input);
  input.addEventListener('input', () => syncRange(input));
}
new ResizeObserver(draw).observe(graph);
syncMode();
syncHistory();
playbackState();
draw();
