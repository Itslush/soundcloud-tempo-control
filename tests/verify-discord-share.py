import base64
import json

from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, serve_site, text_contrast


profile = {'v': 1, 'track': '/listener/shared-song', 'duration': 20,
           'points': [{'t': 0, 'r': .9, 'd': 0, 'c': 'instant'}],
           'pitch': 'preserve', 'keyShift': -5}
code = 'SCT1.' + base64.urlsafe_b64encode(json.dumps(profile).encode()).decode().rstrip('=')
job = 'a' * 32
link = 'https://tempo.88-96-45-138.sslip.io/soundcloud-tempo-control/listen/' + job
captures = ROOT / '.impeccable/review'
captures.mkdir(parents=True, exist_ok=True)
server, base = serve_site()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(**browser_options(), headless=True)
        page = browser.new_page(permissions=['clipboard-read', 'clipboard-write'])
        errors, posts = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        response = {'state': 'ready', 'id': job, 'url': link}
        response_status = 200

        def handle(route):
            if route.request.method == 'POST':
                posts.append(route.request.post_data_json)
            route.fulfill(status=response_status, json=response)

        page.route('**/api/shares**', handle)
        page.goto(base + 'share/#sct=' + code)
        expect(page.locator('#discord-sharing')).to_be_visible()
        expect(page.locator('.discord-create')).to_be_hidden()
        assert posts == []
        summary = page.locator('#discord-sharing summary')
        summary.focus()
        page.keyboard.press('Enter')
        expect(page.locator('.discord-create')).to_be_visible()
        expect(page.locator('.discord-result')).to_be_hidden()
        page.locator('.discord-create').click()
        expect(page.locator('.discord-link')).to_have_attribute('href', link)
        assert posts[0]['publish'] is True
        sent = json.loads(base64.urlsafe_b64decode(posts[0]['code'][5:] + '==='))
        assert sent == profile
        page.locator('.discord-copy').click()
        expect(page.locator('.discord-status')).to_have_text('Link copied.')
        assert page.evaluate('navigator.clipboard.readText()') == link
        for width, label in [(1440, 'desktop'), (390, 'mobile')]:
            page.set_viewport_size({'width': width, 'height': 1000})
            for theme in ['charcoal', 'light', 'oled']:
                page.evaluate('(theme) => {localStorage.setItem("soundcloud.tempo.siteTheme", theme); document.documentElement.dataset.theme=theme}', theme)
                assert page.evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth')
                assert text_contrast(page.locator('.discord-link')) >= 4.5
                assert page.locator('.discord-copy').bounding_box()['height'] >= 44
                page.evaluate('window.scrollTo(0, 0)')
                page.screenshot(path=str(captures / f'discord-{label}-{theme}.png'), full_page=True, animations='disabled')
        page.reload()
        page.locator('#discord-sharing summary').click()
        response = {'error': 'Another track is rendering. Try again in a few minutes.'}
        response_status = 429
        page.locator('.discord-create').click()
        expect(page.locator('.discord-status')).to_contain_text('Another track')
        expect(page.locator('.discord-create')).to_have_text('Try again')
        response = {'id': job, 'state': 'rendering'}
        response_status = 202
        page.locator('.discord-create').click()
        expect(page.locator('.discord-create')).to_be_disabled()
        expect(page.locator('.discord-status')).to_contain_text('Rendering the shared track')
        response = {'error': 'This link has expired.'}
        response_status = 410
        expect(page.locator('.discord-create')).to_have_text('Try again', timeout=6000)
        response = {'id': job, 'state': 'failed', 'error': 'The audio is unavailable.'}
        response_status = 200
        page.locator('.discord-create').click()
        expect(page.locator('.discord-status')).to_have_text('The audio is unavailable.')
        response = {'id': job, 'state': 'ready', 'url': 'https://evil.example/link'}
        page.locator('.discord-create').click()
        expect(page.locator('.discord-status')).to_have_text('The rendered link is invalid. Try again.')
        expect(page.locator('.discord-result')).to_be_hidden()
        page.goto(base + 'share/#sct=invalid')
        expect(page.locator('#share-actions')).to_be_hidden()
        assert errors == [], errors
        browser.close()
        print('Discord UI: opt-in, canonical settings, copy, 6 theme/viewport captures, busy/poll/expiry/failure/invalid-link states passed.')
finally:
    server.shutdown()
