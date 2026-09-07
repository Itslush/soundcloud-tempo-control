import json
import re
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options

TRACK = '/sewerslvt/bring-me-the-horizon-drown-sewerslvt-remix'
URL = 'https://soundcloud.com' + TRACK
PROBE = r'''(() => {
  if (location.origin !== 'https://soundcloud.com') return;
  const entries = [];
  window.copyProbe = entries;
  const record = (method, data = {}) => {
    if (entries.length < 100) entries.push({method, time: performance.now(), ...data});
  };
  const describe = text => {
    if (typeof text !== 'string') return {kind: typeof text};
    try {
      const url = new URL(text);
      return {
        kind: url.origin === 'https://soundcloud.com' ? 'canonical'
          : url.origin === 'https://on.soundcloud.com' ? 'shortlink' : 'other-url',
        tempo: url.hash.startsWith('#sct=SCT1.'),
        length: text.length,
      };
    } catch {
      return {kind: 'not-url', length: text.length};
    }
  };
  const clipboard = navigator.clipboard;
  for (const name of ['writeText', 'write']) {
    if (!clipboard?.[name]) continue;
    const original = clipboard[name];
    clipboard[name] = function(...args) {
      record('clipboard.' + name, name === 'writeText'
        ? describe(args[0]) : {types: Array.from(args[0] || [], item => item.types)});
      return Reflect.apply(original, this, args);
    };
  }
  const execCommand = Document.prototype.execCommand;
  Document.prototype.execCommand = function(...args) {
    if (String(args[0]).toLowerCase() === 'copy') record('execCommand.copy');
    return Reflect.apply(execCommand, this, args);
  };
  let copying = false;
  addEventListener('copy', event => {
    copying = true;
    record('copy.capture', {trusted: event.isTrusted});
    queueMicrotask(() => { copying = false; });
  }, true);
  addEventListener('copy', event => {
    record('copy.bubble', describe(event.clipboardData?.getData('text/plain')));
  });
  for (const name of ['stopPropagation', 'stopImmediatePropagation']) {
    const original = Event.prototype[name];
    Event.prototype[name] = function(...args) {
      if (this.type === 'copy') record('copy.' + name);
      return Reflect.apply(original, this, args);
    };
  }
  const setData = DataTransfer.prototype.setData;
  DataTransfer.prototype.setData = function(type, text) {
    if (copying) record('clipboardData.setData', {type, ...describe(text)});
    return Reflect.apply(setData, this, [type, text]);
  };
  addEventListener('click', event => {
    const button = event.target.closest?.('button[aria-label="Copy link"]');
    if (button) record('copyButton.click', {trusted: event.isTrusted});
  }, true);
})();'''


def main():
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Isolated signed-out public page. Native copy API observation only.',
        'userscriptInjected': False,
        'speakerOutput': 'Muted browser; media requests blocked; no Play action.',
        'track': TRACK,
        'status': 'INCONCLUSIVE',
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, args=['--mute-audio'], **browser_options()
        )
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin='https://soundcloud.com')
        context.add_init_script(PROBE)
        context.route(
            '**/*',
            lambda route: route.abort() if route.request.resource_type == 'media'
            or re.search(r'\.(m3u8|mp3|m4a|aac|ogg)(\?|$)', route.request.url)
            else route.continue_(),
        )
        page = context.new_page()
        try:
            report['stage'] = 'navigation'
            page.goto(URL, wait_until='domcontentloaded', timeout=30000)
            reject = page.get_by_role('button', name=re.compile('^Reject all$', re.I))
            if reject.count() and reject.first.is_visible():
                reject.first.click(timeout=3000)
            page.wait_for_timeout(1500)
            view = next((frame for frame in page.frames if frame.url.startswith(
                'https://soundcloud.com/n' + TRACK)), page.main_frame)
            report['embeddedView'] = view != page.main_frame
            button = view.get_by_role('button', name='Copy link', exact=True).first
            report['stage'] = 'button-visible'
            button.wait_for(state='visible', timeout=15000)
            report['stage'] = 'button-click'
            button.click(timeout=5000)
            report['stage'] = 'clipboard-call'
            view.wait_for_function(
                "copyProbe.some(entry => entry.method.startsWith('clipboard.') "
                "|| entry.method === 'execCommand.copy')", timeout=10000
            )
            page.wait_for_timeout(500)
            report['events'] = [
                event for frame in page.frames
                if frame.url.startswith('https://soundcloud.com/')
                for event in frame.evaluate('window.copyProbe || []')
            ]
            report['audioElements'] = page.locator('audio').count()
            report['playingMedia'] = page.locator('audio, video').evaluate_all(
                'elements => elements.filter(element => !element.paused).length'
            )
            assert report['playingMedia'] == 0, report
            report['status'] = 'OBSERVED'
        except Exception as error:
            report['error'] = type(error).__name__
            report['errorMessage'] = str(error)[:1200]
            report['events'] = page.evaluate('window.copyProbe || []')
            report['buttonCount'] = page.get_by_role('button', name='Copy link', exact=True).count()
            page.screenshot(path=str(ROOT / 'test-results/live-copy-probe.png'))
        finally:
            context.close()
            browser.close()
            report['contextClosed'] = True
    path = ROOT / 'test-results/live-copy-probe.json'
    path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'OBSERVED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
