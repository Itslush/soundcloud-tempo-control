import io
import os
import wave
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
TRACK = 'https://soundcloud.com/sewerslvt/bring-me-the-horizon-drown-sewerslvt-remix'
with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1650, 'height': 1100})
    requests = []
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/resolve?*', lambda route: requests.append(route))
    sample = io.BytesIO()
    with wave.open(sample, 'wb') as audio:
        audio.setparams((1, 2, 24000, 24000 * 24, 'NONE', 'not compressed'))
        audio.writeframes(bytes(48000 * 24))
    page.route('**/hero-fixture.wav', lambda route: route.fulfill(body=sample.getvalue(), content_type='audio/wav'))
    metadata = {'title': 'Bring Me The Horizon - Drown (Sewerslvt Remix)', 'artist': 'Sewerslvt / Cynthoni',
                'permalink': TRACK, 'duration': 24, 'stream': BASE + 'hero-fixture.wav', 'format': 'audio', 'preview': False}
    page.goto(BASE, wait_until='networkidle')
    page.evaluate('document.fonts.ready')
    assert requests == []
    assert page.locator('audio').evaluate('(audio) => audio.paused && !audio.currentSrc')
    expect(page.locator('#preview-title')).to_have_text(metadata['title'])
    expect(page.locator('#demo-status')).to_be_empty()
    assert 'Open an image to view' not in page.locator('body').inner_text()
    assert 'Local build:' not in page.locator('body').inner_text()
    initial = page.locator('.hero-copy').bounding_box()
    page.locator('.demo-details').first.locator('summary').click()
    page.locator('#preview-loader summary').click()
    page.evaluate('scrollTo(0, 0)')
    expanded = page.locator('.hero-copy').bounding_box()
    assert abs(initial['y'] - expanded['y']) < 1
    assert abs(initial['height'] - expanded['height']) < 1
    for width in [320, 360, 768, 1024, 1650]:
        page.set_viewport_size({'width': width, 'height': 1100})
        page.evaluate('scrollTo(0, 0)')
        assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), width
        assert page.locator('.space-accent').get_attribute('aria-hidden') == 'true'
        assert page.locator('.space-accent').evaluate('(element) => getComputedStyle(element).pointerEvents') == 'none'
        if width in [360, 1650]:
            page.screenshot(path=str(ROOT/'test-results'/f'hero-expanded-{width}.png'))
    page.set_viewport_size({'width': 1440, 'height': 1100})
    page.locator('#preview-play').click()
    expect(page.locator('#preview-play')).to_be_disabled()
    assert len(requests) == 1
    assert parse_qs(urlparse(requests[0].request.url).query)['url'] == [TRACK]
    page.locator('#preview-reset').click()
    requests.pop().fulfill(json=metadata)
    expect(page.locator('#preview-play')).to_be_enabled()
    page.wait_for_function('document.querySelector("audio").readyState >= 1')
    assert page.locator('audio').evaluate('(audio) => audio.paused')
    page.locator('#preview-play').click()
    page.wait_for_function('document.querySelector("audio").currentTime > 0.2')
    page.locator('#preview-play').click()
    page.locator('#preview-url').fill('https://soundcloud.com/other/track')
    page.locator('#preview-link-form button').click()
    expect(page.locator('#preview-link-form')).to_have_attribute('aria-busy', 'true')
    page.locator('#preview-file').set_input_files({'name': 'local.wav', 'mimeType': 'audio/wav', 'buffer': sample.getvalue()})
    expect(page.locator('#preview-title')).to_have_text('local.wav')
    requests.pop().fulfill(json=metadata)
    expect(page.locator('#preview-link-form')).to_have_attribute('aria-busy', 'false')
    assert page.locator('audio').evaluate('(audio) => audio.paused')
    expect(page.locator('#preview-title')).to_have_text('local.wav')
    manifests = []
    page.route('**/hero-fixture.m3u8', lambda route: manifests.append(route))
    page.evaluate('''() => {
        const canPlayType = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function(type) {
            return type === 'application/vnd.apple.mpegurl' ? 'maybe' : canPlayType.call(this, type);
        };
    }''')
    page.locator('#preview-link-form button').click()
    expect(page.locator('#preview-link-form')).to_have_attribute('aria-busy', 'true')
    with page.expect_request('**/hero-fixture.m3u8'):
        requests.pop().fulfill(json={**metadata, 'format': 'hls', 'stream': BASE + 'hero-fixture.m3u8'})
    page.wait_for_function('document.querySelector("audio").currentSrc.startsWith("blob:")')
    assert page.locator('audio').evaluate('(audio) => audio.paused')
    assert manifests
    page.locator('#preview-file').set_input_files({'name': 'replacement.wav', 'mimeType': 'audio/wav', 'buffer': sample.getvalue()})
    expect(page.locator('#preview-title')).to_have_text('replacement.wav')
    for route in manifests:
        route.abort()
    assert errors == [], errors
    browser.close()
print('Stable expanded hero, responsive star accent, concise copy, click-only default loading, reset cancellation, local-file request replacement and MSE-first HLS loading passed.')
