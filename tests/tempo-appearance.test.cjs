const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');

const source = require('./module-fixture.cjs')(['tempo-appearance.js']);
const key = 'soundcloud.tempo.appearance';
const attribute = 'data-tempo-appearance';

function fixture({
  saved,
  blockedRead,
  blockedWrite,
  blockedAccess,
  rootReady = true,
} = {}) {
  const values = new Map(saved === undefined ? [] : [[key, saved]]);
  const changes = [];
  const errors = [];
  const notifications = [];
  const writes = [];
  const styles = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const attributes = new Map();
  const storage = {
    getItem(name) {
      if (blockedRead) throw new Error('Storage unavailable');
      return values.get(name) ?? null;
    },
    setItem(name, value) {
      if (blockedWrite) throw new Error('Storage full');
      writes.push([name, value]);
      values.set(name, value);
    },
  };
  const root = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    append(element) {
      styles.push(element);
    },
  };
  const document = {
    documentElement: rootReady ? root : null,
    head: rootReady ? root : null,
    createElement(name) {
      assert.equal(name, 'style');
      return {
        textContent: '',
        remove() {
          const index = styles.indexOf(this);
          if (index >= 0) styles.splice(index, 1);
        },
      };
    },
    addEventListener: (name, handler) => documentListeners.set(name, handler),
    removeEventListener: (name) => documentListeners.delete(name),
  };
  const window = {
    location: { origin: 'https://soundcloud.com', protocol: 'https:' },
    document,
    localStorage: storage,
    addEventListener: (name, handler) => windowListeners.set(name, handler),
    removeEventListener: (name) => windowListeners.delete(name),
  };
  document.defaultView = window;
  if (blockedAccess)
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('Storage access denied');
      },
    });
  const create = vm.runInNewContext(`${source}\ncreateTempoAppearance;`, {
    window,
    document,
  });
  const appearance = create({
    onChange(mode) {
      changes.push(mode);
      notifications.push('change');
    },
    onError(error) {
      errors.push(error);
      notifications.push('error');
    },
  });
  return {
    create,
    appearance,
    changes,
    errors,
    notifications,
    attributes,
    styles,
    values,
    writes,
    windowListeners,
    documentListeners,
    document,
    window,
    root,
    storage,
    sync(event) {
      windowListeners.get('storage')?.({ storageArea: storage, ...event });
    },
    ready() {
      document.documentElement = root;
      document.head = root;
      documentListeners.get('DOMContentLoaded')?.();
    },
  };
}

