import { tempoShareLink } from '../../../src/tempo-share.js';
import { release } from '../lib/release';
import { createTempoEditor } from '../../../src/tempo-editor.js';
import { AudioPreview, sampleAudio } from './audio-preview';
import { initNumberFields } from './number-field';
import { syncRange } from './range';
import { demoTrack } from '../lib/demo-track';
import { clamp, defaultPoints, formatTime, round } from './demo-timeline';

const syncNumbers = initNumberFields();
const get = <T extends Element>(id: string) =>
  document.getElementById(id) as unknown as T;
const surface = document.querySelector<HTMLElement>('.timeline-demo')!;
const pitchInput = get<HTMLSelectElement>('demo-pitch');
const keyInput = get<HTMLInputElement>('demo-key-shift');
const keyShift = () => editor.keyShift() ?? (Number(keyInput.value) || 0);
const status = get<HTMLElement>('demo-status');
const follow = get<HTMLInputElement>('preview-follow');
const seek = get<HTMLInputElement>('preview-seek');
const play = get<HTMLButtonElement>('preview-play');
const copy = get<HTMLButtonElement>('demo-copy');
const compare = get<HTMLButtonElement>('preview-compare');
const slider = get<HTMLInputElement>('demo-speed');
const exact = get<HTMLInputElement>('demo-speed-number');
const loader = get<HTMLDetailsElement>('preview-loader');
const urlInput = get<HTMLInputElement>('preview-url');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
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
const editor = createTempoEditor({
  inline: true,
  website: release.siteUrl,
  root: get<HTMLElement>('demo-shared-editor'),
  get rate() {
    return preview.audio.playbackRate;
  },
  get keyShift() {
    return Number(keyInput.value) || 0;
  },
  get pitchMode() {
    return pitchInput.value;
  },
  get defaultPitchMode() {
    return pitchInput.value;
  },
  get canShare() {
    return Boolean(trackPath && phase === 'ready');
  },
  applySaved: false,
  ready: false,
  copyLinks: false,
  parseTrack: (path: string) =>
    /^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(path) ? path : '',
  refresh: () => applyAudio(),
  normal: () => {
    fixedRate = 1;
  },
  message: (text: string) => {
    status.textContent = text;
  },
});

function currentRate() {
  if (original) return 1;
  return follow.checked ? (editor.value() ?? fixedRate) : fixedRate;
}

function syncMode() {
  surface.dataset.mode = follow.checked ? 'timeline' : 'fixed';
  surface.dataset.compare = original ? 'original' : 'adjusted';
  get('preview-fixed').setAttribute('aria-pressed', String(!follow.checked));
  get('preview-timeline').setAttribute('aria-pressed', String(follow.checked));
  get<HTMLElement>('preview-fixed-controls').hidden = follow.checked;
  pitchInput.closest<HTMLElement>('.select-control')!.hidden = follow.checked;
  keyInput.closest<HTMLElement>('.number-field')!.hidden = follow.checked;
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

copy.addEventListener('click', async () => {
  if (!trackPath || phase !== 'ready') return;
  const draft = editor.draftProfile()!;
  const data = {
    v: 1,
    track: trackPath,
    duration,
    ...(follow.checked ? draft : {}),
    points: follow.checked
      ? draft.points
      : [{ t: 0, r: fixedRate, d: 0, c: 'instant' }],
    pitch: follow.checked
      ? (draft.pitch ?? pitchInput.value)
      : pitchInput.value,
    keyShift: follow.checked
      ? (draft.keyShift ?? 0)
      : Number(keyInput.value) || 0,
  };
  const fallback = get<HTMLTextAreaElement>('demo-copy-fallback');
  let link = '';
  try {
    link = tempoShareLink(data, release.siteUrl);
    await navigator.clipboard.writeText(link);
    fallback.hidden = true;
    status.textContent = 'Tempo link copied.';
  } catch (error) {
    if (!link) {
      status.textContent = (error as Error).message;
      return;
    }
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
  preview.apply(
    currentRate(),
    !original &&
      (follow.checked
        ? (editor.pitchMode() ?? pitchInput.value)
        : pitchInput.value) === 'preserve',
    original ? 0 : follow.checked ? keyShift() : Number(keyInput.value) || 0,
  );
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
}

function animate(time: number) {
  frame = 0;
  if (preview.audio.paused || document.hidden) return;
  if (time - lastAudioFrame >= 50) {
    preview.apply(
      currentRate(),
      !original &&
        (follow.checked
          ? (editor.pitchMode() ?? pitchInput.value)
          : pitchInput.value) === 'preserve',
      original ? 0 : follow.checked ? keyShift() : Number(keyInput.value) || 0,
    );
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
  const data = editor.draftProfile();
  const scale = next / duration;
  duration = next;
  editor.suspend();
  const track = trackPath || '/demo/local-audio';
  editor.changeTrack(track);
  editor.observe(preview.audio);
  editor.loadDraft({
    ...data,
    track,
    duration,
    points: data!.points.map((point) => ({
      ...point,
      t: round(point.t * scale),
      d: round(point.d * scale),
    })),
    ...(data!.pitchPoints
      ? {
          pitchPoints: data!.pitchPoints.map((point) => ({
            ...point,
            t: round(point.t * scale),
            d: round(point.d * scale),
          })),
        }
      : {}),
  });
  seek.max = String(duration);
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
    preview.apply(
      currentRate(),
      !original &&
        (follow.checked
          ? (editor.pitchMode() ?? pitchInput.value)
          : pitchInput.value) === 'preserve',
      original ? 0 : follow.checked ? keyShift() : Number(keyInput.value) || 0,
    );
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
keyInput.addEventListener('change', () => {
  keyInput.value = String(clamp(Number(keyInput.value) || 0, -12, 12));
  editor.setKeyShift(Number(keyInput.value));
  syncNumbers();
  applyAudio();
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
editor.changeTrack(new URL(demoTrack.url).pathname);
editor.observe(preview.audio);
editor.loadDraft({
  v: 1,
  track: new URL(demoTrack.url).pathname,
  duration,
  points: defaultPoints(duration),
  keyShift: 0,
  pitch: 'natural',
});
syncMode();
playbackState();
