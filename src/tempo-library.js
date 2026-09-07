export function createTempoStore(api) {
  const speedPrefix = 'soundcloud.tempo.track.';
  const timelinePrefix = 'soundcloud.tempo.timeline.';
  const limit = 2 * 1024 * 1024;
  const preferences = {
    randomSaved: false,
    copyLinks: false,
    preserveKey: false,
    useWasm: true,
    outputDb: -6,
  };
  const storage = () => api.storage();
  const round = (value) => Math.round(value * 1000) / 1000;
  const keyFor = (prefix, track) => prefix + encodeURIComponent(track);

  function validTrack(track) {
    return (
      typeof track === 'string' &&
      track.length <= 800 &&
      !/[\u0000-\u0020\u007f<>"\\]/.test(track) &&
      api.parseTrack(track) === track
    );
  }

  function validateSpeed(value) {
    const entry =
      typeof value === 'number' ? { rate: value, enabled: true } : value;
    if (
      !entry ||
      !Number.isFinite(entry.rate) ||
      entry.rate < 0.025 ||
      entry.rate > 4 ||
      typeof entry.enabled !== 'boolean'
    )
      throw new Error('Saved speeds must be between 0.025 and 4×.');
    return { rate: round(entry.rate), enabled: entry.enabled };
  }

  function validateTimeline(value, track) {
    if (!value || typeof value.enabled !== 'boolean')
      throw new Error('Each timeline needs an on or off state.');
    const data = api.validateTimeline(value.data);
    if (data.track !== track)
      throw new Error('A timeline belongs to a different track.');
    return { data, enabled: value.enabled };
  }

  function read(prefix, track, validate) {
    const raw = storage().getItem(keyFor(prefix, track));
    if (raw === null) return null;
    try {
      return validate(JSON.parse(raw), track);
    } catch {
      return null;
    }
  }

  function speed(track) {
    return read(speedPrefix, track, validateSpeed);
  }

  function timeline(track) {
    return read(timelinePrefix, track, validateTimeline);
  }

  function tracks() {
    const paths = new Set();
    const source = storage();
    for (let index = 0; index < source.length; index++) {
      const key = source.key(index);
      const prefix = [speedPrefix, timelinePrefix].find((item) =>
        key?.startsWith(item),
      );
      if (!prefix) continue;
      try {
        const track = decodeURIComponent(key.slice(prefix.length));
        if (validTrack(track) && keyFor(prefix, track) === key)
          paths.add(track);
      } catch {}
    }
    return [...paths]
      .sort((a, b) => a.localeCompare(b))
      .flatMap((track) => {
        const savedSpeed = speed(track);
        const savedTimeline = timeline(track);
        return savedSpeed || savedTimeline
          ? [
              {
                track,
                ...(savedSpeed && { speed: savedSpeed }),
                ...(savedTimeline && { timeline: savedTimeline }),
              },
            ]
          : [];
      });
  }

  function set(track, type, value) {
    if (!validTrack(track) || !['speed', 'timeline'].includes(type))
      throw new Error('Choose a valid saved track.');
    const key = keyFor(type === 'speed' ? speedPrefix : timelinePrefix, track);
    if (value === null) {
      storage().removeItem(key);
      return;
    }
    const entry =
      type === 'speed' ? validateSpeed(value) : validateTimeline(value, track);
    storage().setItem(
      key,
      JSON.stringify(type === 'speed' && entry.enabled ? entry.rate : entry),
    );
  }

  function readPreferences() {
    const result = { ...preferences };
    for (const [name, fallback] of Object.entries(preferences)) {
      const raw = storage().getItem('soundcloud.tempo.' + name);
      if (raw === null) continue;
      try {
        const value = JSON.parse(raw);
        result[name] = validPreference(name, value) ? value : fallback;
      } catch {}
    }
    return result;
  }

  function validPreference(name, value) {
    return name === 'outputDb'
      ? Number.isInteger(value) && value >= -24 && value <= 0
      : Object.hasOwn(preferences, name) && typeof value === 'boolean';
  }

  function validateBackup(text) {
    if (
      typeof text !== 'string' ||
      new TextEncoder().encode(text).length > limit
    )
      throw new Error('Choose a backup smaller than 2 MB.');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('This file is not a valid JSON backup.');
    }
    if (
      value?.format !== 'soundcloud-tempo-control' ||
      value.version !== 1 ||
      !Array.isArray(value.tracks) ||
      value.tracks.length > 1000 ||
      !value.preferences ||
      typeof value.preferences !== 'object' ||
      Array.isArray(value.preferences)
    )
      throw new Error(
        'Choose a Tempo Control backup (version 1, up to 1,000 tracks).',
      );
    const seen = new Set();
    let pointCount = 0;
    const entries = value.tracks.map((entry) => {
      if (
        !entry ||
        !validTrack(entry.track) ||
        seen.has(entry.track) ||
        (!entry.speed && !entry.timeline)
      )
        throw new Error('The backup contains an invalid or duplicate track.');
      seen.add(entry.track);
      const item = { track: entry.track };
      if (entry.speed !== undefined) item.speed = validateSpeed(entry.speed);
      if (entry.timeline !== undefined) {
        item.timeline = validateTimeline(entry.timeline, entry.track);
        pointCount += item.timeline.data.points.length;
      }
      if (pointCount > 20000)
        throw new Error('Use a backup with at most 20,000 timeline points.');
      return item;
    });
    const settings = {};
    for (const [name, preference] of Object.entries(value.preferences)) {
      if (!validPreference(name, preference))
        throw new Error('The backup contains an invalid preference.');
      settings[name] = preference;
    }
    return {
      format: 'soundcloud-tempo-control',
      version: 1,
      tracks: entries,
      preferences: settings,
    };
  }

  function exportBackup() {
    const text = JSON.stringify(
      {
        format: 'soundcloud-tempo-control',
        version: 1,
        tracks: tracks(),
        preferences: readPreferences(),
      },
      null,
      2,
    );
    validateBackup(text);
    return text;
  }

  function prepare(text) {
    const data = validateBackup(text);
    const changes = [];
    for (const entry of data.tracks) {
      if (entry.speed)
        changes.push([
          keyFor(speedPrefix, entry.track),
          JSON.stringify(entry.speed.enabled ? entry.speed.rate : entry.speed),
        ]);
      if (entry.timeline)
        changes.push([
          keyFor(timelinePrefix, entry.track),
          JSON.stringify(entry.timeline),
        ]);
    }
    for (const [name, value] of Object.entries(data.preferences))
      changes.push(['soundcloud.tempo.' + name, JSON.stringify(value)]);
    const before = new Map(
      changes.map(([key]) => [key, storage().getItem(key)]),
    );
    return { data, changes, before };
  }

  function commit(preview) {
    const source = storage();
    for (const [key, value] of preview.before) {
      if (source.getItem(key) !== value)
        throw new Error(
          'Saved settings changed. Preview this file again before importing.',
        );
    }
    const written = [];
    try {
      for (const [key, value] of preview.changes) {
        source.setItem(key, value);
        written.push(key);
      }
    } catch {
      let restored = true;
      for (const key of written.reverse()) {
        try {
          const old = preview.before.get(key);
          if (old === null) source.removeItem(key);
          else source.setItem(key, old);
        } catch {
          restored = false;
        }
      }
      throw new Error(
        restored
          ? 'Import failed. Your previous settings were kept. Free some site storage and retry.'
          : 'Import stopped, but some settings could not be restored. Keep your backup and retry after allowing site storage.',
      );
    }
    return preview.changes.map(([key]) => key);
  }

  return {
    limit,
    speed,
    timeline,
    tracks,
    set,
    exportBackup,
    validateBackup,
    prepare,
    commit,
  };
}