test('native is the default and introduces no host styles or attributes', () => {
  const f = fixture();
  assert.equal(f.appearance.mode(), 'native');
  assert.equal(f.styles.length, 0);
  assert.equal(f.attributes.size, 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
  assert.equal(f.appearance.setMode('native'), false);
  f.appearance.dispose();
  assert.equal(f.windowListeners.size, 0);
});

test('mode changes reuse one stylesheet and persist only actual user changes', () => {
  const f = fixture();
  assert.equal(f.appearance.setMode('charcoal'), true);
  const style = f.styles[0];
  assert.equal(f.attributes.get(attribute), 'charcoal');
  assert.equal(f.appearance.setMode('oled'), true);
  assert.equal(f.styles.length, 1);
  assert.equal(f.styles[0], style);
  assert.equal(f.attributes.get(attribute), 'oled');
  assert.equal(f.appearance.setMode('oled'), false);
  assert.deepEqual(f.changes, ['charcoal', 'oled']);
  assert.deepEqual(f.writes, [
    [key, 'charcoal'],
    [key, 'oled'],
  ]);
  f.appearance.setMode('native');
  assert.equal(f.styles.length, 0);
  assert.equal(f.attributes.has(attribute), false);
  assert.equal(f.values.get(key), 'native');
  f.appearance.dispose();
});

test('saved modes apply without writing or announcing initialization', () => {
  for (const saved of ['native', 'charcoal', 'oled']) {
    const f = fixture({ saved });
    assert.equal(f.appearance.mode(), saved);
    assert.equal(f.styles.length, saved === 'native' ? 0 : 1);
    assert.deepEqual(f.changes, []);
    assert.deepEqual(f.writes, []);
    f.appearance.dispose();
  }
});

test('unknown saved values fall back to native without overwriting storage', () => {
  for (const saved of ['', 'dark', 'CHARCOAL', '<style>']) {
    const f = fixture({ saved });
    assert.equal(f.appearance.mode(), 'native');
    assert.equal(f.styles.length, 0);
    assert.equal(f.values.get(key), saved);
    f.appearance.dispose();
  }
});

test('inaccessible or full storage does not block a session-only theme', () => {
  for (const options of [
    { blockedRead: true },
    { blockedWrite: true },
    { blockedAccess: true },
  ]) {
    const f = fixture(options);
    f.appearance.setMode('oled');
    assert.equal(f.appearance.mode(), 'oled');
    assert.equal(f.attributes.get(attribute), 'oled');
    f.appearance.dispose();
    assert.equal(f.attributes.has(attribute), false);
  }
});

test('storage events synchronize local preference without echoing writes', () => {
  const f = fixture();
  f.sync({ key, newValue: 'charcoal' });
  f.sync({ key, newValue: 'oled' });
  assert.equal(f.appearance.mode(), 'oled');
  assert.deepEqual(f.changes, ['charcoal', 'oled']);
  assert.deepEqual(f.writes, []);
  f.sync({ key: 'unrelated', newValue: 'native' });
  f.sync({ key, newValue: 'native', storageArea: {} });
  assert.equal(f.appearance.mode(), 'oled');
  f.sync({ key: null, newValue: null });
  assert.equal(f.appearance.mode(), 'native');
  assert.equal(f.styles.length, 0);
  f.appearance.dispose();
});

test('removed and invalid synced preferences restore the native surface', () => {
  for (const newValue of [null, 'unknown']) {
    const f = fixture({ saved: 'charcoal' });
    f.sync({ key, newValue });
    assert.equal(f.appearance.mode(), 'native');
    assert.equal(f.styles.length, 0);
    assert.equal(f.attributes.has(attribute), false);
    f.appearance.dispose();
  }
});

test('document-start initialization waits once without polling', () => {
  const f = fixture({ saved: 'charcoal', rootReady: false });
  assert.equal(f.styles.length, 0);
  f.appearance.setMode('oled');
  f.ready();
  assert.equal(f.styles.length, 1);
  assert.equal(f.attributes.get(attribute), 'oled');
  f.appearance.dispose();
  assert.equal(f.documentListeners.size, 0);
});

test('disposal before the root exists cancels pending initialization', () => {
  const f = fixture({ saved: 'oled', rootReady: false });
  f.appearance.dispose();
  f.ready();
  assert.equal(f.styles.length, 0);
  assert.equal(f.attributes.size, 0);
  assert.equal(f.windowListeners.size, 0);
  assert.equal(f.appearance.setMode('charcoal'), false);
});

test('native restoration preserves preexisting attributes and foreign changes', () => {
  const f = fixture();
  f.attributes.set(attribute, 'external');
  f.appearance.setMode('charcoal');
  f.appearance.setMode('native');
  assert.equal(f.attributes.get(attribute), 'external');
  f.appearance.setMode('oled');
  f.attributes.set(attribute, 'another-owner');
  f.appearance.dispose();
  assert.equal(f.attributes.get(attribute), 'another-owner');
  assert.equal(f.styles.length, 0);
  f.appearance.dispose();
  assert.equal(f.attributes.get(attribute), 'another-owner');
});

test('invalid options and modes fail without changing host state', () => {
  const f = fixture();
  assert.throws(() => f.create({ onChange: true }), /Invalid appearance/);
  assert.throws(() => f.create({ onError: true }), /Invalid appearance/);
  for (const mode of [undefined, null, {}, 'dark', 'OLED'])
    assert.throws(() => f.appearance.setMode(mode), /Invalid appearance mode/);
  assert.equal(f.attributes.size, 0);
  assert.equal(f.styles.length, 0);
  f.appearance.dispose();
});

test('unsaved changes report persistence failure after applying and notifying', () => {
  for (const options of [{ blockedWrite: true }, { blockedAccess: true }]) {
    const f = fixture(options);
    f.appearance.setMode('charcoal');
    assert.equal(f.appearance.mode(), 'charcoal');
    assert.equal(f.attributes.get(attribute), 'charcoal');
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.notifications, ['change', 'error']);
    f.appearance.setMode('native');
    assert.equal(f.appearance.mode(), 'native');
    assert.equal(f.attributes.size, 0);
    assert.equal(f.styles.length, 0);
    assert.equal(f.errors.length, 2);
    f.appearance.dispose();
  }
});

test('DOM application failure rolls back before preference or callback changes', () => {
  const f = fixture();
  f.root.setAttribute = () => {
    throw new Error('DOM unavailable');
  };
  assert.throws(() => f.appearance.setMode('oled'), /DOM unavailable/);
  assert.equal(f.appearance.mode(), 'native');
  assert.equal(f.styles.length, 0);
  assert.equal(f.attributes.size, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.changes.length, 0);
  f.appearance.dispose();
});

