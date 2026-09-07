import hashlib
import json
import re
import time
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options

TRACK = 'https://soundcloud.com/nasa/sounds-of-the-sun'


def main():
    fixture = ROOT / 'tests/fixtures/source-binding-probe.js'
    module = (ROOT / 'src/audio/source-binding.mjs').read_bytes()
    source = module.decode('utf-8')
    if source.count('export function createSourceBinding') != 1:
        raise ValueError('Source binding diagnostic adapter requires review')
    adapted = '(() => {' + source.replace('export function createSourceBinding', 'function createSourceBinding') + '\n globalThis.createSourceBinding = createSourceBinding;})();'
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'track': TRACK,
        'scope': 'Short isolated public stream ownership trace; no account or installed userscript changes',
        'audio': 'Muted browser and observed media elements',
        'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
        'sourceSha256': hashlib.sha256(module).hexdigest(),
        'status': 'INCONCLUSIVE',
    }
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        report['browser'] = browser.version
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(adapted + '\n' + fixture.read_text(encoding='utf-8'))
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
            page.wait_for_function('sourceBindingProbe.snapshot().media.some(audio => audio.currentTime > 3)', timeout=25000)
            report['probe'] = page.evaluate('sourceBindingProbe.stop()')
            report['binding'] = page.evaluate('sourceBindingProbe.verify()')
            assert all(audio['paused'] for audio in report['probe']['media'])
            report['status'] = report['binding']['status']
        except Exception as error:
            report['error'] = type(error).__name__
            report['message'] = str(error)[:1000]
        finally:
            try:
                report['stopped'] = page.evaluate('globalThis.sourceBindingProbe?.stop()')
                report['disposed'] = page.evaluate('globalThis.sourceBindingProbe?.dispose()')
            finally:
                context.close()
                browser.close()
                report['contextClosed'] = True
    path = ROOT / 'test-results/source-binding.json'
    path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
