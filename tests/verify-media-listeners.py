import hashlib
import json
import re
import time
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options

TRACK = 'https://soundcloud.com/nasa/sounds-of-the-sun'


def main():
    fixture = ROOT / 'tests/fixtures/media-listeners-probe.js'
    module = (ROOT / 'src/audio/media-facade.mjs').read_bytes()
    source = module.decode('utf-8')
    if source.count('export function createMediaFacade') != 1:
        raise ValueError('Media facade diagnostic adapter requires review')
    script = '(() => {' + source.replace('export function createMediaFacade', 'function createMediaFacade') + '\n globalThis.createMediaFacade = createMediaFacade;})();\n' + fixture.read_text(encoding='utf-8')
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'track': TRACK,
        'scope': 'Isolated public SoundCloud native event registration and facade suppression diagnostic, not real buffered audio output',
        'audio': 'Muted browser and observed media elements',
        'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
        'facadeSha256': hashlib.sha256(module).hexdigest(),
        'status': 'INCONCLUSIVE',
    }
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        report['browser'] = browser.version
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(script)
        page = context.new_page()
        try:
            page.goto(TRACK, wait_until='domcontentloaded', timeout=30000)
            reject = page.get_by_role('button', name=re.compile('^Reject all$', re.I)).first
            try:
                reject.wait_for(state='visible', timeout=8000)
            except Exception:
                if page.locator('.onetrust-pc-dark-filter:visible').count():
                    raise
            if reject.count() and reject.is_visible():
                reject.click(timeout=3000)
            page.locator('.onetrust-pc-dark-filter').wait_for(state='hidden', timeout=10000)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                modal = page.locator('.auth-modal:visible')
                if modal.count():
                    modal.get_by_role('button', name='Close', exact=True).click(timeout=3000)
                    modal.wait_for(state='hidden', timeout=3000)
                    break
                page.wait_for_timeout(200)
            button = page.locator('.soundTitle__playButtonHero .playButton').first
            button.wait_for(state='visible', timeout=15000)
            if button.get_attribute('title') == 'Play':
                button.click(timeout=5000)
            elif button.get_attribute('title') != 'Pause':
                raise ValueError('Unrecognized public player action')
            page.wait_for_function('mediaListenersProbe.snapshot().media.some(audio => audio.currentTime > 3)', timeout=25000)
            cdp = context.new_cdp_session(page)
            report['listenerInventory'] = {}
            for name, expression in [('media', 'mediaListenersProbe.getMedia()'), ('document', 'document'), ('window', 'window')]:
                target = cdp.send('Runtime.evaluate', {'expression': expression, 'objectGroup': 'listener-probe'})['result']
                result = cdp.send('DOMDebugger.getEventListeners', {'objectId': target['objectId']})['listeners']
                report['listenerInventory'][name] = [{key: value for key, value in listener.items() if key in ['type', 'useCapture', 'passive', 'once', 'scriptId', 'lineNumber', 'columnNumber']} for listener in result if listener['type'] in ['play', 'playing', 'pause', 'timeupdate', 'seeking', 'seeked', 'ended']]
            cdp.send('Runtime.releaseObjectGroup', {'objectGroup': 'listener-probe'})
            report['diagnostic'] = page.evaluate('mediaListenersProbe.run()')
            report['status'] = report['diagnostic']['status']
        except Exception as error:
            report['error'] = type(error).__name__
            report['message'] = str(error)[:1000]
            report['partial'] = page.evaluate('globalThis.mediaListenersProbe?.snapshot()')
        finally:
            try:
                report['stopped'] = page.evaluate('globalThis.mediaListenersProbe?.stop()')
            finally:
                context.close()
                browser.close()
                report['contextClosed'] = True
    path = ROOT / 'test-results/media-listeners.json'
    path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'diagnostic'}, indent=2))
    if 'diagnostic' in report:
        result = report['diagnostic']
        print(json.dumps({'registrations': result['before']['registrations'], 'media': result['before']['media'], 'hostRaw': result['hostRaw'], 'hostSynthetic': result['hostSynthetic'], 'witness': result['witness'], 'uiBefore': result['before']['ui'], 'uiAfterNative': result['afterNativePause']['ui'], 'uiAfterFacade': result['afterFacadePause']['ui']}, indent=2))
    return 0 if report['status'] == 'OBSERVED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