test('the scoped stylesheet covers observed interactive theme tokens without altering light roles', () => {
  const f = fixture({ saved: 'oled' });
  const css = f.styles[0].textContent;
  for (const name of ['primary', 'secondary', 'tertiary'])
    for (const state of [
      '',
      'disabled-',
      'selected-',
      'selected-active-',
      'loading-',
      'active-',
    ])
      for (const property of ['background', 'font'])
        assert.ok(css.includes(`--button-${name}-${state}${property}-color:`));
  for (const name of ['standard', 'primary', 'secondary'])
    for (const state of ['', 'hover-', 'active-', 'disabled-'])
      assert.ok(css.includes(`--link-${name}-${state}color:`));
  for (const name of [
    'default',
    'placeholder',
    'focused',
    'invalid',
    'disabled',
  ])
    for (const property of ['background', 'font'])
      assert.ok(css.includes(`--input-${name}-${property}-color:`));
  assert.doesNotMatch(
    css,
    /--(?:white|background-light|font-light|input-invalid-border)-color\s*:/,
  );
  assert.match(
    css,
    /html:is\(\[data-tempo-appearance="charcoal"\],\[data-tempo-appearance="oled"\]\)/,
  );
  f.appearance.dispose();
});

test('styles preserve host geometry and use static, varied, non-glowing stars', () => {
  const f = fixture({ saved: 'charcoal' });
  const css = f.styles[0].textContent;
  assert.match(css, /@media \(forced-colors: none\)/);
  assert.match(css, /--tempo-page-accent: #ff5500/);
  assert.match(css, /--tempo-page-ground: #000/);
  assert.doesNotMatch(
    css,
    /(?:filter|animation|transition|position|display|width|height|padding|margin|font-family)\s*:/,
  );
  assert.doesNotMatch(css, /(?:^|[\s,])\*\s*[{,:]/);
  const svg = decodeURIComponent(css.match(/data:image\/svg\+xml,([^\"]+)/)[1]);
  assert.equal((svg.match(/<use /g) || []).length, 22);
  for (const shape of ['#ray', '#diamond', '#pair'])
    assert.ok(svg.includes(`href="${shape}"`));
  assert.doesNotMatch(svg, /filter|blur|animate|script|image|foreignObject/);
  assert.equal((css.match(/url\(/g) || []).length, 1);
  assert.ok(css.length < 20000);
  f.appearance.dispose();
});

test('foreground, muted labels and orange retain readable charcoal contrast', () => {
  const luminance = (hex) => {
    const values = hex.match(/\w\w/g).map((pair) => parseInt(pair, 16) / 255);
    const channels = values.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    return channels.reduce(
      (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
      0,
    );
  };
  for (const foreground of ['f4f4f4', 'b2b2b2', 'ff5500'])
    for (const background of ['111111', '202020', '000000', '0b0b0b'])
      assert.ok(
        (luminance(foreground) + 0.05) / (luminance(background) + 0.05) >= 4.5,
      );
});

test('explicit document attachments inherit current and future modes', () => {
  const f = fixture({ saved: 'charcoal' });
  const first = fixture();
  const second = fixture();
  const releaseFirst = f.appearance.attachDocument(first.document);
  const releaseSecond = f.appearance.attachDocument(second.document);
  for (const item of [f, first, second]) {
    assert.equal(item.attributes.get(attribute), 'charcoal');
    assert.equal(item.styles.length, 1);
    assert.equal(item.styles[0].textContent, f.styles[0].textContent);
  }
  f.appearance.setMode('oled');
  for (const item of [f, first, second])
    assert.equal(item.attributes.get(attribute), 'oled');
  f.sync({ key, newValue: 'native' });
  for (const item of [f, first, second]) {
    assert.equal(item.attributes.has(attribute), false);
    assert.equal(item.styles.length, 0);
  }
  f.appearance.setMode('charcoal');
  releaseFirst();
  releaseFirst();
  assert.equal(first.attributes.has(attribute), false);
  assert.equal(first.styles.length, 0);
  assert.equal(second.attributes.get(attribute), 'charcoal');
  releaseSecond();
  for (const item of [f, first, second]) item.appearance.dispose();
});

test('native attachment stays untouched until a non-native mode is selected', () => {
  const f = fixture();
  const child = fixture();
  const release = f.appearance.attachDocument(child.document);
  assert.equal(child.styles.length, 0);
  assert.equal(child.attributes.size, 0);
  f.appearance.setMode('oled');
  assert.equal(child.attributes.get(attribute), 'oled');
  release();
  assert.equal(child.attributes.size, 0);
  f.appearance.setMode('charcoal');
  assert.equal(child.styles.length, 0);
  f.appearance.dispose();
  child.appearance.dispose();
});

test('document cleanup preserves previous attributes and foreign ownership', () => {
  const f = fixture({ saved: 'oled' });
  const child = fixture();
  child.attributes.set(attribute, 'existing');
  let release = f.appearance.attachDocument(child.document);
  release();
  assert.equal(child.attributes.get(attribute), 'existing');
  release = f.appearance.attachDocument(child.document);
  child.attributes.set(attribute, 'foreign');
  release();
  assert.equal(child.attributes.get(attribute), 'foreign');
  assert.equal(child.styles.length, 0);
  f.appearance.dispose();
  child.appearance.dispose();
});

test('navigation retires the old document without touching its replacement', () => {
  const f = fixture({ saved: 'charcoal' });
  const previous = fixture();
  const replacement = fixture();
  const releasePrevious = f.appearance.attachDocument(previous.document);
  previous.window.document = replacement.document;
  replacement.document.defaultView = previous.window;
  const releaseReplacement = f.appearance.attachDocument(replacement.document);
  f.appearance.setMode('oled');
  assert.equal(previous.attributes.size, 0);
  assert.equal(previous.styles.length, 0);
  assert.equal(replacement.attributes.get(attribute), 'oled');
  releasePrevious();
  assert.equal(replacement.attributes.get(attribute), 'oled');
  releaseReplacement();
  for (const item of [f, previous, replacement]) item.appearance.dispose();
});

test('cross-origin, inaccessible and stale documents are rejected', () => {
  const f = fixture({ saved: 'charcoal' });
  const child = fixture();
  child.window.location.origin = 'https://example.com';
  assert.throws(
    () => f.appearance.attachDocument(child.document),
    /Invalid appearance document/,
  );
  assert.equal(child.styles.length, 0);
  child.window.location.origin = f.window.location.origin;
  child.window.document = {};
  assert.throws(
    () => f.appearance.attachDocument(child.document),
    /Invalid appearance document/,
  );
  const inaccessible = {};
  Object.defineProperty(inaccessible, 'defaultView', {
    get() {
      throw new Error('Permission denied');
    },
  });
  for (const doc of [null, {}, inaccessible, f.document])
    assert.throws(
      () => f.appearance.attachDocument(doc),
      /Invalid appearance document/,
    );
  f.appearance.dispose();
  child.appearance.dispose();
});

test('the attachment limit is bounded and cleanup frees admission', () => {
  const f = fixture();
  const children = Array.from({ length: 17 }, () => fixture());
  const releases = children
    .slice(0, 16)
    .map((child) => f.appearance.attachDocument(child.document));
  assert.throws(
    () => f.appearance.attachDocument(children[16].document),
    /Invalid appearance document/,
  );
  assert.throws(
    () => f.appearance.attachDocument(children[0].document),
    /Invalid appearance document/,
  );
  releases[0]();
  const releaseLast = f.appearance.attachDocument(children[16].document);
  f.appearance.dispose();
  for (const release of [...releases, releaseLast]) release();
  assert.throws(
    () => f.appearance.attachDocument(children[0].document),
    /Invalid appearance document/,
  );
  for (const child of children) child.appearance.dispose();
});

test('a failed attachment rolls back without disturbing the current document', () => {
  const f = fixture({ saved: 'charcoal' });
  const child = fixture();
  const setAttribute = child.root.setAttribute;
  child.root.setAttribute = () => {
    throw new Error('Child DOM unavailable');
  };
  assert.throws(
    () => f.appearance.attachDocument(child.document),
    /Child DOM unavailable/,
  );
  assert.equal(child.styles.length, 0);
  assert.equal(child.attributes.size, 0);
  assert.equal(f.attributes.get(attribute), 'charcoal');
  child.root.setAttribute = setAttribute;
  const release = f.appearance.attachDocument(child.document);
  release();
  f.appearance.dispose();
  child.appearance.dispose();
});

test('mode application failure rolls back documents already changed', () => {
  const f = fixture({ saved: 'charcoal' });
  const child = fixture();
  const release = f.appearance.attachDocument(child.document);
  const setAttribute = child.root.setAttribute;
  child.root.setAttribute = (name, value) => {
    if (value === 'oled') throw new Error('Child mode unavailable');
    setAttribute(name, value);
  };
  assert.throws(() => f.appearance.setMode('oled'), /Child mode unavailable/);
  assert.equal(f.appearance.mode(), 'charcoal');
  assert.equal(f.attributes.get(attribute), 'charcoal');
  assert.equal(child.attributes.get(attribute), 'charcoal');
  assert.equal(f.writes.length, 0);
  release();
  f.appearance.dispose();
  child.appearance.dispose();
});

test('disposal restores all attached documents and makes their cleanup inert', () => {
  const f = fixture({ saved: 'oled' });
  const first = fixture();
  const second = fixture();
  const releases = [first, second].map((child) =>
    f.appearance.attachDocument(child.document),
  );
  f.appearance.dispose();
  for (const item of [f, first, second]) {
    assert.equal(item.styles.length, 0);
    assert.equal(item.attributes.size, 0);
  }
  for (const release of releases) {
    release();
    release();
  }
  first.appearance.dispose();
  second.appearance.dispose();
});
