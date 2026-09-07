export function createTempoEmbeddedPages(api) {
  const frames = new Map();
  const headerSelector = 'section[aria-label="Track header"]';
  const badgeSelector = '.soundcloud-tempo-page-indicator';
  const relevantSelector = `a[href], img, ${headerSelector}`;

  function trackFromUrl(value) {
    const url = new URL(value);
    if (
      url.origin !== location.origin ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !/^\/n\/[^/]+\/[^/]+$/.test(url.pathname)
    )
      return '';
    return api.parseTrack(url.pathname.slice(2));
  }

  function inspect(frame) {
    if (!frame.isConnected || frame.hasAttribute('sandbox')) return null;
    try {
      if (!trackFromUrl(frame.src)) return null;
      const doc = frame.contentDocument;
      const view = doc?.defaultView;
      if (!view || !doc.documentElement) return null;
      const key = trackFromUrl(view.location.href);
      return key ? { doc, view, key } : null;
    } catch {
      return null;
    }
  }

  function current(entry) {
    const value = inspect(entry.frame);
    return value?.doc === entry.doc && value.key === entry.key;
  }

  function restoreLink(entry) {
    const link = entry.contextLink;
    if (!link) return;
    if (link.anchor.getAttribute('href') === link.shared)
      link.anchor.setAttribute('href', link.original);
    entry.contextLink = null;
  }

  function cancelIntent(entry) {
    entry.copyUntil = 0;
    restoreLink(entry);
  }

  function shareText(entry, text) {
    const copyUntil = entry.copyUntil;
    entry.copyUntil = 0;
    if (!current(entry)) return text;
    const shared = api.shareLink(text);
    if (shared !== text) return shared;
    if (
      !api.copyLinks() ||
      !copyUntil ||
      copyUntil < performance.now() ||
      entry.key !== api.currentTrack() ||
      typeof text !== 'string' ||
      text.length > 8000
    )
      return text;
    try {
      const url = new URL(text);
      if (
        url.origin !== 'https://on.soundcloud.com' ||
        url.username ||
        url.password ||
        url.hash ||
        !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      )
        return text;
      return api.shareLink(`https://soundcloud.com${entry.key}`);
    } catch {
      return text;
    }
  }

  function listen(entry, target, type, callback, capture = false) {
    target.addEventListener(type, callback, capture);
    entry.cleanup.push(() =>
      target.removeEventListener(type, callback, capture),
    );
  }

  function installCopy(entry) {
    const { doc, view } = entry;
    listen(entry, doc, 'pointerdown', () => cancelIntent(entry), true);
    listen(entry, doc, 'keydown', () => cancelIntent(entry), true);
    listen(
      entry,
      doc,
      'click',
      (event) => {
        entry.copyUntil = 0;
        if (!event.isTrusted || !api.copyLinks() || !current(entry)) return;
        const button = event
          .composedPath()
          .find(
            (node) =>
              node instanceof view.Element &&
              node.matches('button[aria-label="Copy link"]'),
          );
        if (button?.closest(headerSelector) && entry.key === api.currentTrack())
          entry.copyUntil = performance.now() + 5000;
      },
      true,
    );
    listen(
      entry,
      doc,
      'contextmenu',
      (event) => {
        cancelIntent(entry);
        if (!api.copyLinks() || !current(entry)) return;
        const anchor = event
          .composedPath()
          .find((node) => node instanceof view.HTMLAnchorElement);
        const original = anchor?.getAttribute('href');
        if (original === undefined || original === null) return;
        const shared = api.shareLink(anchor.href);
        if (shared === anchor.href) return;
        entry.contextLink = { anchor, original, shared };
        anchor.setAttribute('href', shared);
      },
      true,
    );
    listen(entry, view, 'copy', (event) => {
      if (!api.copyLinks() || !event.clipboardData || !current(entry)) return;
      const target = doc.activeElement;
      const selected =
        target instanceof view.HTMLInputElement ||
        target instanceof view.HTMLTextAreaElement
          ? target.value.slice(
              target.selectionStart ?? 0,
              target.selectionEnd ?? 0,
            )
          : String(view.getSelection());
      const original = event.clipboardData.getData('text/plain') || selected;
      const shared = shareText(entry, original);
      if (shared === original) return;
      event.clipboardData.setData('text/plain', shared);
      event.clipboardData.clearData('text/html');
      event.preventDefault();
    });
    try {
      const clipboard = view.navigator.clipboard;
      if (!clipboard?.writeText) return;
      const original = clipboard.writeText;
      const writeText = (text) =>
        original.call(clipboard, shareText(entry, text));
      clipboard.writeText = writeText;
      entry.cleanup.push(() => {
        if (clipboard.writeText === writeText) clipboard.writeText = original;
      });
    } catch {}
  }

  function relevantMutation(mutation) {
    if (mutation.type === 'attributes') return true;
    if (
      mutation.target.nodeType === 1 &&
      mutation.target.closest(headerSelector)
    )
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) => node.nodeType !== 1 || !node.matches(badgeSelector),
      );
    return [...mutation.addedNodes, ...mutation.removedNodes].some(
      (node) =>
        node.nodeType === 1 &&
        !node.matches(badgeSelector) &&
        (node.matches(relevantSelector) ||
          node.querySelector(relevantSelector)),
    );
  }

  function detach(entry) {
    cancelIntent(entry);
    entry.observer.disconnect();
    for (const cleanup of entry.cleanup) cleanup();
    entry.style.remove();
    entry.doc
      .querySelectorAll(badgeSelector)
      .forEach((badge) => badge.remove());
    entry.doc
      .querySelectorAll('.soundcloud-tempo-page-position')
      .forEach((artwork) =>
        artwork.classList.remove('soundcloud-tempo-page-position'),
      );
  }

  function attach(frame, value) {
    const entry = {
      frame,
      ...value,
      cleanup: [],
      copyUntil: 0,
      contextLink: null,
    };
    const style = entry.doc.createElement('style');
    style.dataset.soundcloudTempoEmbedded = '';
    style.textContent = `
      .soundcloud-tempo-page-position {
        position: relative;
      }
    `;
    (entry.doc.head || entry.doc.documentElement).append(style);
    entry.style = style;
    const releaseAppearance = api.appearance?.(entry.doc);
    if (releaseAppearance) entry.cleanup.push(releaseAppearance);
    entry.observer = new MutationObserver((mutations) => {
      if (!current(entry)) return sync();
      if (mutations.some(relevantMutation)) api.changed();
    });
    entry.observer.observe(entry.doc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'src', 'srcset', 'alt', 'sizes', 'aria-label'],
    });
    installCopy(entry);
    listen(
      entry,
      entry.doc,
      'load',
      (event) => {
        if (event.target instanceof entry.view.HTMLImageElement) api.changed();
      },
      true,
    );
    listen(entry, entry.view, 'hashchange', sync);
    listen(entry, entry.view, 'popstate', sync);
    return entry;
  }

  function sync() {
    let changed = false;
    for (const [frame, state] of frames) {
      const value = inspect(frame);
      if (
        state.entry &&
        (state.entry.doc !== value?.doc || state.entry.key !== value?.key)
      ) {
        detach(state.entry);
        state.entry = null;
        changed = true;
      }
      if (!frame.isConnected) {
        frame.removeEventListener('load', sync);
        frames.delete(frame);
        continue;
      }
      if (value && !state.entry) {
        state.entry = attach(frame, value);
        changed = true;
      }
    }
    if (changed) api.changed();
  }

  function discover() {
    for (const frame of document.querySelectorAll('iframe')) {
      if (frames.has(frame)) continue;
      frames.set(frame, { entry: null });
      frame.addEventListener('load', sync);
    }
    sync();
  }

  new MutationObserver((mutations) => {
    const changed = mutations.some((mutation) => {
      if (mutation.type === 'attributes')
        return mutation.target.tagName === 'IFRAME';
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) =>
          node.nodeType === 1 &&
          (node.tagName === 'IFRAME' || node.querySelector('iframe')),
      );
    });
    if (changed) discover();
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'sandbox'],
  });
  const cancelAll = () => {
    for (const { entry } of frames.values()) if (entry) cancelIntent(entry);
  };
  document.addEventListener('pointerdown', cancelAll, true);
  document.addEventListener('keydown', cancelAll, true);
  window.addEventListener('pagehide', cancelAll);
  discover();

  return {
    documents: () =>
      [...frames.values()].flatMap(({ entry }) =>
        entry && current(entry) ? [entry.doc] : [],
      ),
    key: (doc) => {
      for (const { entry } of frames.values())
        if (entry?.doc === doc && current(entry)) return entry.key;
      return '';
    },
  };
}
