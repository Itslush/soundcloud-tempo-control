import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options

TRACK = 'https://soundcloud.com/nasa/sounds-of-the-sun'
MODULES = {
    'bounded-source.mjs': 'createPcmSource',
    'pcm-window.mjs': 'createPcmWindow',
    'rate-clock.mjs': 'createRateWindow',
    'natural-output.mjs': 'createNaturalOutput',
    'transport-lifecycle.mjs': 'createTransportLifecycle',
    'buffered-transport.mjs': 'createBufferedTransport',
}


def diagnostic_source(report):
    scripts = []
    report['sourceSha256'] = {}
    report['adaptedSourceSha256'] = {}
    for filename, factory in MODULES.items():
        data = (ROOT / 'src/audio' / filename).read_bytes()
        source = data.decode('utf-8')
        report['sourceSha256'][filename] = hashlib.sha256(data).hexdigest()
        if source.count(f'export function {factory}') != 1:
            raise ValueError(f'Review diagnostic module adapter for {filename}')
        source = source.replace(f'export function {factory}', f'function {factory}')
        if filename == 'buffered-transport.mjs':
            for dependency, path in [('createRateWindow', 'rate-clock'), ('createNaturalOutput', 'natural-output'), ('createTransportLifecycle', 'transport-lifecycle')]:
                declaration = f"import {{ {dependency} }} from './{path}.mjs';"
                if source.count(declaration) != 1:
                    raise ValueError(f'Review diagnostic import adapter for {dependency}')
                source = source.replace(declaration, f'const {{ {dependency} }} = globalThis;')
        adapted = '(() => {' + source + f'\nglobalThis.{factory}={factory};' + '})();'
        report['adaptedSourceSha256'][filename] = hashlib.sha256(adapted.encode('utf-8')).hexdigest()
        scripts.append(adapted)
    fixture = (ROOT / 'tests/fixtures/buffered-transport-probe.js').read_bytes()
    report['probeSha256'] = hashlib.sha256(fixture).hexdigest()
    scripts.append(fixture.decode('utf-8'))
    return '\n'.join(scripts)


def load_public_stream(page):
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
    title = button.get_attribute('title')
    if title == 'Play':
        button.click(timeout=5000)
    elif title != 'Pause':
        raise ValueError('Unrecognized public player action')
    page.wait_for_function('window.streamSourceProbe?.snapshot().media.some(audio => audio.currentTime > 2)', timeout=25000)
    snapshot = page.evaluate('streamSourceProbe.stop()')
    if any(not audio['paused'] for audio in snapshot['media']):
        raise ValueError('Native player remained active before the diagnostic')
    return {'nativePlayerPaused': True, 'mediaCount': len(snapshot['media'])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--local-only', action='store_true')
    options = parser.parse_args()
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Short isolated Natural-mode transport integration and resource checks, not musical-quality, preserved-key, host UI, queue or long-mix validation',
        'audio': 'Muted Chromium plus a zero-gain diagnostic destination; observed native player paused',
        'status': 'INCOMPLETE',
    }
    script = diagnostic_source(report)
    library = ROOT / 'test-results/decoder-assets/mediabunny-1.55.7/package/dist/bundles/mediabunny.cjs'
    if not options.local_only:
        data = library.read_bytes()
        report['decoderSha256'] = hashlib.sha256(data).hexdigest()
        if report['decoderSha256'] != '194c80aaff75b420184c1b82f932863b1318d47bb51fc07754658608707f82fb':
            raise ValueError('Diagnostic decoder checksum mismatch')
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
        report['browser'] = browser.version
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(script)
        page = context.new_page()
        try:
            page.goto('about:blank')
            report['generated'] = page.evaluate('bufferedTransportProbe({live:false})')
            if not options.local_only:
                context.add_init_script(data.decode('utf-8') + '\n;globalThis.Mediabunny = Mediabunny;')
                context.add_init_script(path=str(ROOT / 'tests/fixtures/stream-source-probe.js'))
                try:
                    report['publicStream'] = {'track': TRACK, **load_public_stream(page)}
                    report['live'] = page.evaluate('bufferedTransportProbe({live:true})')
                except Exception as error:
                    report['live'] = {'status': 'INCONCLUSIVE', 'error': type(error).__name__, 'message': str(error)[:1500]}
            local_passed = report['generated']['status'] == 'PASSED'
            live_passed = report.get('live', {}).get('status') == 'PASSED'
            report['status'] = 'LOCAL_PASSED' if options.local_only and local_passed else 'PASSED' if local_passed and live_passed else 'INCOMPLETE'
        except Exception as error:
            report['error'] = type(error).__name__
            report['message'] = str(error)[:2000]
        finally:
            try:
                report['stopped'] = page.evaluate('window.streamSourceProbe?.stop()')
            finally:
                context.close()
                browser.close()
                report['contextClosed'] = True
    filename = 'buffered-transport-local.json' if options.local_only else 'buffered-transport.json'
    output = ROOT / 'test-results' / filename
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({
        'status': report['status'],
        'file': str(output),
        'generated': report.get('generated', {}).get('status'),
        'live': report.get('live', {}).get('status'),
        'errors': [value['error'] for value in [report, report.get('generated', {}), report.get('live', {})] if 'error' in value],
        'message': report.get('message'),
    }, indent=2))
    return 0 if report['status'] in ['PASSED', 'LOCAL_PASSED'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
