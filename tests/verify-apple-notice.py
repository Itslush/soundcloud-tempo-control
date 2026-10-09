import base64
import json
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, serve_site, text_contrast

APPLE = 'Mozilla/5.0 ({}) AppleWebKit/605.1.15 (KHTML, like Gecko) {}'
MAC = 'Macintosh; Intel Mac OS X 10_15_7'
CASES = [
    ('iphone-safari', APPLE.format('iPhone; CPU iPhone OS 18_0 like Mac OS X', 'Version/18.0 Mobile/15E148 Safari/604.1'), 5, 'iPhone or iPad'),
    ('iphone-chrome', APPLE.format('iPhone; CPU iPhone OS 18_0 like Mac OS X', 'CriOS/130.0.0.0 Mobile/15E148 Safari/604.1'), 5, 'iPhone or iPad'),
    ('ipad', APPLE.format('iPad; CPU OS 18_0 like Mac OS X', 'Version/18.0 Mobile/15E148 Safari/604.1'), 5, 'iPhone or iPad'),
    ('ipad-desktop', APPLE.format(MAC, 'Version/18.0 Safari/605.1.15'), 5, 'iPhone or iPad'),
    ('mac-safari', APPLE.format(MAC, 'Version/18.0 Safari/605.1.15'), 0, 'in Safari'),
    ('mac-chrome', APPLE.format(MAC, 'Chrome/130.0.0.0 Safari/537.36'), 0, None),
    ('mac-firefox', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0', 0, None),
    ('windows', APPLE.format('Windows NT 10.0; Win64; x64', 'Chrome/130.0.0.0 Safari/537.36'), 10, None),
    ('android', APPLE.format('Linux; Android 14; Pixel 8', 'Chrome/130.0.0.0 Mobile Safari/537.36'), 5, None),
]
profile = {'v': 1, 'track': '/listener/shared-song', 'duration': 24, 'points': [{'t': 0, 'r': .9, 'd': 0, 'c': 'instant'}], 'keyShift': -5}
code = 'SCT1.' + base64.urlsafe_b64encode(json.dumps(profile).encode()).decode().rstrip('=')
server, base = serve_site()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(**browser_options(), headless=True)
        for name, ua, touch, message in CASES:
            context = browser.new_context(user_agent=ua, viewport={'width': 390, 'height': 844})
            context.add_init_script(f'Object.defineProperty(navigator, "maxTouchPoints", {{get:()=>{touch}}});')
            page = context.new_page()
            errors, resolves = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: resolves.append(request.url) if '/api/resolve' in request.url else None)
            for route in ['', 'share/#sct=' + code]:
                page.goto(base + route, wait_until='networkidle')
                notice = page.locator('[data-apple-playback-notice]')
                if message:
                    expect(notice).to_be_visible()
                    expect(notice).to_contain_text(message)
                    assert notice.bounding_box()['y'] < page.locator('#preview-play').bounding_box()['y']
                    for theme in ['light', 'charcoal', 'oled']:
                        page.evaluate('theme=>document.documentElement.dataset.theme=theme', theme)
                        assert text_contrast(notice) >= 4.5
                else:
                    expect(notice).to_be_hidden()
                assert not resolves
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if name == 'iphone-safari':
                page.screenshot(path=str(ROOT / 'test-results/apple-notice-mobile.png'), full_page=True)
            assert not errors, errors
            context.close()
        page = browser.new_page()
        for width in [320, 390, 600, 601, 768, 1440]:
            page.set_viewport_size({'width': width, 'height': 950})
            page.goto(base, wait_until='networkidle')
            header = page.locator('.site-header')
            assert abs(header.bounding_box()['height'] - (97 if width <= 600 else 65)) < 1
            for link in header.locator('a').all():
                box = link.bounding_box()
                assert box['width'] >= 44 and box['height'] >= 44
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if width in [390, 1440]:
                page.screenshot(path=str(ROOT / f'test-results/compact-header-{width}.png'))
        browser.close()
finally:
    server.shutdown()
print('PASS: Apple-only playback notice on both players, iPad desktop identity, non-Apple/Mac non-Safari exclusions, three-theme contrast, no automatic audio requests, compact headers and 44px targets. Device detection is emulated, not real iOS playback.')
