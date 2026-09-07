import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options

TRACK = 'https://soundcloud.com/nasa/sounds-of-the-sun'


def main():
    compiled = subprocess.run(
        [os.environ.get('NODE', 'node'), '-e',
         "process.stdout.write(require('./tests/module-fixture.cjs')(['audio/dependencies.mjs']))"],
        cwd=ROOT, check=True, capture_output=True, timeout=30,
    ).stdout
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    report = {
        'timestampUtc': stamp,
        'scope': 'Actual bundled decoder module on a signed-out SoundCloud page with jsDelivr blocked; no playback',
        'compiledSha256': hashlib.sha256(compiled).hexdigest(),
        'status': 'INCOMPLETE',
        'blockedRequests': [],
    }
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        report['browser'] = browser.version
        context = browser.new_context()

        def block_cdn(route):
            report['blockedRequests'].append(route.request.url)
            route.abort()

        context.route('https://cdn.jsdelivr.net/**', block_cdn)
        context.add_init_script(compiled.decode('utf-8'))
        page = context.new_page()
        try:
            response = page.goto(TRACK, wait_until='domcontentloaded', timeout=30000)
            report['documentStatus'] = response.status if response else None
            assert report['documentStatus'] == 200
            report['load'] = page.evaluate('''async () => {
                const [first, second] = await Promise.all([loadAudioDependencies(), loadAudioDependencies()]);
                const library = first.Mediabunny;
                const input = new library.Input({
                    source: new library.BufferSource(new Uint8Array(32)), formats: library.HLS_FORMATS
                });
                input.dispose();
                const controller = new AbortController();
                controller.abort(new DOMException('Diagnostic cancellation', 'AbortError'));
                let cancelled = false;
                try { await loadAudioDependencies({signal: controller.signal}); }
                catch (error) { cancelled = error === controller.signal.reason; }
                return {
                    sameLibrary: library === second.Mediabunny,
                    frozen: Object.isFrozen(first) && Object.isFrozen(library),
                    inputConstructed: input instanceof library.Input,
                    packetSink: typeof library.EncodedPacketSink,
                    pathedSource: typeof library.CustomPathedSource,
                    hlsFormats: library.HLS_FORMATS.length,
                    cancelled
                };
            }''')
            loaded = report['load']
            assert all(loaded[key] for key in ['sameLibrary', 'frozen', 'inputConstructed', 'cancelled'])
            assert loaded['packetSink'] == loaded['pathedSource'] == 'function'
            assert loaded['hlsFormats'] > 0
            assert not report['blockedRequests']
            report['status'] = 'PASSED'
        except Exception as error:
            report['error'] = {'name': type(error).__name__, 'message': str(error)[:3000]}
        finally:
            context.close()
            browser.close()
            report['contextClosed'] = True
    output = ROOT / f'test-results/audio-dependencies-local-{stamp}.json'
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'reportPath': str(output), **report}, indent=2))
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
