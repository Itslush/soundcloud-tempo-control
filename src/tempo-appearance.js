import { createStarMotion } from './star-motion.js';

export function createTempoAppearance({ onChange, onError } = {}) {
  if (
    (onChange !== undefined && typeof onChange !== 'function') ||
    (onError !== undefined && typeof onError !== 'function')
  )
    throw new TypeError('Invalid appearance change handler');
  const key = 'soundcloud.tempo.appearance';
  const motionKey = 'soundcloud.tempo.starMotion';
  const speedKey = 'soundcloud.tempo.starSpeed';
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const forcedColors = window.matchMedia?.('(forced-colors: active)');
  let speed = 1.5;
  const motionModes = new Set(['system', 'on', 'off']);
  let motion = 'system';
  const attribute = 'data-tempo-appearance';
  const modes = new Set(['native', 'charcoal', 'oled']);
  const primary = { document };
  const documents = new Map([[document, primary]]);
  let storage;
  let selected = 'native';
  let css;
  let disposed = false;
  try {
    storage = window.localStorage;
    const saved = storage.getItem(key);
    if (modes.has(saved)) selected = saved;
    const savedMotion = storage.getItem(motionKey);
    if (motionModes.has(savedMotion)) motion = savedMotion;
    const savedSpeed = Number(storage.getItem(speedKey));
    if (savedSpeed >= 0.5 && savedSpeed <= 4) speed = savedSpeed;
  } catch {}

  function stylesheet() {
    const marks = [
      [38, 72, 'diamond', 0.7, 0],
      [184, 126, 'ray', 1.15, 12],
      [346, 44, 'pair', 0.8, 30],
      [594, 118, 'diamond', 0.65, 0],
      [826, 64, 'ray', 0.8, 0],
      [912, 228, 'diamond', 0.8, 0],
      [68, 318, 'ray', 0.7, 18],
      [262, 246, 'diamond', 0.8, 0],
      [458, 198, 'pair', 0.6, -24],
      [718, 286, 'ray', 1.3, 0],
      [846, 398, 'diamond', 0.65, 0],
      [144, 480, 'pair', 0.7, 15],
      [364, 386, 'ray', 0.75, 40],
      [540, 454, 'diamond', 0.7, 0],
      [64, 640, 'ray', 1.1, 0],
      [282, 598, 'diamond', 0.65, 0],
      [462, 714, 'ray', 0.65, 24],
      [668, 580, 'pair', 0.8, -18],
      [872, 678, 'ray', 1.2, 10],
      [170, 776, 'diamond', 0.8, 0],
      [610, 794, 'diamond', 0.6, 0],
      [776, 758, 'ray', 0.6, 45],
    ];
    const stars = `
      <svg xmlns="http://www.w3.org/2000/svg" width="960" height="840" viewBox="0 0 960 840">
        <defs>
          <path id="ray" d="M0-4 .7-1 3.5 0 .7.8 0 4.5-.7.8-3.5 0-.7-1Z"/>
          <path id="diamond" d="M0-1.8 1.1 0 0 1.8-1.1 0Z"/>
          <g id="pair"><circle r=".85"/><path d="M4-3.5 4.65-2.5 4-1.5 3.35-2.5Z"/></g>
        </defs>
        ${marks
          .map(
            ([x, y, shape, scale, rotation], index) => `
          <use href="#${shape}" transform="translate(${x} ${y}) rotate(${rotation}) scale(${scale})"
            fill="${index % 3 ? '#c1ccdf' : '#ece2d1'}" opacity="${index % 3 ? 0.32 : 0.27}"/>
        `,
          )
          .join('')}
      </svg>
    `
      .replace(/\s+/g, ' ')
      .trim();
    const buttonTokens = [
      [
        'primary',
        'var(--tempo-page-ink)',
        '#111',
        'var(--tempo-page-raised)',
        'var(--tempo-page-ink)',
      ],
      [
        'secondary',
        'var(--tempo-page-raised)',
        'var(--tempo-page-ink)',
        'var(--tempo-page-surface)',
        'var(--tempo-page-accent)',
      ],
      [
        'tertiary',
        'transparent',
        'var(--tempo-page-ink)',
        'transparent',
        'var(--tempo-page-accent)',
      ],
    ]
      .flatMap(
        ([
          name,
          background,
          foreground,
          selectedBackground,
          selectedForeground,
        ]) =>
          [
            ['background-color', background],
            ['font-color', foreground],
            ['hover-font-color', foreground],
            ['disabled-background-color', background],
            ['disabled-font-color', foreground],
            ['selected-background-color', selectedBackground],
            ['selected-font-color', selectedForeground],
            ['selected-hover-font-color', selectedForeground],
            ['selected-active-background-color', selectedBackground],
            ['selected-active-font-color', selectedForeground],
            ['loading-background-color', background],
            ['loading-font-color', foreground],
            ['loading-icon-color', foreground],
            ['active-background-color', background],
            ['active-font-color', foreground],
          ].map(([state, value]) => `--button-${name}-${state}: ${value};`),
      )
      .join('\n');
    const linkTokens = [
      ['standard', 'var(--tempo-page-accent)', 'var(--tempo-page-accent)'],
      ['primary', 'var(--tempo-page-ink)', 'var(--tempo-page-accent)'],
      ['secondary', 'var(--tempo-page-muted)', 'var(--tempo-page-ink)'],
    ]
      .flatMap(([name, foreground, hover]) =>
        [
          ['color', foreground],
          ['hover-color', hover],
          ['active-color', hover],
          ['disabled-color', 'var(--tempo-page-muted)'],
          ['focus-box-shadow', '0 0 0 2px var(--tempo-page-accent)'],
        ].map(([state, value]) => `--link-${name}-${state}: ${value};`),
      )
      .join('\n');
    const scope = `html:is([${attribute}="charcoal"],[${attribute}="oled"])`;
    return `
      @media (forced-colors: none) {
        ${scope}[${attribute}="charcoal"] {
          --tempo-page-ground: #111;
          --tempo-page-ground-rgb: 17,17,17;
          --tempo-page-surface: #202020;
          --tempo-page-raised: #303030;
          --tempo-page-raised-rgb: 48,48,48;
        }
        ${scope}[${attribute}="oled"] {
          --tempo-page-ground: #000;
          --tempo-page-ground-rgb: 0,0,0;
          --tempo-page-surface: #0b0b0b;
          --tempo-page-raised: #171717;
          --tempo-page-raised-rgb: 23,23,23;
        }
        ${scope}, ${scope} body {
          --tempo-page-ink: #f4f4f4;
          --tempo-page-muted: #b2b2b2;
          --tempo-page-line: #767676;
          --tempo-page-accent: #ff5500;
          --surface-color: var(--tempo-page-ground);
          --surface-rgb: var(--tempo-page-ground-rgb);
          --primary-color: var(--tempo-page-ink);
          --primary-rgb: 244,244,244;
          --secondary-color: var(--tempo-page-muted);
          --secondary-rgb: 178,178,178;
          --highlight-color: var(--tempo-page-raised);
          --highlight-rgb: var(--tempo-page-raised-rgb);
          --special-color: var(--tempo-page-accent);
          --special-rgb: 255,85,0;
          --background-surface-color: var(--tempo-page-ground);
          --background-highlight-color: var(--tempo-page-raised);
          --font-primary-color: var(--tempo-page-ink);
          --font-secondary-color: var(--tempo-page-muted);
          --font-special-color: var(--tempo-page-accent);
          --font-link-color: var(--tempo-page-accent);
          --link-color: var(--tempo-page-accent);
          --link-rgb: 255,85,0;
          ${buttonTokens}
          ${linkTokens}
          --button-focused-box-shadow: 0 0 0 2px var(--tempo-page-accent) inset;
          --input-default-background-color: var(--tempo-page-raised);
          --input-default-border-color: var(--tempo-page-line);
          --input-default-font-color: var(--tempo-page-ink);
          --input-placeholder-background-color: var(--tempo-page-raised);
          --input-placeholder-border-color: var(--tempo-page-line);
          --input-placeholder-font-color: var(--tempo-page-muted);
          --input-focused-background-color: var(--tempo-page-raised);
          --input-focused-border-color: var(--tempo-page-accent);
          --input-focused-font-color: var(--tempo-page-ink);
          --input-invalid-background-color: var(--tempo-page-raised);
          --input-invalid-font-color: var(--tempo-page-ink);
          --input-disabled-background-color: var(--tempo-page-raised);
          --input-disabled-font-color: var(--tempo-page-muted);
          color-scheme: dark;
          background-color: var(--tempo-page-ground) !important;
          color: var(--tempo-page-ink);
          scrollbar-color: var(--tempo-page-line) var(--tempo-page-ground);
        }
        ${scope} body {
          background-image: url("data:image/svg+xml,${encodeURIComponent(stars)}");
          background-size: 960px 840px;
          background-repeat: repeat;
        }
        ${scope} .l-container {
          background-color: transparent;
        }
        ${scope} .header,
        ${scope} .header__inner,
        ${scope} .playControls,
        ${scope} .playControls__inner,
        ${scope} .playControls__bg {
          background-color: var(--tempo-page-surface) !important;
          border-color: var(--tempo-page-line);
          color: var(--tempo-page-ink);
        }
        ${scope} .playControls {
          --button-secondary-background-color: var(--tempo-page-surface);
          --button-secondary-disabled-background-color: var(--tempo-page-surface);
          --button-secondary-active-background-color: var(--tempo-page-surface);
          --button-secondary-loading-background-color: var(--tempo-page-surface);
        }
        ${scope} .playbackSoundBadge__titleLink,
        ${scope} .playbackTimeline__timePassed,
        ${scope} .playbackTimeline__duration,
        ${scope} .volume__button {
          color: var(--tempo-page-ink);
        }
        ${scope} .playbackSoundBadge__lightLink {
          color: var(--tempo-page-muted);
        }
        ${scope} .playbackTimeline__progressBar {
          background-color: var(--tempo-page-accent) !important;
        }
        ${scope} .playbackTimeline__progressBackground {
          background-color: var(--tempo-page-line);
        }
        ${scope} body::selection {
          color: #111;
          background-color: var(--tempo-page-accent);
        }
      }
    `;
  }

  function restore(entry) {
    const { root, applied, previousAttribute } = entry;
    try {
      if (root && root.getAttribute(attribute) === applied) {
        if (previousAttribute === null) root.removeAttribute(attribute);
        else root.setAttribute(attribute, previousAttribute);
      }
    } finally {
      entry.drift?.(0);
      entry.drift = undefined;
      entry.style?.remove();
      entry.style = undefined;
      entry.root = undefined;
      entry.applied = undefined;
      if (entry.motion)
        entry.document.removeEventListener('visibilitychange', entry.motion);
      entry.motion = undefined;
    }
  }

  function sameOrigin(doc) {
    try {
      const view = doc?.defaultView;
      return Boolean(
        view &&
          view.document === doc &&
          view.location.origin === window.location.origin &&
          view.location.protocol === 'https:' &&
          doc.documentElement,
      );
    } catch {
      return false;
    }
  }

  function releaseDocument(entry) {
    if (documents.get(entry.document) !== entry) return;
    documents.delete(entry.document);
    restore(entry);
  }

  function renderDocument(entry, next) {
    if (next === 'native') {
      restore(entry);
      return;
    }
    const doc = entry.document;
    const target = doc.documentElement;
    if (!target) return;
    if (entry.root && entry.root !== target) restore(entry);
    if (!entry.style) {
      const element = doc.createElement('style');
      element.textContent = css ||= stylesheet();
      const previous = target.getAttribute(attribute);
      let position;
      try {
        (doc.head || target).append(element);
        const index = element.sheet.insertRule(
          `html[${attribute}] body { background-position: 0 0; }`,
          element.sheet.cssRules.length,
        );
        position = element.sheet.cssRules[index].style;
        target.setAttribute(attribute, next);
      } catch (error) {
        element.remove();
        throw error;
      }
      entry.style = element;
      entry.root = target;
      entry.previousAttribute = previous;
      entry.drift = createStarMotion((x, y) => {
        position.backgroundPosition = `${x}px ${y}px`;
      }, doc.defaultView);
      entry.motion = () => {
        entry.drift(
          !doc.hidden && moving() && !forcedColors?.matches ? speed : 0,
        );
      };
      doc.addEventListener('visibilitychange', entry.motion);
      entry.motion();
    } else entry.root.setAttribute(attribute, next);
    entry.applied = next;
  }

  function render(next) {
    const updated = [];
    try {
      for (const entry of [...documents.values()]) {
        if (entry !== primary && !sameOrigin(entry.document)) {
          releaseDocument(entry);
          continue;
        }
        renderDocument(entry, next);
        updated.push(entry);
      }
    } catch (error) {
      const failures = [error];
      for (const entry of updated.reverse()) {
        try {
          renderDocument(entry, selected);
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length > 1)
        throw new AggregateError(failures, 'Could not restore the appearance');
      throw error;
    }
  }

  function attachDocument(doc) {
    if (
      disposed ||
      documents.has(doc) ||
      documents.size >= 17 ||
      !sameOrigin(doc)
    )
      throw new TypeError('Invalid appearance document');
    let entry = { document: doc };
    renderDocument(entry, selected);
    documents.set(doc, entry);
    return () => {
      if (!entry) return;
      const owned = entry;
      entry = null;
      releaseDocument(owned);
    };
  }

  function change(next, persist) {
    if (disposed || selected === next) return false;
    render(next);
    selected = next;
    let failed = false;
    let failure;
    if (persist) {
      try {
        if (!storage) throw new Error('Appearance storage is unavailable');
        storage.setItem(key, next);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
    onChange?.(next);
    if (failed) onError?.(failure);
    return true;
  }

  function sync(event) {
    if (!storage || event.storageArea !== storage) return;
    if (event.key === speedKey || event.key === null) {
      const value = event.key === null ? 1.5 : Number(event.newValue);
      speed = value >= 0.5 && value <= 4 ? value : 1.5;
      refreshMotion();
    }
    if (event.key === motionKey || event.key === null) {
      const next =
        motionModes.has(event.newValue) && event.key !== null
          ? event.newValue
          : 'system';
      if (motion !== next) {
        motion = next;
        for (const entry of documents.values()) entry.motion?.();
        onChange?.(selected);
      }
    }
    if (event.key !== key && event.key !== null) return;
    const next = event.key === null ? 'native' : event.newValue;
    change(modes.has(next) ? next : 'native', false);
  }

  function ready() {
    if (!disposed) render(selected);
  }

  function moving() {
    return motion === 'on' || (motion === 'system' && !reducedMotion?.matches);
  }

  function refreshMotion() {
    for (const entry of documents.values()) entry.motion?.();
    onChange?.(selected);
  }

  if (document.documentElement) render(selected);
  else document.addEventListener('DOMContentLoaded', ready, { once: true });
  window.addEventListener('storage', sync);
  reducedMotion?.addEventListener('change', refreshMotion);
  forcedColors?.addEventListener('change', refreshMotion);
  return Object.freeze({
    mode: () => selected,
    motion: () => (moving() ? 'on' : 'off'),
    speed: () => speed,
    setSpeed(next) {
      if (!Number.isFinite(next) || next < 0.5 || next > 4)
        throw new TypeError('Star speed must be between 0.5 and 4');
      speed = next;
      refreshMotion();
      try {
        if (!storage) throw new Error('Appearance storage is unavailable');
        storage.setItem(speedKey, String(next));
      } catch (error) {
        onError?.(error);
      }
    },
    setMotion(next) {
      if (!motionModes.has(next)) throw new TypeError('Invalid star motion');
      if (motion === next) return false;
      motion = next;
      for (const entry of documents.values()) entry.motion?.();
      onChange?.(selected);
      try {
        if (!storage) throw new Error('Appearance storage is unavailable');
        storage.setItem(motionKey, next);
      } catch (error) {
        onError?.(error);
      }
      return true;
    },
    attachDocument,
    setMode(next) {
      if (!modes.has(next)) throw new TypeError('Invalid appearance mode');
      return change(next, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('storage', sync);
      reducedMotion?.removeEventListener('change', refreshMotion);
      forcedColors?.removeEventListener('change', refreshMotion);
      document.removeEventListener('DOMContentLoaded', ready);
      selected = 'native';
      const failures = [];
      for (const entry of [...documents.values()]) {
        try {
          releaseDocument(entry);
        } catch (error) {
          failures.push(error);
        }
      }
      css = undefined;
      if (failures.length)
        throw new AggregateError(failures, 'Could not restore the appearance');
    },
  });
}
