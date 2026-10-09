import base64
import io
import json
import math
import struct
import wave
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, serve_site


def code(profile):
    return 'SCT1.' + base64.urlsafe_b64encode(json.dumps(profile).encode()).decode().rstrip('=')


profile = {
    'v': 1, 'track': '/listener/shared-song', 'duration': 20,
    'pitch': 'preserve', 'keyShift': -5,
    'points': [{'t': 0, 'r': .75, 'd': 0, 'c': 'instant'},
               {'t': 10, 'r': 1.5, 'd': 4, 'c': 'linear'}],
    'pitchPoints': [{'t': 0, 'k': -5, 'd': 0, 'c': 'instant'},
                    {'t': 12, 'k': 3, 'd': 4, 'c': 'smooth'}],
}
sample = io.BytesIO()
with wave.open(sample, 'wb') as audio:
    audio.setparams((1, 2, 24000, 24000 * 24, 'NONE', 'not compressed'))
    audio.writeframes(b''.join(struct.pack('<h', round(6000 * math.sin(i * 2 * math.pi * 440 / 24000))) for i in range(24000 * 24)))

server, base = serve_site()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
        page = context.new_page()
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('''(() => {
          const connect = AudioNode.prototype.connect;
          window.meters = [];
          AudioNode.prototype.connect = function(target, ...args) {
            if (target instanceof AudioDestinationNode) {
              const meter = this.context.createAnalyser(); meter.fftSize = 32768;
              const mute = this.context.createGain(); mute.gain.value = 0;
              connect.call(this, meter); connect.call(meter, mute); connect.call(mute, target);
              meters.push(meter); return target;
            }
            return connect.call(this, target, ...args);
          };
          window.frequency = () => {
            let peak = -Infinity, frequency = 0;
            for (const meter of meters) {
              const bins = new Float32Array(meter.frequencyBinCount); meter.getFloatFrequencyData(bins);
              for (let i = 1; i < bins.length; i++) if (bins[i] > peak) {
                peak = bins[i]; frequency = i * meter.context.sampleRate / meter.fftSize;
              }
            }
            return frequency;
          };
        })();''')
        response = {'title': 'Shared song', 'artist': 'Listener', 'permalink': 'https://soundcloud.com' + profile['track'],
                    'duration': 24, 'stream': base + 'tone.wav', 'format': 'progressive', 'preview': False}

        def resolve(route):
            requests.append(parse_qs(urlparse(route.request.url).query)['url'][0])
            route.fulfill(json=response)

        page.route('**/api/resolve?*', resolve)
        def audio_range(route):
            data = sample.getvalue()
            requested = route.request.headers.get('range', 'bytes=0-').removeprefix('bytes=')
            start, end = requested.split('-')
            start, end = int(start), int(end) if end else len(data) - 1
            route.fulfill(status=206, body=data[start:end + 1], content_type='audio/wav',
                          headers={'Accept-Ranges': 'bytes', 'Content-Range': f'bytes {start}-{end}/{len(data)}'})
        page.route('**/tone.wav', audio_range)
        page.goto(base + 'share/#sct=' + code(profile))
        page.evaluate('''profile => localStorage.setItem('soundcloud.tempo.timeline.' + encodeURIComponent(profile.track), JSON.stringify({enabled:true,data:{...profile,keyShift:12,points:[{t:0,r:2,d:0,c:'instant'}]}}))''', profile)
        page.reload()
        expect(page.locator('#preview-play')).to_be_visible()
        expect(page.locator('#preview-loader')).to_be_hidden()
        assert requests == [], requests
        assert page.locator('audio').evaluate('el=>el.paused && !el.currentSrc')
        before_storage = page.evaluate('JSON.stringify(localStorage)')
        page.locator('#preview-play').click()
        page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (-5/12)) < 4')
        assert requests == ['https://soundcloud.com' + profile['track']], requests
        assert page.locator('audio').evaluate('el=>el.playbackRate') == .75
        page.locator('#preview-compare').click()
        page.wait_for_function('Math.abs(frequency() - 440) < 4')
        page.locator('#preview-compare').click()
        page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (-5/12)) < 4')
        page.locator('#preview-play').click()
        page.locator('#preview-seek').fill('8')
        page.locator('#preview-seek').dispatch_event('input')
        assert page.locator('audio').evaluate('el=>el.playbackRate') == 1.125, page.locator('audio').evaluate('el=>({rate:el.playbackRate,time:el.currentTime})')
        page.locator('#preview-seek').fill('13')
        page.locator('#preview-seek').dispatch_event('input')
        page.locator('#preview-play').click()
        page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (3/12)) < 4')
        page.locator('#preview-play').click()
        page.locator('#demo-copy').click()
        expect(page.locator('#demo-status')).to_have_text('Tempo link copied.')
        copied = page.evaluate('navigator.clipboard.readText()').split('#sct=SCT1.')[1]
        assert json.loads(base64.urlsafe_b64decode(copied + '=' * (-len(copied) % 4))) == profile
        assert page.evaluate('JSON.stringify(localStorage)') == before_storage
        for width in [320, 390, 768, 1440]:
            page.set_viewport_size({'width': width, 'height': 1000})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
            page.screenshot(path=str(ROOT / f'test-results/shared-player-{width}.png'), full_page=True)

        fixed = {**profile, 'points': [{'t': 0, 'r': .9, 'd': 0, 'c': 'instant'}], 'pitch': 'natural'}
        del fixed['pitchPoints']
        page.goto(base + 'share/#sct=' + code(fixed))
        expect(page.locator('#demo-speed-number')).to_have_value('0.9')
        expect(page.locator('#demo-key-shift')).to_have_value('-5')
        page.locator('#preview-play').click()
        page.wait_for_function('Math.abs(frequency() - 440 * .9 * 2 ** (-5/12)) < 4')
        page.locator('#preview-play').click()
        page.goto(base + 'share/#sct=' + code({**fixed, 'pitch': 'preserve'}))
        expect(page.locator('#demo-pitch').locator('..').locator('.select-value')).to_have_text('Preserve key')
        page.locator('#preview-play').click()
        page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (-5/12)) < 4')
        page.locator('#preview-play').click()
        response['preview'] = True
        page.reload()
        page.locator('#preview-play').click()
        expect(page.locator('#demo-status')).to_contain_text('only returned an excerpt')
        assert page.locator('audio').evaluate('el=>el.paused')
        expect(page.locator('#preview-sample')).to_be_hidden()
        response['preview'] = False
        page.route('**/api/resolve?*', lambda route: route.fulfill(status=503, json={'error': 'Track unavailable. Retry.'}))
        page.reload()
        page.locator('#preview-play').click()
        expect(page.locator('#preview-play')).to_have_text('Retry')
        expect(page.locator('#demo-status')).to_have_text('Track unavailable. Retry.')
        for fragment in ['', '#sct=invalid', '#sct=' + code({**profile, 'track': '//evil.test/path'})]:
            page.goto(base + 'share/' + fragment)
            expect(page.locator('#share-summary')).to_contain_text('missing or invalid')
            expect(page.locator('#share-actions')).to_be_hidden()
            expect(page.locator('audio')).to_have_count(0)
        assert not errors, errors
        browser.close()
finally:
    server.shutdown()
print('PASS: plugin-free shared playback, rendered pitch capture, exact tempo/pitch points and fades, unchanged storage, original comparison, mobile layouts, excerpts and invalid/error states. Fixture audio only.')
