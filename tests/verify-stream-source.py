import base64
import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options

TRACK = 'https://soundcloud.com/nasa/sounds-of-the-sun'


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--decode', action='store_true')
    mode.add_argument('--bounded', action='store_true')
    options = parser.parse_args()
    library = ROOT / 'test-results/decoder-assets/mediabunny-1.55.7/package/dist/bundles/mediabunny.cjs'
    if (options.decode or options.bounded) and hashlib.sha256(library.read_bytes()).hexdigest() != '194c80aaff75b420184c1b82f932863b1318d47bb51fc07754658608707f82fb':
        raise ValueError('Diagnostic decoder checksum mismatch')
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'track': TRACK,
        'scope': 'Isolated signed-out public stream observation; no userscript or account changes',
        'audio': 'Muted browser and observed media elements',
        'status': 'INCONCLUSIVE',
    }
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(path=str(ROOT / 'tests/fixtures/stream-source-probe.js'))
        if options.decode or options.bounded:
            context.add_init_script(library.read_text(encoding='utf-8') + '\n;globalThis.Mediabunny = Mediabunny;')
        if options.decode:
            context.add_init_script(path=str(ROOT / 'tests/fixtures/decode-stream-probe.js'))
        if options.bounded:
            source = (ROOT / 'src/audio/bounded-source.mjs').read_text(encoding='utf-8')
            report['boundedSourceSha256'] = hashlib.sha256(source.encode('utf-8')).hexdigest()
            context.add_init_script('(() => {' + source.replace('export function createPcmSource', 'function createPcmSource') + '\nwindow.createPcmSource=createPcmSource;})();')
            needle = 'const AAC_PREROLL_PACKETS = 4;'
            if source.count(needle) != 1:
                raise ValueError('Preroll negative control requires review')
            control = source.replace(needle, 'const AAC_PREROLL_PACKETS = 0;')
            report['prerollControlSha256'] = hashlib.sha256(control.encode('utf-8')).hexdigest()
            context.add_init_script('(() => {' + control.replace('export function createPcmSource', 'function createPcmSource') + '\nwindow.createPcmSourceWithoutPreroll=createPcmSource;})();')
            context.add_init_script(path=str(ROOT / 'tests/fixtures/bounded-stream-probe.js'))
        page = context.new_page()
        try:
            page.goto(TRACK, wait_until='domcontentloaded', timeout=30000)
            reject = page.get_by_role('button', name=re.compile('^Reject all$', re.I))
            try:
                reject.first.wait_for(state='visible', timeout=8000)
            except Exception:
                if page.locator('.onetrust-pc-dark-filter:visible').count():
                    raise
            if reject.count() and reject.first.is_visible():
                reject.first.click(timeout=3000)
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
            report['playButton'] = button.get_attribute('title')
            if report['playButton'] == 'Play':
                button.click(timeout=5000)
            elif report['playButton'] != 'Pause':
                raise ValueError('Unrecognized playback action')
            page.wait_for_function('window.streamSourceProbe?.snapshot().media.some(audio => audio.currentTime > 2)', timeout=25000)
            report['probe'] = page.evaluate('streamSourceProbe.snapshot()')
            report['playlists'] = page.evaluate('''async () => {
                const urls = [...new Set(performance.getEntriesByType('resource')
                    .map(entry => entry.name).filter(url => /\\.m3u8(?:\\?|$)/.test(url)))].slice(0, 4);
                return await Promise.all(urls.map(async url => {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 5000);
                    try {
                        const response = await fetch(url, {signal: controller.signal});
                        const reader = response.body.getReader();
                        let text = '', bytes = 0;
                        const decoder = new TextDecoder();
                        while (true) {
                            const chunk = await reader.read();
                            if (chunk.done) break;
                            bytes += chunk.value.length;
                            if (bytes > 65536) { await reader.cancel(); throw new Error('Playlist limit'); }
                            text += decoder.decode(chunk.value, {stream: true});
                        }
                        return {host: new URL(url).hostname, status: response.status, bytes,
                            tags: text.split('\\n').filter(line => line.startsWith('#')).map(line =>
                                line.replace(/URI="[^"]+"/g, 'URI="[redacted]"'))};
                    } catch(error) { return {host: new URL(url).hostname, error: error.name}; }
                    finally { clearTimeout(timer); }
                }));
            }''')
            report['artifacts'] = []
            for index, info in enumerate(report['probe']['chunks']):
                data = base64.b64decode(page.evaluate('index => streamSourceProbe.chunk(index)', index), validate=True)
                assert len(data) == info['bytes']
                path = ROOT / f'test-results/stream-source-{index}.bin'
                path.write_bytes(data)
                report['artifacts'].append({'file': path.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            report['status'] = 'OBSERVED' if report['artifacts'] else 'NO_APPEND_CAPTURE'
            if options.decode:
                page.evaluate('streamSourceProbe.stop()')
                report['decoder'] = page.evaluate('decodeStreamProbe()')
                report['status'] = 'DECODED' if report['decoder']['status'] == 'DECODED' and report['decoder']['cleanupPassed'] else 'DECODE_INCOMPLETE'
            if options.bounded:
                page.evaluate('streamSourceProbe.stop()')
                report['bounded'] = page.evaluate('boundedStreamProbe()')
                report['status'] = 'BOUNDED_PASSED' if report['bounded']['status'] == 'PASSED' and report['bounded']['cleanupPassed'] else 'BOUNDED_INCOMPLETE'
        except Exception as error:
            report['error'] = type(error).__name__
            report['message'] = str(error)[:1500]
            report['buttons'] = page.get_by_role('button').evaluate_all('buttons => buttons.slice(0, 35).map(button => ({label: button.getAttribute("aria-label"), text: button.textContent?.slice(0, 100)}))')
            report['frames'] = [frame.url.split('?')[0] for frame in page.frames]
            report['playCandidates'] = page.locator('[title*="Play"], [class*="playButton"]').evaluate_all('elements => elements.slice(0, 10).map(element => element.outerHTML.slice(0, 800))')
            report['overlays'] = page.locator('.auth-modal:visible, #onetrust-consent-sdk').all_inner_texts()
            page.screenshot(path=str(ROOT / 'test-results/stream-source-probe.png'))
        finally:
            try:
                report['stopped'] = page.evaluate('window.streamSourceProbe?.stop()')
                assert not any(not audio['paused'] for audio in (report['stopped'] or {}).get('media', []))
            finally:
                context.close()
                browser.close()
                report['contextClosed'] = True
    report_file = 'bounded-stream-source.json' if options.bounded else 'stream-source.json'
    (ROOT / 'test-results' / report_file).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['status'] in ['OBSERVED', 'DECODED', 'BOUNDED_PASSED'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