export function createTempoLibrary(api) {
  const { store, root } = api;
  const get = (selector) => root.querySelector(selector);
  let preview = null;
  let fileRequest = 0;
  let shown = 100;
  let previousQuery = '';
  let removed = null;
  const status = (message) => {
    get('.settings-status').textContent = message;
  };

  function button(text, label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.setAttribute('aria-label', label);
    element.addEventListener('click', action);
    return element;
  }

  function mutate(track, type, value, message, redraw = true) {
    try {
      store.set(track, type, value);
      api.changed(track, type);
      if (redraw) render();
      status(message);
      return true;
    } catch {
      status(
        'Could not update this saved item. Allow site storage or free space and retry.',
      );
      return false;
    }
  }

  function readLatest(track, type) {
    try {
      const value = store[type](track);
      if (!value) {
        render();
        status('This saved item was removed in another tab.');
      }
      return value;
    } catch {
      status(
        'Could not read this saved item. Allow site storage and reopen settings.',
      );
      return null;
    }
  }

  function removeSetting(track, type, name) {
    const value = readLatest(track, type);
    if (!value || !mutate(track, type, null, `${name} removed.`)) return;
    removed = { track, type, value };
    get('.saved-undo').hidden = false;
    get('#saved-filter').focus();
  }

  function appendSetting(row, entry, type) {
    const saved = entry[type];
    if (!saved) return;
    const line = document.createElement('div');
    line.className = 'saved-setting';
    line.dataset.type = type;
    const label = document.createElement('label');
    label.className = 'saved-switch';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = saved.enabled;
    enabled.setAttribute('aria-label', `Use saved ${type} for ${entry.track}`);
    const name = type === 'speed' ? 'Speed' : 'Timeline';
    label.append(enabled);
    enabled.addEventListener('change', () => {
      const previous = !enabled.checked;
      const latest = readLatest(entry.track, type);
      if (
        !latest ||
        !mutate(
          entry.track,
          type,
          { ...latest, enabled: enabled.checked },
          `${name} ${enabled.checked ? 'enabled' : 'disabled'}.${type === 'speed' ? ' Applies next visit.' : ''}`,
          false,
        )
      ) {
        enabled.checked = latest?.enabled ?? previous;
        return;
      }
    });
    line.append(label);
    if (type === 'speed') {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0.025';
      input.max = '4';
      input.step = '0.001';
      input.value = String(saved.rate);
      input.setAttribute('aria-label', `Saved speed for ${entry.track}`);
      const save = () => {
        if (!input.value.trim() || !input.checkValidity()) {
          input.reportValidity();
          return;
        }
        const latest = readLatest(entry.track, type);
        if (!latest) {
          render();
          return;
        }
        if (latest.rate === Number(input.value)) return;
        if (
          !mutate(
            entry.track,
            type,
            { ...latest, rate: Number(input.value) },
            'Saved speed updated. Applies next visit.',
            false,
          )
        )
          input.value = String(latest.rate);
      };
      input.addEventListener('change', save);
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        save();
      });
      const value = document.createElement('span');
      value.className = 'saved-value';
      const unit = document.createElement('span');
      unit.textContent = '×';
      unit.setAttribute('aria-hidden', 'true');
      value.append(input, unit);
      line.append(value);
    } else {
      line.append(
        button('Timeline', `Edit timeline for ${entry.track}`, () =>
          api.edit(entry.track),
        ),
      );
    }
    const remove = button('', `Remove saved ${type} for ${entry.track}`, () => {
      removeSetting(entry.track, type, name);
    });
    remove.className = 'saved-remove';
    remove.title = `Remove ${type}`;
    remove.innerHTML =
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>';
    line.append(remove);
    row.append(line);
  }

  function render() {
    const query = get('#saved-filter').value.trim().toLowerCase();
    if (query !== previousQuery) shown = 100;
    previousQuery = query;
    let entries;
    try {
      entries = store
        .tracks()
        .filter((entry) => entry.track.toLowerCase().includes(query));
    } catch {
      status(
        'Saved tracks are unavailable. Allow site storage and reopen settings.',
      );
      return;
    }
    const list = get('.saved-list');
    list.replaceChildren();
    get('.saved-count').textContent = entries.length
      ? `${entries.length} saved ${entries.length === 1 ? 'track' : 'tracks'}`
      : query
        ? 'No saved tracks match.'
        : 'No saved tracks yet.';
    for (const entry of entries.slice(0, shown)) {
      const row = document.createElement('div');
      row.className = 'saved-row';
      row.dataset.track = entry.track;
      const link = document.createElement('a');
      link.href = 'https://soundcloud.com' + entry.track;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.track.slice(1).replaceAll('/', ' / ');
      link.title = link.textContent;
      row.append(link);
      appendSetting(row, entry, 'speed');
      appendSetting(row, entry, 'timeline');
      list.append(row);
    }
    get('.saved-more').hidden = entries.length <= shown;
  }

  function clearPreview() {
    fileRequest++;
    preview = null;
    get('.backup-preview').hidden = true;
    get('.backup-file').value = '';
  }

  function showPreview(value) {
    preview = value;
    const { data } = value;
    const speeds = data.tracks.filter((entry) => entry.speed).length;
    const timelines = data.tracks.filter((entry) => entry.timeline).length;
    const conflicts = value.changes.filter(
      ([key]) => value.before.get(key) !== null,
    ).length;
    get('.backup-summary').textContent =
      `${speeds} ${speeds === 1 ? 'speed' : 'speeds'}, ${timelines} ${timelines === 1 ? 'timeline' : 'timelines'}. ${conflicts ? `Replaces ${conflicts} existing settings.` : 'No existing settings replaced.'}`;
    get('.backup-preferences').textContent = Object.keys(data.preferences)
      .length
      ? `Includes preferences${data.preferences.outputDb === undefined ? '' : ` and ${data.preferences.outputDb} dB output`}. Audio settings apply now.`
      : 'Other saved tracks and preferences stay unchanged.';
    get('.backup-preview').hidden = false;
    get('.backup-confirm').focus();
    status('');
  }

  async function readBackup() {
    const file = get('.backup-file').files[0];
    clearPreview();
    if (!file) return;
    const request = fileRequest;
    if (file.size > store.limit) {
      status('Choose a backup smaller than 2 MB.');
      return;
    }
    try {
      const text = await file.text();
      if (request !== fileRequest) return;
      showPreview(store.prepare(text));
    } catch (error) {
      if (request === fileRequest)
        status(
          error.message || 'Could not read this backup. Choose the file again.',
        );
    }
  }

  get('.backup-file').addEventListener('change', readBackup);
  get('.backup-import').addEventListener('click', () =>
    get('.backup-file').click(),
  );
  get('.backup-cancel').addEventListener('click', () => {
    clearPreview();
    status('Import cancelled.');
    get('.backup-import').focus();
  });
  get('.backup-confirm').addEventListener('click', () => {
    if (!preview) return;
    try {
      const keys = store.commit(preview);
      api.imported(keys);
      removed = null;
      get('.saved-undo').hidden = true;
      clearPreview();
      render();
      status('Backup imported.');
      get('.backup-import').focus();
    } catch (error) {
      status(error.message);
    }
  });
  get('.backup-export').addEventListener('click', () => {
    let url;
    try {
      url = URL.createObjectURL(
        new Blob([store.exportBackup()], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `tempo-control-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      status('Backup downloaded.');
    } catch (error) {
      status(
        error.message ||
          'Could not export saved tracks. Allow site storage and retry.',
      );
    } finally {
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
  get('.saved-more').addEventListener('click', () => {
    shown += 100;
    render();
  });
  get('.saved-undo').addEventListener('click', () => {
    if (!removed) return;
    const { track, type, value } = removed;
    try {
      if (store[type](track)) {
        status('This track already has a new saved setting. It was kept.');
        return;
      }
      if (!mutate(track, type, value, 'Saved item restored.')) return;
      removed = null;
      get('.saved-undo').hidden = true;
      get('#saved-filter').focus();
    } catch {
      status('Could not restore the saved item. Allow site storage and retry.');
    }
  });
  return { render, clearPreview };
}
