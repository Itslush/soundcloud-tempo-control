(() => {
  const records = [];
  const documents = new WeakSet();
  const frames = new WeakSet();
  const describe = (text) => {
    try {
      const url = new URL(text);
      return {host:url.hostname, tempo:url.hash.startsWith('#sct=SCT1.'), length:text.length};
    } catch {
      return {kind:typeof text};
    }
  };
  function record(value) {
    if (records.length === 64) records.shift();
    records.push({time:performance.now(), ...value});
    if (document.documentElement)
      document.documentElement.dataset.tempoCopyTrace = JSON.stringify(records);
  }
  function inspect(view) {
    try {
      const doc = view.document;
      if (view.location.origin !== location.origin || documents.has(doc)) return;
      documents.add(doc);
      const clipboard = view.navigator.clipboard;
      const original = clipboard?.writeText;
      const wrapped = function(text) {
        record({event:'writeText', top:view === window, ...describe(text)});
        return Reflect.apply(original, this, [text]);
      };
      if (original) clipboard.writeText = wrapped;
      doc.addEventListener('click', event => {
        const button = event.composedPath().find(node => node instanceof view.Element && node.matches('button[aria-label="Copy link"]'));
        if (!button) return;
        const current = document.querySelector('.playbackSoundBadge__titleLink')?.getAttribute('href');
        record({event:'click', trusted:event.isTrusted, top:view === window,
          header:!!button.closest('section[aria-label="Track header"]'),
          frameTrack:doc.location.pathname, currentTrack:current,
          copyEnabled:localStorage.getItem('soundcloud.tempo.copyLinks') === 'true',
          wrapper:clipboard?.writeText === wrapped ? 'probe' : 'replaced',
          wrapperSource:String(clipboard?.writeText).slice(0,240)});
      }, true);
      doc.addEventListener('copy', event => record({event:'copy', top:view === window, trusted:event.isTrusted}), true);
      record({event:'attached', top:view === window, clipboard:!!original});
    } catch (error) {
      record({event:'unavailable', name:error.name});
    }
  }
  function discover() {
    inspect(window);
    for (const frame of document.querySelectorAll('iframe')) {
      if (frame.hasAttribute('sandbox') || !frame.src.startsWith(location.origin + '/n/')) continue;
      if (!frames.has(frame)) {
        frames.add(frame);
        frame.addEventListener('load', () => inspect(frame.contentWindow));
      }
      inspect(frame.contentWindow);
    }
  }
  new MutationObserver(discover).observe(document, {childList:true, subtree:true});
  discover();
})();
