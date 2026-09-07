import hashlib
import json
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright
from userscript_fixture import ROOT, browser_options


def main():
    report = {'timestampUtc': datetime.now(timezone.utc).isoformat(), 'passed': False,
              'scope': 'Real HTMLAudioElement command facade connected to generated PCM and the Natural transport, not SoundCloud UI/queue',
              'sources': {}, 'audio': 'Muted isolated browser and zero-gain destination'}
    modules = [('pcm-window.mjs', 'createPcmWindow'), ('rate-clock.mjs', 'createRateWindow'),
               ('natural-output.mjs', 'createNaturalOutput'), ('transport-lifecycle.mjs', 'createTransportLifecycle'),
               ('buffered-transport.mjs', 'createBufferedTransport'),
               ('media-facade.mjs', 'createMediaFacade')]
    scripts = []
    for filename, factory in modules:
        raw = (ROOT / 'src/audio' / filename).read_bytes()
        source = raw.decode('utf-8')
        report['sources'][filename] = hashlib.sha256(raw).hexdigest()
        if source.count(f'export function {factory}') != 1:
            raise ValueError('Review module adapter')
        source = source.replace(f'export function {factory}', f'function {factory}')
        if filename == 'buffered-transport.mjs':
            for dependency, path in [('createRateWindow', 'rate-clock'), ('createNaturalOutput', 'natural-output'), ('createTransportLifecycle', 'transport-lifecycle')]:
                declaration = f"import {{ {dependency} }} from './{path}.mjs';"
                if source.count(declaration) != 1:
                    raise ValueError('Review dependency adapter')
                source = source.replace(declaration, f'const {{ {dependency} }} = globalThis;')
        scripts.append('(() => {' + source + f'\nglobalThis.{factory}={factory};' + '})();')
    fixture = ROOT / 'tests/fixtures/media-facade-probe.js'
    report['fixtureSha256'] = hashlib.sha256(fixture.read_bytes()).hexdigest()
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True,
                                          args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
        try:
            report['browser'] = browser.version
            page = browser.new_page()
            page.add_init_script('\n'.join(scripts))
            page.goto('about:blank')
            page.add_script_tag(path=str(fixture))
            report.update(page.evaluate('mediaFacadeProbe()'))
        except Exception as error:
            report['error'] = {'name': type(error).__name__, 'message': str(error)[:2000]}
        finally:
            browser.close()
            report['browserClosed'] = True
    (ROOT / 'test-results/media-facade.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
